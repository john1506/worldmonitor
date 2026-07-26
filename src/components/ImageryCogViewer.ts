import { h } from '@/utils/dom-utils';

// Renders a Cloud-Optimized GeoTIFF scene (Sentinel-2's TCI.tif, NAIP's
// image.tif) at a real resolution beyond the small preview JPEG, without a
// server-side tile renderer: COGs are designed for exactly this -- the
// browser makes plain HTTP range requests against the source URL (S3 for
// Sentinel-2, Azure Blob for NAIP, both confirmed directly fetchable, no
// signing needed) and geotiff.js decodes whichever overview level we ask
// for. This targets a single bounded-resolution render (not a true
// infinite-zoom tile pyramid -- that would mean re-fetching a different
// overview per zoom level, a meaningfully bigger lift) with CSS-transform
// pan/zoom over that one raster. Genuinely sharper than the thumbnail;
// not a full GIS viewer.
//
// Also doubles as the time-lapse replay surface: opened with a whole
// area's history (oldest-to-newest) plus a starting index, it can step
// through captures while staying in the same pan/zoomed high-res view --
// deliberately not a separate lightweight-thumbnail player, so "watch the
// full-resolution progression" and "zoom into one specific capture" are
// the same screen, not two different ones.

const TARGET_MAX_DIMENSION = 2560; // cap the decoded raster's longest side
const MAX_ZOOM = 4;
const MIN_ZOOM = 1;
export const GAP_WARNING_DAYS = 10; // flag unusually long stretches with no capture
const PLAY_PAUSE_MS = 900; // pause between frames once each finishes loading

// Rough, low-confidence "how different does this frame look" signal --
// deliberately NOT a real pixel-diff. Consecutive Sentinel-2/NAIP passes
// often shift the swath/crop slightly, so a naive per-pixel comparison
// would flag plenty of false "change" just from misalignment. Comparing
// coarse average color between two heavily-downsampled previews is far
// more tolerant of that kind of shift, at the cost of only catching
// fairly large shifts in the scene (major cloud cover, snow, flooding,
// burn scars) -- not fine-grained change detection.
const SCENE_DIFF_SAMPLE_PX = 24;
const MAX_RGB_DISTANCE = Math.sqrt(3 * 255 * 255);

export interface CogSceneInfo {
  id: string;
  assetUrl: string;
  previewUrl: string;
  satellite: string;
  datetime: string;
  resolutionM: number;
  geometryGeojson?: string;
}

export interface CogAreaInfo {
  name: string;
  bbox: [number, number, number, number];
}

interface TrackedPoint {
  lat: number;
  lon: number;
}

interface OpenOptions {
  autoPlay?: boolean;
}

// The tracked area's coordinate can land anywhere in the scene's footprint
// -- the search bbox just needs to *intersect* the scene, so the point is
// often nowhere near the image's own center, sometimes in a far corner.
// Rather than a proper CRS reprojection (these COGs are in a projected UTM
// grid, not plain lat/lon -- a precise version would need proj4 as a new
// dependency), this treats the scene's WGS84 footprint polygon (already
// returned by the STAC search, geometryGeojson) as an axis-aligned box and
// linearly interpolates the tracked point within it. Sentinel-2/NAIP
// "visual" products are delivered close to north-up, so the small
// rotation/skew this ignores is a fine tradeoff for "here's roughly where
// your coordinate is in this image", not a precision-measurement tool.
function computeCrosshairPosition(geometryGeojson: string | undefined, tracked: TrackedPoint): { xPct: number; yPct: number } | null {
  if (!geometryGeojson) return null;
  try {
    const geom = JSON.parse(geometryGeojson) as { coordinates?: number[][][] };
    const ring = geom.coordinates?.[0];
    if (!ring || ring.length === 0) return null;
    const lons = ring.map((c) => c[0]).filter((n): n is number => Number.isFinite(n));
    const lats = ring.map((c) => c[1]).filter((n): n is number => Number.isFinite(n));
    if (lons.length === 0 || lats.length === 0) return null;
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    if (maxLon === minLon || maxLat === minLat) return null;

    const xPct = (tracked.lon - minLon) / (maxLon - minLon);
    // Image y increases downward; latitude increases northward/upward -- invert.
    const yPct = 1 - (tracked.lat - minLat) / (maxLat - minLat);
    return { xPct: Math.min(1, Math.max(0, xPct)), yPct: Math.min(1, Math.max(0, yPct)) };
  } catch {
    return null;
  }
}

