import { Panel } from './Panel';
import { toApiUrl } from '@/services/runtime';
import { showToast } from '@/utils/toast';
import { h, clearChildren } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
import { ImageryCogViewer } from './ImageryCogViewer';
import { fetchUcdpEvents } from '@/services/conflict';

interface ImageryArea {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  storeHighRes: boolean;
  notifyHa: boolean;
  createdAt: number;
}

interface ImageryScene {
  id: string;
  source: string;
  satellite: string;
  datetime: string;
  resolutionM: number;
  previewUrl: string;
  assetUrl: string;
}

interface ImageryEvent {
  cursor: number;
  areaId: string;
  areaName: string;
  sceneId: string;
  datetime: string;
  source: string;
}

interface AreaSuggestion {
  name: string;
  lat: number;
  lon: number;
  deaths: number;
}

const LAST_SEEN_CURSOR_KEY = 'wm-imagery-watch-last-seen-cursor';
const POLL_INTERVAL_MS = 2 * 60 * 1000; // events endpoint is a cheap Redis LRANGE, fine to poll often
const EARTH_DEG_KM = 111; // rough km-per-degree, fine for area-of-interest bboxes (not survey-grade)
const SUGGESTION_WINDOW_DAYS = 60;
const SUGGESTION_COUNT = 5;
const SUGGESTION_RADIUS_KM = 50; // country/region-level cluster, wider than the manual-pin default
const REPLAY_INTERVAL_MS = 1500;

