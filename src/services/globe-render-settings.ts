export type GlobeRenderScale = 'auto' | '1' | '1.5' | '2' | '3';
export type GlobeTexture = 'topographic' | 'blue-marble' | 'nasa-tiled';

const STORAGE_KEY = 'wm-globe-render-scale';
const EVENT_NAME = 'wm-globe-render-scale-changed';

const TEXTURE_STORAGE_KEY = 'wm-globe-texture';
const TEXTURE_EVENT_NAME = 'wm-globe-texture-changed';

export const GLOBE_RENDER_SCALE_OPTIONS: {
  value: GlobeRenderScale;
  labelKey: string;
  fallbackLabel: string;
  disabled?: boolean;
}[] = [
  { value: 'auto', labelKey: 'components.insights.globeRenderScaleOptions.auto', fallbackLabel: 'Auto (device)' },
  { value: '1', labelKey: 'components.insights.globeRenderScaleOptions.1', fallbackLabel: 'Eco (1x)' },
  { value: '1.5', labelKey: 'components.insights.globeRenderScaleOptions.1_5', fallbackLabel: 'Sharp (1.5x)' },
  { value: '2', labelKey: 'components.insights.globeRenderScaleOptions.2', fallbackLabel: '4K (2x)', disabled: true },
  { value: '3', labelKey: 'components.insights.globeRenderScaleOptions.3', fallbackLabel: 'Insane (3x)', disabled: true },
];

const ALLOWED_SCALES = GLOBE_RENDER_SCALE_OPTIONS.filter(o => !o.disabled).map(o => o.value);

export function getGlobeRenderScale(): GlobeRenderScale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && ALLOWED_SCALES.includes(raw as GlobeRenderScale)) return raw as GlobeRenderScale;
  } catch {
    // ignore
  }
  return 'auto';
}

export function setGlobeRenderScale(scale: GlobeRenderScale): void {
  const safeScale = ALLOWED_SCALES.includes(scale) ? scale : 'auto';
  try {
    localStorage.setItem(STORAGE_KEY, safeScale);
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { scale: safeScale } }));
}

