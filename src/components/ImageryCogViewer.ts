import { h } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';

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

const TARGET_MAX_DIMENSION = 2560; // cap the decoded raster's longest side
const MAX_ZOOM = 4;
const MIN_ZOOM = 1;

interface CogSceneInfo {
  assetUrl: string;
  previewUrl: string;
  satellite: string;
  datetime: string;
  resolutionM: number;
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

  public open(scene: CogSceneInfo): void {
    this.close();

    const canvas = h('canvas', { className: 'imagery-cog-canvas' }) as HTMLCanvasElement;
    const status = h('div', { className: 'imagery-cog-status' }, 'Loading full-resolution image…');
    const viewport = h('div', { className: 'imagery-cog-viewport' }, canvas, status);

    const overlay = h('div', { className: 'imagery-cog-overlay' },
      h('div', { className: 'imagery-cog-header' },
        h('div', { className: 'imagery-cog-title' },
          `${escapeHtml(scene.satellite)} · ${escapeHtml(String(scene.resolutionM))}m/px · ${new Date(scene.datetime).toLocaleString()}`,
        ),
        h('button', { className: 'imagery-cog-close', 'aria-label': 'Close', onClick: () => this.close() }, '×'),
      ),
      viewport,
      h('div', { className: 'imagery-cog-hint' }, 'Drag to pan · scroll or pinch to zoom'),
    );

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
    document.addEventListener('keydown', this.handleKeydown);

    document.body.appendChild(overlay);
    this.overlay = overlay;

    this.setupPanZoom(viewport, canvas);
    void this.loadAndRender(scene, canvas, status);
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close();
  };

  public close(): void {
    if (!this.overlay) return;
    document.removeEventListener('keydown', this.handleKeydown);
    this.overlay.remove();
    this.overlay = null;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  private setupPanZoom(viewport: HTMLElement, canvas: HTMLCanvasElement): void {
    const applyTransform = () => {
      canvas.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
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

  private async loadAndRender(scene: CogSceneInfo, canvas: HTMLCanvasElement, status: HTMLElement): Promise<void> {
    if (!scene.assetUrl) {
      status.textContent = 'No full-resolution asset available for this capture.';
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
      status.remove();
    } catch (err) {
      console.warn('[ImageryCogViewer] failed to load COG, falling back to preview:', err);
      status.textContent = 'Could not load full-resolution image -- showing preview instead.';
      if (scene.previewUrl) {
        const img = new Image();
        img.onload = () => {
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0);
          status.remove();
        };
        img.onerror = () => { status.textContent = 'Could not load any image for this capture.'; };
        img.src = scene.previewUrl;
      }
    }
  }
}