function bboxFromCenter(lat: number, lon: number, radiusKm: number): [number, number, number, number] {
  const dLat = radiusKm / EARTH_DEG_KM;
  const dLon = radiusKm / (EARTH_DEG_KM * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

// Accepts whatever people actually paste: "50.4501, 30.5234" (Google Maps'
// own copy-coordinates format), "50.4501 30.5234", or with degree/compass
// markers like "50.4501° N, 30.5234° E".
function parseCoordinates(raw: string): { lat: number; lon: number } | null {
  const match = raw.trim().match(/(-?\d+\.?\d*)\s*°?\s*([NSns])?[,\s]+(-?\d+\.?\d*)\s*°?\s*([EWew])?/);
  if (!match) return null;
  let lat = Number(match[1]);
  let lon = Number(match[3]);
  if (match[2] && /[Ss]/.test(match[2])) lat = -Math.abs(lat);
  if (match[4] && /[Ww]/.test(match[4])) lon = -Math.abs(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

// Real revisit cadence is irregular (Sentinel-2 ~5 days, NAIP much less
// often), so the replay HUD's "time since previous capture" reading is
// itself informative -- a multi-week gap between frames is expected, not
// a bug.
function formatReplayDelta(ms: number): string {
  const totalMinutes = Math.round(Math.abs(ms) / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `+${days}D ${hours}H`;
  if (hours > 0) return `+${hours}H ${minutes}M`;
  return `+${minutes}M`;
}

export class ImageryWatchPanel extends Panel {
  private areas: ImageryArea[] = [];
  private selectedAreaId: string | null = null;
  private historyByArea: Map<string, ImageryScene[]> = new Map();
  private lastSeenCursor: number;
  private unreadCount = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private getMapCenter: (() => { lat: number; lon: number } | null) | null = null;
  private addFormOpen = false;
  private pendingCenter: { lat: number; lon: number } | null = null;
  private pendingName = '';
  private pendingRadiusKm = 15;
  private pendingCoordsText = '';
  private cogViewer = new ImageryCogViewer();
  private suggestions: AreaSuggestion[] = [];
  private suggestionsLoaded = false;
  private replayAreaId: string | null = null;
  private replayIndex = 0;
  private replayPlaying = false;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  // Updated directly by the replay tick instead of going through the full
  // render() -- a full re-render every REPLAY_INTERVAL_MS would rebuild the
  // whole panel (area list, forms, everything) just to swap one image.
  private replayImgEl: HTMLImageElement | null = null;
  private replayScrubberEl: HTMLInputElement | null = null;
  private replayHud: { frame: HTMLElement; source: HTMLElement; captured: HTMLElement; delta: HTMLElement } | null = null;

  constructor() {
    super({ id: 'imagery-watch', title: 'Imagery Watch', infoTooltip: 'Subscribe to an area and get notified when new free satellite imagery (Sentinel-2, and NAIP for US locations) is captured there.' });
    this.lastSeenCursor = Number(localStorage.getItem(LAST_SEEN_CURSOR_KEY)) || 0;
    void this.loadAreas();
    this.startPolling();
  }

  public setGetMapCenterHandler(fn: () => { lat: number; lon: number } | null): void {
    this.getMapCenter = fn;
  }

  private startPolling(): void {
    void this.pollEvents();
    this.pollTimer = setInterval(() => void this.pollEvents(), POLL_INTERVAL_MS);
  }

  private async pollEvents(): Promise<void> {
    try {
      const resp = await fetch(toApiUrl(`/api/imagery-watch/v1/events?since=${this.lastSeenCursor}`), { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return;
      const data = await resp.json() as { events: ImageryEvent[] };
      const events = data.events || [];
      if (events.length === 0) return;

      this.unreadCount += events.length;
      const latestCursor = Math.max(...events.map((e) => e.cursor));
      // Don't mark as "seen" yet -- that only happens when the user actually
      // opens the panel (markAllSeen). Just remember the highest cursor we've
      // been told about so the next poll's `since` doesn't re-fetch these.
      this.highestKnownCursor = Math.max(this.highestKnownCursor, latestCursor);

      const byArea = new Map<string, number>();
      for (const e of events) byArea.set(e.areaName, (byArea.get(e.areaName) || 0) + 1);
      const summary = [...byArea.entries()].map(([name, count]) => `${name} (${count})`).join(', ');
      showToast(`New imagery: ${summary}`);

      this.renderBadge();
      // Invalidate cached history for affected areas so the detail view
      // picks up the new scenes next time it's opened.
      for (const e of events) this.historyByArea.delete(e.areaId);
      if (this.selectedAreaId) void this.loadHistory(this.selectedAreaId);
    } catch {
      // Network hiccup -- next poll cycle will retry, no need to surface an error.
    }
  }

  private highestKnownCursor = 0;

  private markAllSeen(): void {
    this.unreadCount = 0;
    this.lastSeenCursor = this.highestKnownCursor;
    localStorage.setItem(LAST_SEEN_CURSOR_KEY, String(this.lastSeenCursor));
    this.renderBadge();
  }

  private renderBadge(): void {
    const badge = this.content.querySelector('.imagery-watch-unread-badge');
    if (!badge) return;
    if (this.unreadCount > 0) {
      badge.textContent = String(this.unreadCount);
      (badge as HTMLElement).style.display = '';
    } else {
      (badge as HTMLElement).style.display = 'none';
    }
  }

  private async loadAreas(): Promise<void> {
    try {
      const resp = await fetch(toApiUrl('/api/imagery-watch/v1/areas'), { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return;
      const data = await resp.json() as { areas: ImageryArea[] };
      this.areas = data.areas || [];
      this.render();
      for (const area of this.areas) void this.loadHistory(area.id);
    } catch {
      // Leave whatever was last rendered; a manual refresh will retry.
    }
  }

  private async loadSuggestions(): Promise<void> {
    if (this.suggestionsLoaded) return;
    this.suggestionsLoaded = true;
    try {
      const resp = await fetchUcdpEvents();
      if (!resp.success) return;
      const cutoff = Date.now() - SUGGESTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const recent = resp.data.filter((e) => Date.parse(e.date_start) >= cutoff && Number.isFinite(e.latitude) && Number.isFinite(e.longitude));

      // Coarse country-level clustering: sum severity per country, suggest
      // the most recent event's coordinates within that country as the
      // representative center. Simple and cheap -- a real geo-clustering
      // pass would be more precise but isn't needed for "here's roughly
      // where things are active right now" suggestions.
      const byCountry = new Map<string, { deaths: number; latest: typeof recent[number] }>();
      for (const event of recent) {
        const existing = byCountry.get(event.country);
        const deaths = (existing?.deaths ?? 0) + (event.deaths_best || 0);
        const latest = !existing || Date.parse(event.date_start) > Date.parse(existing.latest.date_start) ? event : existing.latest;
        byCountry.set(event.country, { deaths, latest });
      }

      this.suggestions = [...byCountry.entries()]
        .sort((a, b) => b[1].deaths - a[1].deaths)
        .slice(0, SUGGESTION_COUNT)
        .map(([country, { deaths, latest }]) => ({
          name: country,
          lat: latest.latitude,
          lon: latest.longitude,
          deaths,
        }));
      if (this.addFormOpen) this.render();
    } catch {
      // Suggestions are a nice-to-have; silently skip on failure.
    }
  }

  private async loadHistory(areaId: string): Promise<void> {
    try {
      const resp = await fetch(toApiUrl(`/api/imagery-watch/v1/history?areaId=${encodeURIComponent(areaId)}`), { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return;
      const data = await resp.json() as { history: ImageryScene[] };
      this.historyByArea.set(areaId, data.history || []);
      this.render();
    } catch {
      // Leave whatever was last rendered.
    }
  }

  private async addArea(name: string, center: { lat: number; lon: number }, radiusKm: number, notifyHa: boolean, storeHighRes: boolean): Promise<void> {
    const bbox = bboxFromCenter(center.lat, center.lon, radiusKm);
    try {
      const resp = await fetch(toApiUrl('/api/imagery-watch/v1/areas'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, bbox, notifyHa, storeHighRes }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        showToast('Could not add area -- try again in a moment.');
        return;
      }
      showToast(`Now watching "${name}"`);
      this.addFormOpen = false;
      this.pendingName = '';
      this.pendingRadiusKm = 15;
      this.pendingCenter = null;
      this.pendingCoordsText = '';
      await this.loadAreas();
    } catch {
      showToast('Could not add area -- try again in a moment.');
    }
  }

  private async removeArea(id: string): Promise<void> {
    try {
      await fetch(toApiUrl(`/api/imagery-watch/v1/areas?id=${encodeURIComponent(id)}`), { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
      this.historyByArea.delete(id);
      if (this.selectedAreaId === id) this.selectedAreaId = null;
      if (this.replayAreaId === id) this.stopReplay();
      await this.loadAreas();
    } catch {
      showToast('Could not remove area -- try again in a moment.');
    }
  }

  private render(): void {
    clearChildren(this.content);

    const header = h('div', { className: 'imagery-watch-header' },
      h('span', { className: 'imagery-watch-unread-badge', style: { display: this.unreadCount > 0 ? '' : 'none' } }, String(this.unreadCount)),
      h('button', {
        className: 'btn btn-secondary imagery-watch-add-btn',
        onClick: () => {
          this.addFormOpen = !this.addFormOpen;
          if (this.addFormOpen) void this.loadSuggestions();
          this.render();
        },
      }, this.addFormOpen ? 'Cancel' : '+ Add area'),
    );
    this.content.appendChild(header);

    if (this.addFormOpen) {
      this.content.appendChild(this.renderAddForm());
    }

    if (this.areas.length === 0 && !this.addFormOpen) {
      this.content.appendChild(
        h('div', { style: 'color: var(--text-dim); font-size: 11px; margin-top: 12px;' },
          'Not watching any areas yet. Add one to get notified when new satellite imagery lands for it.',
        ),
      );
      return;
    }

    const list = h('div', { className: 'imagery-watch-area-list' });
    for (const area of this.areas) {
      const history = this.historyByArea.get(area.id) || [];
      const latest = history[0];
      const isSelected = this.selectedAreaId === area.id;

      const row = h('div', { className: `imagery-watch-area-row${isSelected ? ' selected' : ''}` },
        h('div', {
          className: 'imagery-watch-area-thumb',
          onClick: () => {
            const nextSelectedId = isSelected ? null : area.id;
            // Selecting a different area (or deselecting entirely) while a
            // replay is running for the *previous* area would otherwise
            // leave that interval ticking in the background against
            // detached DOM elements -- harmless visually, but wasteful.
            if (this.replayAreaId && this.replayAreaId !== nextSelectedId) this.stopReplay();
            this.selectedAreaId = nextSelectedId;
            this.markAllSeen();
            this.render();
          },
        },
          latest?.previewUrl
            ? h('img', { src: latest.previewUrl, loading: 'lazy', alt: `${escapeHtml(area.name)} latest capture` })
            : h('div', { className: 'imagery-watch-area-thumb-empty' }, '...'),
        ),
        h('div', { className: 'imagery-watch-area-meta' },
          h('div', { className: 'imagery-watch-area-name' }, area.name),
          h('div', { className: 'imagery-watch-area-sub', style: 'color: var(--text-dim); font-size: 10px;' },
            latest ? `${history.length} capture${history.length === 1 ? '' : 's'} · latest ${latest.satellite} ${new Date(latest.datetime).toLocaleDateString()}` : 'No captures yet',
          ),
        ),
        h('button', {
          className: 'imagery-watch-area-remove',
          'aria-label': `Remove ${area.name}`,
          onClick: () => void this.removeArea(area.id),
        }, '×'),
      );
      list.appendChild(row);

      if (isSelected) {
        list.appendChild(this.renderAreaDetail(area, history));
      }
    }
    this.content.appendChild(list);
  }

  private renderAddForm(): HTMLElement {
    const center = this.pendingCenter ?? this.getMapCenter?.() ?? null;

    // Backed by pendingName/pendingRadiusKm (not just the input's own DOM
    // value) so a suggestion-chip click or "use current map view" click --
    // both of which re-render this whole form -- don't wipe out whatever
    // the user already typed/picked.
    const nameInput = h('input', {
      type: 'text', className: 'imagery-watch-name-input', placeholder: 'Area name (e.g. Kharkiv)', maxlength: '80',
      value: this.pendingName,
      onInput: (e: Event) => { this.pendingName = (e.target as HTMLInputElement).value; },
    }) as HTMLInputElement;
    const radiusInput = h('input', {
      type: 'number', className: 'imagery-watch-radius-input', min: '1', max: '200',
      value: String(this.pendingRadiusKm),
      onInput: (e: Event) => { this.pendingRadiusKm = Math.max(1, Number((e.target as HTMLInputElement).value) || 15); },
    }) as HTMLInputElement;
    const notifyHaInput = h('input', { type: 'checkbox', id: 'imagery-watch-notify-ha' }) as HTMLInputElement;
    const storeHighResInput = h('input', { type: 'checkbox', id: 'imagery-watch-store-highres' }) as HTMLInputElement;

    const coordsInput = h('input', {
      type: 'text', className: 'imagery-watch-coords-input', placeholder: 'or paste coordinates: 50.45, 30.52',
      value: this.pendingCoordsText,
      onInput: (e: Event) => { this.pendingCoordsText = (e.target as HTMLInputElement).value; },
    }) as HTMLInputElement;
    const applyCoordsText = () => {
      const parsed = parseCoordinates(coordsInput.value);
      if (!parsed) {
        showToast('Could not read those as coordinates -- expected something like "50.45, 30.52".');
        return;
      }
      this.pendingCenter = parsed;
      this.render();
    };

    return h('div', { className: 'imagery-watch-add-form' },
      nameInput,
      ...(this.suggestions.length > 0 ? [
        h('div', { className: 'imagery-watch-suggestions-label' }, 'Suggested (active conflict zones, last 60 days):'),
        h('div', { className: 'imagery-watch-suggestions' },
          ...this.suggestions.map((s) =>
            h('button', {
              className: 'imagery-watch-suggestion-chip',
              onClick: () => {
                this.pendingName = s.name;
                this.pendingRadiusKm = SUGGESTION_RADIUS_KM;
                this.pendingCenter = { lat: s.lat, lon: s.lon };
                this.pendingCoordsText = '';
                this.render();
              },
            }, s.name),
          ),
        ),
      ] : []),
      h('div', { className: 'imagery-watch-add-form-row' },
        h('button', {
          className: 'btn btn-secondary',
          onClick: () => {
            this.pendingCenter = this.getMapCenter?.() ?? null;
            this.pendingCoordsText = '';
            this.render();
          },
        }, center ? `Center: ${center.lat.toFixed(2)}, ${center.lon.toFixed(2)}` : 'Use current map view'),
        h('span', {}, 'radius (km)'),
        radiusInput,
      ),
      h('div', { className: 'imagery-watch-add-form-row' },
        coordsInput,
        h('button', {
          className: 'btn btn-secondary',
          title: 'Read coordinates from your clipboard',
          onClick: async () => {
            try {
              const text = await navigator.clipboard.readText();
              coordsInput.value = text;
              this.pendingCoordsText = text;
              const parsed = parseCoordinates(text);
              if (parsed) {
                this.pendingCenter = parsed;
                this.render();
              } else {
                showToast('Clipboard didn\'t look like coordinates -- pasted it in, adjust and click "Use".');
              }
            } catch {
              showToast('Couldn\'t read the clipboard automatically (browser permissions) -- paste into the field instead.');
            }
          },
        }, '📋 Paste'),
        h('button', { className: 'btn btn-secondary', onClick: applyCoordsText }, 'Use'),
      ),
      h('label', { className: 'imagery-watch-add-form-checkbox' },
        notifyHaInput,
        ' Also notify via Home Assistant (needs the add-on\'s Home Assistant API permission, approved on install/update)',
      ),
      h('label', { className: 'imagery-watch-add-form-checkbox' },
        storeHighResInput,
        ' Keep a local copy of imagery for this area (survives even if it ages out of the free source -- uses disk space)',
      ),
      h('button', {
        className: 'btn btn-primary',
        onClick: () => {
          const name = nameInput.value.trim();
          const radiusKm = Math.max(1, Number(radiusInput.value) || 15);
          const useCenter = this.pendingCenter ?? this.getMapCenter?.();
          if (!name || !useCenter) {
            showToast(!name ? 'Give the area a name.' : 'Pan the map to the area first, then click "Use current map view".');
            return;
          }
          void this.addArea(name, useCenter, radiusKm, notifyHaInput.checked, storeHighResInput.checked);
        },
      }, 'Start watching'),
    );
  }

  private renderAreaDetail(area: ImageryArea, history: ImageryScene[]): HTMLElement {
    const inReplay = this.replayAreaId === area.id;
    const wrapper = h('div', { className: 'imagery-watch-detail' });

    if (history.length > 1) {
      wrapper.appendChild(
        h('div', { className: 'imagery-watch-detail-toolbar' },
          h('button', {
            className: 'btn btn-secondary',
            onClick: () => {
              if (inReplay) {
                this.stopReplay();
              } else {
                this.startReplay(area.id, history.length);
              }
              this.render();
            },
          }, inReplay ? '☰ Grid view' : '▶ Replay'),
        ),
      );
    }

    wrapper.appendChild(inReplay ? this.renderReplay(area, history) : this.renderHistoryGrid(history));
    return wrapper;
  }

  private renderHistoryGrid(history: ImageryScene[]): HTMLElement {
    if (history.length === 0) {
      return h('div', { className: 'imagery-watch-history-empty', style: 'color: var(--text-dim); font-size: 10px; padding: 8px 0;' }, 'No captures recorded yet -- check back after the next scan.');
    }
    return h('div', { className: 'imagery-watch-history' },
      ...history.map((scene) =>
        h('button', {
          className: 'imagery-watch-history-item',
          title: `${scene.satellite} · ${scene.resolutionM}m/px · ${new Date(scene.datetime).toLocaleString()} -- click to open full resolution`,
          onClick: () => {
            if (scene.assetUrl || scene.previewUrl) {
              this.cogViewer.open(scene);
            }
          },
        },
          scene.previewUrl
            ? h('img', { src: scene.previewUrl, loading: 'lazy', alt: '' })
            : h('div', { className: 'imagery-watch-history-item-empty' }, scene.satellite),
          h('span', { className: 'imagery-watch-history-item-date' }, new Date(scene.datetime).toLocaleDateString()),
        ),
      ),
    );
  }

  // Time-lapse-style replay: steps through an area's history oldest-to-newest
  // ("progression of time" is naturally forward, opposite of the grid's
  // newest-first order). Real revisit cadence for these sources is
  // irregular (Sentinel-2 ~5 days, NAIP much less often), so this reads more
  // like a slideshow with visible jumps than a smooth video -- that's the
  // real data, not a bug.
  private startReplay(areaId: string, frameCount: number): void {
    this.replayAreaId = areaId;
    this.replayIndex = 0;
    this.replayPlaying = frameCount > 1;
    if (this.replayPlaying) this.scheduleReplayTick();
  }

  private stopReplay(): void {
    this.replayAreaId = null;
    this.replayPlaying = false;
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
    }
    this.replayImgEl = null;
    this.replayScrubberEl = null;
    this.replayHud = null;
  }

  private scheduleReplayTick(): void {
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.replayTimer = setInterval(() => {
      const chronological = [...(this.historyByArea.get(this.replayAreaId ?? '') ?? [])].reverse();
      if (chronological.length === 0) return;
      this.replayIndex = (this.replayIndex + 1) % chronological.length;
      this.updateReplayFrame(chronological);
    }, REPLAY_INTERVAL_MS);
  }

  private updateReplayFrame(chronological: ImageryScene[]): void {
    const scene = chronological[this.replayIndex];
    if (!scene) return;
    if (this.replayImgEl) {
      if (scene.previewUrl) this.replayImgEl.src = scene.previewUrl;
      this.replayImgEl.alt = scene.satellite;
    }
    if (this.replayScrubberEl) {
      this.replayScrubberEl.value = String(this.replayIndex);
    }
    if (this.replayHud) {
      const previous = chronological[this.replayIndex - 1];
      this.replayHud.frame.textContent = `${this.replayIndex + 1} / ${chronological.length}`;
      this.replayHud.source.textContent = `${scene.satellite.toUpperCase()} · ${scene.resolutionM}M/PX`;
      this.replayHud.captured.textContent = new Date(scene.datetime).toLocaleString();
      this.replayHud.delta.textContent = previous
        ? formatReplayDelta(Date.parse(scene.datetime) - Date.parse(previous.datetime))
        : 'BASELINE (first capture)';
    }
  }

  private renderReplay(area: ImageryArea, history: ImageryScene[]): HTMLElement {
    const chronological = [...history].reverse();
    const first = chronological[0];
    const [west, south, east, north] = area.bbox;
    const centerLat = (south + north) / 2;
    const centerLon = (west + east) / 2;

    const img = h('img', {
      className: 'imagery-watch-replay-img',
      src: first?.previewUrl || '',
      alt: first?.satellite || '',
      onClick: () => {
        const scene = chronological[this.replayIndex];
        if (scene && (scene.assetUrl || scene.previewUrl)) this.cogViewer.open(scene);
      },
    }) as HTMLImageElement;
    this.replayImgEl = img;

    const frameVal = h('span', { className: 'imagery-watch-hud-value' }, `1 / ${chronological.length}`);
    const sourceVal = h('span', { className: 'imagery-watch-hud-value' }, first ? `${first.satellite.toUpperCase()} · ${first.resolutionM}M/PX` : '');
    const capturedVal = h('span', { className: 'imagery-watch-hud-value' }, first ? new Date(first.datetime).toLocaleString() : '');
    const deltaVal = h('span', { className: 'imagery-watch-hud-value imagery-watch-hud-delta' }, 'BASELINE (first capture)');
    this.replayHud = { frame: frameVal, source: sourceVal, captured: capturedVal, delta: deltaVal };

    const hud = h('div', { className: 'imagery-watch-hud' },
      h('div', { className: 'imagery-watch-hud-row' }, h('span', { className: 'imagery-watch-hud-label' }, 'AREA'), h('span', { className: 'imagery-watch-hud-value' }, area.name.toUpperCase())),
      h('div', { className: 'imagery-watch-hud-row' }, h('span', { className: 'imagery-watch-hud-label' }, 'COORDS'), h('span', { className: 'imagery-watch-hud-value' }, `${centerLat.toFixed(4)}, ${centerLon.toFixed(4)}`)),
      h('div', { className: 'imagery-watch-hud-row' }, h('span', { className: 'imagery-watch-hud-label' }, 'SOURCE'), sourceVal),
      h('div', { className: 'imagery-watch-hud-row' }, h('span', { className: 'imagery-watch-hud-label' }, 'CAPTURED'), capturedVal),
      h('div', { className: 'imagery-watch-hud-row' }, h('span', { className: 'imagery-watch-hud-label' }, 'Δ PREV'), deltaVal),
      h('div', { className: 'imagery-watch-hud-row' }, h('span', { className: 'imagery-watch-hud-label' }, 'FRAME'), frameVal),
    );

    const scrubber = h('input', {
      type: 'range', className: 'imagery-watch-replay-scrubber',
      min: '0', max: String(Math.max(0, chronological.length - 1)), value: String(this.replayIndex),
      onInput: (e: Event) => {
        this.replayIndex = Number((e.target as HTMLInputElement).value);
        this.updateReplayFrame(chronological);
      },
    }) as HTMLInputElement;
    this.replayScrubberEl = scrubber;

    const playPauseBtn = h('button', {
      className: 'btn btn-secondary',
      onClick: () => {
        this.replayPlaying = !this.replayPlaying;
        if (this.replayPlaying) {
          this.scheduleReplayTick();
        } else if (this.replayTimer) {
          clearInterval(this.replayTimer);
          this.replayTimer = null;
        }
        playPauseBtn.textContent = this.replayPlaying ? '⏸' : '▶';
      },
    }, this.replayPlaying ? '⏸' : '▶');

    const step = (delta: number) => {
      if (chronological.length === 0) return;
      this.replayIndex = (this.replayIndex + delta + chronological.length) % chronological.length;
      this.updateReplayFrame(chronological);
    };

    // Render at the frame the scrubber/state already points to (e.g.
    // re-opening a replay already in progress, or after a poll refreshed
    // the history array with new captures).
    this.updateReplayFrame(chronological);

    return h('div', { className: 'imagery-watch-replay' },
      img,
      hud,
      h('div', { className: 'imagery-watch-replay-controls' },
        h('button', { className: 'btn btn-secondary', onClick: () => step(-1) }, '◀'),
        playPauseBtn,
        h('button', { className: 'btn btn-secondary', onClick: () => step(1) }, '▶'),
      ),
      scrubber,
    );
  }

  public override destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
    }
    this.cogViewer.close();
    super.destroy();
  }
}