export function subscribeGlobeRenderScaleChange(cb: (scale: GlobeRenderScale) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { scale?: GlobeRenderScale } | undefined;
    cb(detail?.scale ?? getGlobeRenderScale());
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

export function resolveGlobePixelRatio(scale: GlobeRenderScale): number {
  const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
  if (scale === 'auto') return Math.min(1.5, Math.max(1, dpr));
  const num = Number(scale);
  if (!Number.isFinite(num) || num <= 0) return 1;
  return Math.min(1.5, Math.max(1, num));
}

export interface GlobePerformanceProfile {
  disablePulseAnimations: boolean;
  disableDashAnimations: boolean;
  disableAtmosphere: boolean;
}

export function resolvePerformanceProfile(scale: GlobeRenderScale): GlobePerformanceProfile {
  const isEco = scale === '1';
  return {
    disablePulseAnimations: isEco,
    disableDashAnimations: isEco,
    disableAtmosphere: isEco,
  };
}

export const GLOBE_TEXTURE_OPTIONS: { value: GlobeTexture; label: string }[] = [
  { value: 'topographic', label: 'Topographic' },
  { value: 'blue-marble', label: 'Blue Marble (NASA)' },
  { value: 'nasa-tiled', label: 'NASA HD Tiles' },
];

// Static, single-image fallback shown immediately (and used at all times
// for the two non-tiled options). For 'nasa-tiled' this is what's visible
// before the first tiles have streamed in, and at the poles, where GIBS'
// Web Mercator tile grid has no coverage above/below roughly +/-85 degrees.
export const GLOBE_TEXTURE_URLS: Record<GlobeTexture, string> = {
  'topographic': '/textures/earth-topo-bathy.jpg',
  'blue-marble': '/textures/earth-blue-marble.jpg',
  'nasa-tiled': '/textures/earth-blue-marble.jpg',
};

// NASA GIBS' Blue Marble Next Generation layer, Web Mercator tile grid,
// capped at its native max zoom (verified: level 8 tiles resolve, e.g.
// https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/8/120/128.jpeg).
// "GoogleMapsCompatible_Level8" names GIBS' tile-matrix-SET (this layer's
// available resolution ceiling); the leading path segment after it is the
// actual requested zoom level, which is a *different* number from 0-8.
export const NASA_GIBS_MAX_LEVEL = 8;

// Routed through this add-on's own imagery-relay.mjs (server-side
// proxy+cache, /api/imagery-watch/v1/nasa-tiles/...) instead of NASA's GIBS
// service directly -- every browser re-fetching the same fixed ~512-tile
// grid straight from NASA on every load isn't a great way to treat a free
// public service, and the server-side cache means it only actually happens
// once per 24h regardless of how many times any client asks.
//
// The build-injected ingress bootstrap (rootfs/build-patches/
// ingress-api-patch.mjs in the addon repo) only patches window.fetch, not
// <img src> assignment (which is how these tile URLs get used, in an
// off-screen Image() for canvas compositing) -- so the ingress prefix has
// to be detected and prepended here too, mirroring that same bootstrap's
// logic. If that build patch's detection regex ever changes, this needs to
// change with it.
//
// Exported (not just used internally for the NASA tile helpers below) so
// other same-origin `/api/...` paths returned by this add-on's own backend
// -- e.g. Imagery Watch's cached-preview route, which is baked into stored
// history data server-side with no ingress-token context available at
// write time -- can get the same treatment at render time. Safe to call on
// an already-absolute URL too (a direct external S3/Azure link): those
// aren't root-relative, so this is a no-op for them.
export function toIngressAwareApiPath(apiPath: string): string {
  if (typeof window === 'undefined' || !apiPath.startsWith('/')) return apiPath;
  const match = window.location.pathname.match(/^(\/api\/hassio_ingress\/[^/]+)\//);
  return match ? match[1] + apiPath : apiPath;
}

export function nasaBlueMarbleTileUrl(x: number, y: number, level: number): string {
  return toIngressAwareApiPath(`/api/imagery-watch/v1/nasa-tiles/blue-marble/${level}/${x}/${y}.jpg`);
}

export function nasaCityLightsTileUrl(x: number, y: number, level: number): string {
  return toIngressAwareApiPath(`/api/imagery-watch/v1/nasa-tiles/city-lights/${level}/${x}/${y}.jpg`);
}

// GIBS' BlueMarble_ShadedRelief layer -- Blue Marble imagery pre-lit against
// real terrain elevation (visible mountain shadows, snow, valleys). Used as
// a relief-shading source, not a base texture: FlatEarthView derives a
// grayscale darkening-only overlay from its luminance (see
// buildReliefShadingTexture) rather than showing this layer's own colors
// directly, so real basemap colors stay intact.
export function nasaShadedReliefTileUrl(x: number, y: number, level: number): string {
  return toIngressAwareApiPath(`/api/imagery-watch/v1/nasa-tiles/shaded-relief/${level}/${x}/${y}.jpg`);
}

export function getGlobeTexture(): GlobeTexture {
  try {
    const raw = localStorage.getItem(TEXTURE_STORAGE_KEY);
    if (raw === 'topographic' || raw === 'blue-marble' || raw === 'nasa-tiled') return raw;
  } catch { /* ignore */ }
  return 'topographic';
}

export function setGlobeTexture(texture: GlobeTexture): void {
  try { localStorage.setItem(TEXTURE_STORAGE_KEY, texture); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(TEXTURE_EVENT_NAME, { detail: { texture } }));
}

export function subscribeGlobeTextureChange(cb: (texture: GlobeTexture) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { texture?: GlobeTexture } | undefined;
    cb(detail?.texture ?? getGlobeTexture());
  };
  window.addEventListener(TEXTURE_EVENT_NAME, handler);
  return () => window.removeEventListener(TEXTURE_EVENT_NAME, handler);
}

// ─── Visual Preset (4 March classic vs 6 March enhanced) ─────────────────────

export type GlobeVisualPreset = 'classic' | 'enhanced';

const PRESET_STORAGE_KEY = 'wm-globe-visual-preset';
const PRESET_EVENT_NAME = 'wm-globe-visual-preset-changed';

export const GLOBE_VISUAL_PRESET_OPTIONS: { value: GlobeVisualPreset; label: string }[] = [
  { value: 'classic', label: 'Earth' },
  { value: 'enhanced', label: 'Cosmos' },
];

export function getGlobeVisualPreset(): GlobeVisualPreset {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY);
    if (raw === 'classic' || raw === 'enhanced') return raw;
  } catch { /* ignore */ }
  return 'classic';
}

export function setGlobeVisualPreset(preset: GlobeVisualPreset): void {
  try { localStorage.setItem(PRESET_STORAGE_KEY, preset); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(PRESET_EVENT_NAME, { detail: { preset } }));
}

export function subscribeGlobeVisualPresetChange(cb: (preset: GlobeVisualPreset) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { preset?: GlobeVisualPreset } | undefined;
    cb(detail?.preset ?? getGlobeVisualPreset());
  };
  window.addEventListener(PRESET_EVENT_NAME, handler);
  return () => window.removeEventListener(PRESET_EVENT_NAME, handler);
}