function formatDelta(ms: number): string {
  const totalMinutes = Math.round(Math.abs(ms) / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `+${days}D ${hours}H`;
  if (hours > 0) return `+${hours}H ${minutes}M`;
  return `+${minutes}M`;
}

async function loadAverageColor(url: string): Promise<[number, number, number] | null> {
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SCENE_DIFF_SAMPLE_PX;
        canvas.height = SCENE_DIFF_SAMPLE_PX;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, SCENE_DIFF_SAMPLE_PX, SCENE_DIFF_SAMPLE_PX);
        const data = ctx.getImageData(0, 0, SCENE_DIFF_SAMPLE_PX, SCENE_DIFF_SAMPLE_PX).data;
        let r = 0, g = 0, b = 0;
        const pixelCount = SCENE_DIFF_SAMPLE_PX * SCENE_DIFF_SAMPLE_PX;
        for (let i = 0; i < data.length; i += 4) { r += data[i] ?? 0; g += data[i + 1] ?? 0; b += data[i + 2] ?? 0; }
        resolve([r / pixelCount, g / pixelCount, b / pixelCount]);
      } catch {
        // Cross-origin image without permissive CORS headers taints the
        // canvas -- getImageData then throws. Degrade silently; this score
        // is a nice-to-have, not worth surfacing an error for.
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function computeSceneDiffPct(prevUrl: string, currUrl: string): Promise<number | null> {
  const [prevColor, currColor] = await Promise.all([loadAverageColor(prevUrl), loadAverageColor(currUrl)]);
  if (!prevColor || !currColor) return null;
  const dr = prevColor[0] - currColor[0];
  const dg = prevColor[1] - currColor[1];
  const db = prevColor[2] - currColor[2];
  const distance = Math.sqrt(dr * dr + dg * dg + db * db);
  return Math.min(100, Math.round((distance / MAX_RGB_DISTANCE) * 100));
}

export class ImageryCogViewer {
  private overlay: HTMLElement | null = null;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private panStartX = 0;
  private panStartY = 0;

  private scenes: CogSceneInfo[] = [];
  private tracked: TrackedPoint | undefined;
  private currentIndex = 0;
  private playing = false;
  private playToken = 0;
  private loadToken = 0;

  private canvasEl: HTMLCanvasElement | null = null;
  private stageEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private scrubberEl: HTMLInputElement | null = null;
  private playPauseBtn: HTMLButtonElement | null = null;
  private hud: { frame: HTMLElement; source: HTMLElement; captured: HTMLElement; delta: HTMLElement; sceneDiff: HTMLElement } | null = null;

  // Before/after compare mode -- deliberately built on the small preview
  // JPEGs rather than two simultaneously-decoded full-res COG rasters.
  // Decoding a second ~2560px COG just to sit under a reveal slider would
  // roughly double the memory/bandwidth cost of an already-heavy view for
  // a feature that's about spotting large-scale change, not pixel-level
  // detail -- the previews are the right tool for that job.
  private compareMode = false;
  private compareIndexA = 0;
  private compareIndexB = 0;
  private compareSplitPct = 50;
  private compareStageEl: HTMLElement | null = null;
  private compareImgA: HTMLImageElement | null = null;
  private compareImgB: HTMLImageElement | null = null;
  private compareHandleEl: HTMLElement | null = null;
  private compareLabelA: HTMLElement | null = null;
  private compareLabelB: HTMLElement | null = null;
  private compareBtn: HTMLButtonElement | null = null;
  private compareControlsEl: HTMLElement | null = null;

  public open(scenes: CogSceneInfo[], startIndex: number, area?: CogAreaInfo, tracked?: TrackedPoint, opts: OpenOptions = {}): void {
    this.close();
    if (scenes.length === 0) return;

    this.scenes = scenes;
    this.tracked = tracked;
    this.currentIndex = Math.min(Math.max(0, startIndex), scenes.length - 1);

    const canvas = h('canvas', { className: 'imagery-cog-canvas' }) as HTMLCanvasElement;
    const stage = h('div', { className: 'imagery-cog-stage' }, canvas);
    const status = h('div', { className: 'imagery-cog-status' }, 'Loading full-resolution image…');

    const imgA = h('img', { className: 'imagery-cog-compare-img', referrerpolicy: 'no-referrer' }) as HTMLImageElement;
    const imgB = h('img', { className: 'imagery-cog-compare-img', referrerpolicy: 'no-referrer' }) as HTMLImageElement;
    const labelA = h('div', { className: 'imagery-cog-compare-label imagery-cog-compare-label-a' }, 'A');
    const labelB = h('div', { className: 'imagery-cog-compare-label imagery-cog-compare-label-b' }, 'B');
    const handle = h('div', { className: 'imagery-cog-compare-handle' });
    const compareStage = h('div', { className: 'imagery-cog-compare-stage', style: { display: 'none' } }, imgA, imgB, labelA, labelB, handle);
    this.compareStageEl = compareStage;
    this.compareImgA = imgA;
    this.compareImgB = imgB;
    this.compareLabelA = labelA;
    this.compareLabelB = labelB;
    this.compareHandleEl = handle;

    const viewport = h('div', { className: 'imagery-cog-viewport' }, stage, status, compareStage);
    this.canvasEl = canvas;
    this.stageEl = stage;
    this.statusEl = status;
    this.setupCompareDrag(compareStage, handle);

    const title = h('div', { className: 'imagery-cog-title' }, '');
    this.titleEl = title;

    const hasMultiple = scenes.length > 1;

    let controls: HTMLElement | null = null;
    let hudEl: HTMLElement | null = null;
    if (hasMultiple) {
      const frameVal = h('span', { className: 'imagery-watch-hud-value' }, '');
      const sourceVal = h('span', { className: 'imagery-watch-hud-value' }, '');
      const capturedVal = h('span', { className: 'imagery-watch-hud-value' }, '');
      const deltaVal = h('span', { className: 'imagery-watch-hud-value imagery-watch-hud-delta' }, '');
      const sceneDiffVal = h('span', { className: 'imagery-watch-hud-value' }, '');
      this.hud = { frame: frameVal, source: sourceVal, captured: capturedVal, delta: deltaVal, sceneDiff: sceneDiffVal };

      const hudRows: Array<[string, HTMLElement]> = [
        ['SOURCE', sourceVal],
        ['CAPTURED', capturedVal],
        ['Δ PREV', deltaVal],
        ['Δ SCENE (approx)', sceneDiffVal],
        ['FRAME', frameVal],
      ];
      if (area) {
        const [west, south, east, north] = area.bbox;
        const centerLat = (south + north) / 2;
        const centerLon = (west + east) / 2;
        hudRows.unshift(['COORDS', h('span', { className: 'imagery-watch-hud-value' }, `${centerLat.toFixed(4)}, ${centerLon.toFixed(4)}`)]);
        hudRows.unshift(['AREA', h('span', { className: 'imagery-watch-hud-value' }, area.name.toUpperCase())]);
      }
      hudEl = h('div', { className: 'imagery-watch-hud imagery-cog-hud' },
        ...hudRows.map(([label, valueEl]) => h('div', { className: 'imagery-watch-hud-row' }, h('span', { className: 'imagery-watch-hud-label' }, label), valueEl)),
      );

      const scrubber = h('input', {
        type: 'range', className: 'imagery-cog-scrubber',
        min: '0', max: String(scenes.length - 1), value: String(this.currentIndex),
        onInput: (e: Event) => {
          if (this.compareMode) this.exitCompare();
          this.pause();
          this.currentIndex = Number((e.target as HTMLInputElement).value);
          void this.renderCurrentFrame();
        },
      }) as HTMLInputElement;
      this.scrubberEl = scrubber;

      const playPauseBtn = h('button', {
        className: 'btn btn-secondary',
        onClick: () => { if (this.playing) this.pause(); else this.play(); },
      }, '▶') as HTMLButtonElement;
      this.playPauseBtn = playPauseBtn;

      const compareBtn = h('button', {
        className: 'btn btn-secondary',
        onClick: () => { if (this.compareMode) this.exitCompare(); else this.enterCompare(); },
      }, '⇄ Compare') as HTMLButtonElement;
      this.compareBtn = compareBtn;

      const compareControls = h('div', { className: 'imagery-cog-compare-controls', style: { display: 'none' } },
        h('div', { className: 'imagery-cog-compare-controls-col' },
          h('span', { className: 'imagery-cog-compare-controls-label' }, 'A'),
          h('button', { className: 'btn btn-secondary', onClick: () => this.stepCompare('A', -1) }, '◀'),
          h('button', { className: 'btn btn-secondary', onClick: () => this.stepCompare('A', 1) }, '▶'),
        ),
        h('div', { className: 'imagery-cog-compare-controls-col' },
          h('span', { className: 'imagery-cog-compare-controls-label' }, 'B'),
          h('button', { className: 'btn btn-secondary', onClick: () => this.stepCompare('B', -1) }, '◀'),
          h('button', { className: 'btn btn-secondary', onClick: () => this.stepCompare('B', 1) }, '▶'),
        ),
      );
      this.compareControlsEl = compareControls;

      controls = h('div', { className: 'imagery-cog-controls' },
        h('div', { className: 'imagery-cog-controls-row' },
          h('button', { className: 'btn btn-secondary', onClick: () => this.step(-1) }, '◀'),
          playPauseBtn,
          h('button', { className: 'btn btn-secondary', onClick: () => this.step(1) }, '▶'),
          compareBtn,
        ),
        scrubber,
        compareControls,
      );
    }

    const overlay = h('div', { className: 'imagery-cog-overlay' },
      h('div', { className: 'imagery-cog-header' },
        title,
        h('button', { className: 'imagery-cog-close', 'aria-label': 'Close', onClick: () => this.close() }, '×'),
      ),
      h('div', { className: 'imagery-cog-body' },
        viewport,
        ...(hudEl ? [hudEl] : []),
      ),
      ...(controls ? [controls] : []),
      h('div', { className: 'imagery-cog-hint' }, hasMultiple ? 'Drag to pan · scroll to zoom · ▶ to play through history · ⇄ to compare two frames' : 'Drag to pan · scroll or pinch to zoom'),
    );

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
    document.addEventListener('keydown', this.handleKeydown);

    document.body.appendChild(overlay);
    this.overlay = overlay;

    this.setupPanZoom(viewport, stage);
    void this.renderCurrentFrame();
    if (opts.autoPlay && hasMultiple) this.play();
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { if (this.compareMode) this.exitCompare(); else this.close(); return; }
    if (e.key === 'ArrowLeft') this.step(-1);
    if (e.key === 'ArrowRight') this.step(1);
    if (e.key === ' ' && this.scenes.length > 1) {
      e.preventDefault();
      if (this.playing) this.pause(); else this.play();
    }
  };

  public close(): void {
    if (!this.overlay) return;
    this.pause();
    document.removeEventListener('keydown', this.handleKeydown);
    this.overlay.remove();
    this.overlay = null;
    this.scenes = [];
    this.tracked = undefined;
    this.canvasEl = null;
    this.stageEl = null;
    this.statusEl = null;
    this.titleEl = null;
    this.scrubberEl = null;
    this.playPauseBtn = null;
    this.hud = null;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.compareMode = false;
    this.compareIndexA = 0;
    this.compareIndexB = 0;
    this.compareSplitPct = 50;
    this.compareStageEl = null;
    this.compareImgA = null;
    this.compareImgB = null;
    this.compareHandleEl = null;
    this.compareLabelA = null;
    this.compareLabelB = null;
    this.compareBtn = null;
    this.compareControlsEl = null;
  }

  private step(delta: number): void {
    if (this.scenes.length === 0) return;
    if (this.compareMode) this.exitCompare();
    this.pause();
    this.currentIndex = (this.currentIndex + delta + this.scenes.length) % this.scenes.length;
    void this.renderCurrentFrame();
  }

  private play(): void {
    if (this.scenes.length <= 1 || this.playing) return;
    if (this.compareMode) this.exitCompare();
    this.playing = true;
    if (this.playPauseBtn) this.playPauseBtn.textContent = '⏸';
    const token = ++this.playToken;
    void this.playLoop(token);
  }

  private pause(): void {
    this.playing = false;
    this.playToken++;
    if (this.playPauseBtn) this.playPauseBtn.textContent = '▶';
  }

  // Chained rather than a fixed setInterval: a full-res COG fetch+decode can
  // easily take longer than a short interval, so advancing strictly on a
  // timer risks overlapping loads and frames landing out of order. Each
  // step waits for the current frame to finish rendering, then pauses
  // briefly, then advances -- checking playToken after every await so a
  // pause()/close() called mid-load stops this loop instead of it
  // clobbering whatever the user navigated to.
  private async playLoop(token: number): Promise<void> {
    while (this.playing && this.playToken === token) {
      await this.renderCurrentFrame();
      if (!this.playing || this.playToken !== token) return;
      await new Promise((resolve) => setTimeout(resolve, PLAY_PAUSE_MS));
      if (!this.playing || this.playToken !== token) return;
      this.currentIndex = (this.currentIndex + 1) % this.scenes.length;
    }
  }

  private setupPanZoom(viewport: HTMLElement, stage: HTMLElement): void {
    const applyTransform = () => {
      stage.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    };

    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * delta));
      applyTransform();
    }, { passive: false });

    viewport.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.panStartX = this.panX;
      this.panStartY = this.panY;
      viewport.classList.add('dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.panX = this.panStartX + (e.clientX - this.dragStartX);
      this.panY = this.panStartY + (e.clientY - this.dragStartY);
      applyTransform();
    });
    window.addEventListener('mouseup', () => {
      this.dragging = false;
      viewport.classList.remove('dragging');
    });
  }

  private updateHud(scene: CogSceneInfo): void {
    if (!this.hud) return;
    const previous = this.scenes[this.currentIndex - 1];
    this.hud.frame.textContent = `${this.currentIndex + 1} / ${this.scenes.length}`;
    this.hud.source.textContent = `${scene.satellite.toUpperCase()} · ${scene.resolutionM}M/PX`;
    this.hud.captured.textContent = new Date(scene.datetime).toLocaleString();
    if (previous) {
      const gapMs = Date.parse(scene.datetime) - Date.parse(previous.datetime);
      const gapDays = Math.abs(gapMs) / 86_400_000;
      this.hud.delta.textContent = formatDelta(gapMs);
      this.hud.delta.classList.toggle('imagery-watch-hud-delta-warning', gapDays > GAP_WARNING_DAYS);
      this.hud.sceneDiff.textContent = '…';
      const loadToken = ++this.loadToken;
      void computeSceneDiffPct(previous.previewUrl, scene.previewUrl).then((pct) => {
        if (this.loadToken !== loadToken || !this.hud) return; // frame changed again before this resolved
        this.hud.sceneDiff.textContent = pct === null ? 'N/A' : `${pct}%`;
      });
    } else {
      this.hud.delta.textContent = 'BASELINE (first capture)';
      this.hud.delta.classList.remove('imagery-watch-hud-delta-warning');
      this.hud.sceneDiff.textContent = 'N/A';
    }
    if (this.scrubberEl) this.scrubberEl.value = String(this.currentIndex);
  }

  private enterCompare(): void {
    if (this.scenes.length < 2) return;
    this.pause();
    this.compareMode = true;
    this.compareIndexA = Math.max(0, this.currentIndex - 1);
    this.compareIndexB = this.currentIndex;
    this.compareSplitPct = 50;
    if (this.compareBtn) this.compareBtn.textContent = '✕ Exit compare';
    if (this.stageEl) this.stageEl.style.display = 'none';
    if (this.scrubberEl) this.scrubberEl.style.display = 'none';
    if (this.compareStageEl) this.compareStageEl.style.display = '';
    if (this.compareControlsEl) this.compareControlsEl.style.display = '';
    this.renderCompareFrame();
  }

  private exitCompare(): void {
    if (!this.compareMode) return;
    this.compareMode = false;
    if (this.compareBtn) this.compareBtn.textContent = '⇄ Compare';
    if (this.stageEl) this.stageEl.style.display = '';
    if (this.scrubberEl) this.scrubberEl.style.display = '';
    if (this.compareStageEl) this.compareStageEl.style.display = 'none';
    if (this.compareControlsEl) this.compareControlsEl.style.display = 'none';
    const current = this.scenes[this.currentIndex];
    if (current) this.updateHud(current);
  }

  private stepCompare(which: 'A' | 'B', delta: number): void {
    const max = this.scenes.length - 1;
    if (which === 'A') this.compareIndexA = Math.min(max, Math.max(0, this.compareIndexA + delta));
    else this.compareIndexB = Math.min(max, Math.max(0, this.compareIndexB + delta));
    this.renderCompareFrame();
  }

  private renderCompareFrame(): void {
    const sceneA = this.scenes[this.compareIndexA];
    const sceneB = this.scenes[this.compareIndexB];
    if (!sceneA || !sceneB || !this.compareImgA || !this.compareImgB) return;
    this.compareImgA.src = sceneA.previewUrl;
    this.compareImgB.src = sceneB.previewUrl;
    if (this.compareLabelA) this.compareLabelA.textContent = `A · ${new Date(sceneA.datetime).toLocaleDateString()}`;
    if (this.compareLabelB) this.compareLabelB.textContent = `B · ${new Date(sceneB.datetime).toLocaleDateString()}`;
    this.applyCompareSplit();
    this.updateCompareHud(sceneA, sceneB);
  }

  private applyCompareSplit(): void {
    if (this.compareImgB) this.compareImgB.style.clipPath = `inset(0 0 0 ${this.compareSplitPct}%)`;
    if (this.compareHandleEl) this.compareHandleEl.style.left = `${this.compareSplitPct}%`;
  }

  private updateCompareHud(sceneA: CogSceneInfo, sceneB: CogSceneInfo): void {
    if (!this.hud) return;
    this.hud.frame.textContent = `A ${this.compareIndexA + 1} vs B ${this.compareIndexB + 1} / ${this.scenes.length}`;
    this.hud.source.textContent = `A: ${sceneA.satellite.toUpperCase()} · B: ${sceneB.satellite.toUpperCase()}`;
    this.hud.captured.textContent = `${new Date(sceneA.datetime).toLocaleDateString()} → ${new Date(sceneB.datetime).toLocaleDateString()}`;
    const gapMs = Date.parse(sceneB.datetime) - Date.parse(sceneA.datetime);
    this.hud.delta.textContent = formatDelta(gapMs);
    this.hud.delta.classList.toggle('imagery-watch-hud-delta-warning', Math.abs(gapMs) / 86_400_000 > GAP_WARNING_DAYS);
    this.hud.sceneDiff.textContent = '…';
    const loadToken = ++this.loadToken;
    void computeSceneDiffPct(sceneA.previewUrl, sceneB.previewUrl).then((pct) => {
      if (this.loadToken !== loadToken || !this.hud) return; // A/B changed again before this resolved
      this.hud.sceneDiff.textContent = pct === null ? 'N/A' : `${pct}%`;
    });
  }

  private setupCompareDrag(stage: HTMLElement, handle: HTMLElement): void {
    let dragging = false;
    const updateFromClientX = (clientX: number) => {
      const rect = stage.getBoundingClientRect();
      if (rect.width === 0) return;
      this.compareSplitPct = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
      this.applyCompareSplit();
    };
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      e.stopPropagation();
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (dragging) updateFromClientX(e.clientX);
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  private addCrosshair(scene: CogSceneInfo): void {
    if (!this.stageEl || !this.tracked) return;
    this.stageEl.querySelector('.imagery-cog-crosshair')?.remove();
    const pos = computeCrosshairPosition(scene.geometryGeojson, this.tracked);
    if (!pos) return;
    this.stageEl.appendChild(
      h('div', {
        className: 'imagery-cog-crosshair',
        style: { left: `${pos.xPct * 100}%`, top: `${pos.yPct * 100}%` },
        title: `Tracked coordinate: ${this.tracked.lat.toFixed(4)}, ${this.tracked.lon.toFixed(4)}`,
      }),
    );
  }

  private async renderCurrentFrame(): Promise<void> {
    const scene = this.scenes[this.currentIndex];
    const canvas = this.canvasEl;
    const stage = this.stageEl;
    const status = this.statusEl;
    if (!scene || !canvas || !stage || !status) return;

    if (this.titleEl) {
      this.titleEl.textContent = `${scene.satellite} · ${scene.resolutionM}m/px · ${new Date(scene.datetime).toLocaleString()}`;
    }
    this.updateHud(scene);
    stage.querySelector('.imagery-cog-crosshair')?.remove();
    status.textContent = 'Loading full-resolution image…';
    status.style.display = '';

    if (!scene.assetUrl) {
      status.textContent = 'No full-resolution asset available for this capture.';
      if (scene.previewUrl) await this.renderPreviewFallback(scene, canvas, status);
      return;
    }
    try {
      const { fromUrl } = await import('geotiff');
      const tiff = await fromUrl(scene.assetUrl);
      const imageCount = await tiff.getImageCount();

      // geotiff.js orders image 0 as full resolution, with successively
      // higher indices being progressively smaller overviews. Walk from the
      // smallest overview up until we find one at or above our target size,
      // so we decode the least data needed for a sharp-enough render rather
      // than always pulling the full multi-thousand-pixel base image.
      let chosen = await tiff.getImage(0);
      for (let i = imageCount - 1; i >= 0; i--) {
        const candidate = await tiff.getImage(i);
        if (Math.max(candidate.getWidth(), candidate.getHeight()) >= TARGET_MAX_DIMENSION) {
          chosen = candidate;
          break;
        }
        if (i === 0) chosen = candidate;
      }

      const scale = Math.min(1, TARGET_MAX_DIMENSION / Math.max(chosen.getWidth(), chosen.getHeight()));
      const outWidth = Math.max(1, Math.round(chosen.getWidth() * scale));
      const outHeight = Math.max(1, Math.round(chosen.getHeight() * scale));

      const raster = await chosen.readRasters({ interleave: true, width: outWidth, height: outHeight }) as unknown as Uint8Array | Uint8ClampedArray;
      const bandCount = Math.floor(raster.length / (outWidth * outHeight));

      canvas.width = outWidth;
      canvas.height = outHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        status.textContent = 'Could not render image (canvas unavailable).';
        return;
      }
      const imageData = ctx.createImageData(outWidth, outHeight);
      for (let px = 0; px < outWidth * outHeight; px++) {
        const srcOffset = px * bandCount;
        const dstOffset = px * 4;
        imageData.data[dstOffset] = raster[srcOffset] ?? 0;
        imageData.data[dstOffset + 1] = raster[srcOffset + (bandCount > 1 ? 1 : 0)] ?? 0;
        imageData.data[dstOffset + 2] = raster[srcOffset + (bandCount > 2 ? 2 : 0)] ?? 0;
        imageData.data[dstOffset + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
      status.style.display = 'none';
      this.addCrosshair(scene);
    } catch (err) {
      console.warn('[ImageryCogViewer] failed to load COG, falling back to preview:', err);
      status.textContent = 'Could not load full-resolution image -- showing preview instead.';
      await this.renderPreviewFallback(scene, canvas, status);
    }
  }

  private renderPreviewFallback(scene: CogSceneInfo, canvas: HTMLCanvasElement, status: HTMLElement): Promise<void> {
    if (!scene.previewUrl) return Promise.resolve();
    return new Promise((resolve) => {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0);
        status.style.display = 'none';
        this.addCrosshair(scene);
        resolve();
      };
      img.onerror = () => { status.textContent = 'Could not load any image for this capture.'; resolve(); };
      img.src = scene.previewUrl;
    });
  }
}
