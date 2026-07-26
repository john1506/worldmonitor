import { Panel } from './Panel';
import { toApiUrl } from '@/services/runtime';
import { showToast } from '@/utils/toast';
import { h, clearChildren } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';

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

const LAST_SEEN_CURSOR_KEY = 'wm-imagery-watch-last-seen-cursor';
const POLL_INTERVAL_MS = 2 * 60 * 1000; // events endpoint is a cheap Redis LRANGE, fine to poll often
const EARTH_DEG_KM = 111; // rough km-per-degree, fine for area-of-interest bboxes (not survey-grade)

function bboxFromCenter(lat: number, lon: number, radiusKm: number): [number, number, number, number] {
  const dLat = radiusKm / EARTH_DEG_KM;
  const dLon = radiusKm / (EARTH_DEG_KM * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
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

  private async addArea(name: string, center: { lat: number; lon: number }, radiusKm: number): Promise<void> {
    const bbox = bboxFromCenter(center.lat, center.lon, radiusKm);
    try {
      const resp = await fetch(toApiUrl('/api/imagery-watch/v1/areas'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, bbox }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        showToast('Could not add area -- try again in a moment.');
        return;
      }
      showToast(`Now watching "${name}"`);
      this.addFormOpen = false;
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
        onClick: () => { this.addFormOpen = !this.addFormOpen; this.render(); },
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
            this.selectedAreaId = isSelected ? null : area.id;
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
        list.appendChild(this.renderHistoryDetail(history));
      }
    }
    this.content.appendChild(list);
  }

  private renderAddForm(): HTMLElement {
    const center = this.pendingCenter ?? this.getMapCenter?.() ?? null;

    const nameInput = h('input', { type: 'text', className: 'imagery-watch-name-input', placeholder: 'Area name (e.g. Kharkiv)', maxlength: '80' }) as HTMLInputElement;
    const radiusInput = h('input', { type: 'number', className: 'imagery-watch-radius-input', value: '15', min: '1', max: '200' }) as HTMLInputElement;

    return h('div', { className: 'imagery-watch-add-form' },
      nameInput,
      h('div', { className: 'imagery-watch-add-form-row' },
        h('button', {
          className: 'btn btn-secondary',
          onClick: () => {
            this.pendingCenter = this.getMapCenter?.() ?? null;
            this.render();
          },
        }, center ? `Center: ${center.lat.toFixed(2)}, ${center.lon.toFixed(2)}` : 'Use current map view'),
        h('span', {}, 'radius (km)'),
        radiusInput,
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
          void this.addArea(name, useCenter, radiusKm);
        },
      }, 'Start watching'),
    );
  }

  private renderHistoryDetail(history: ImageryScene[]): HTMLElement {
    if (history.length === 0) {
      return h('div', { className: 'imagery-watch-history-empty', style: 'color: var(--text-dim); font-size: 10px; padding: 8px 0;' }, 'No captures recorded yet -- check back after the next scan.');
    }
    return h('div', { className: 'imagery-watch-history' },
      ...history.map((scene) =>
        h('a', {
          className: 'imagery-watch-history-item',
          href: scene.assetUrl || scene.previewUrl,
          target: '_blank',
          rel: 'noopener',
          title: `${scene.satellite} · ${scene.resolutionM}m/px · ${new Date(scene.datetime).toLocaleString()}`,
        },
          scene.previewUrl
            ? h('img', { src: scene.previewUrl, loading: 'lazy', alt: '' })
            : h('div', { className: 'imagery-watch-history-item-empty' }, scene.satellite),
          h('span', { className: 'imagery-watch-history-item-date' }, new Date(scene.datetime).toLocaleDateString()),
        ),
      ),
    );
  }

  public override destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    super.destroy();
  }
}
