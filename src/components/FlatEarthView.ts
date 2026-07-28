import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { h, clearChildren } from '@/utils/dom-utils';
import { getCountriesGeoJson, getCountryAtCoordinates, getCountryNameByCode } from '@/services/country-geometry';
import { fetchUcdpEvents } from '@/services/conflict';
import { nasaBlueMarbleTileUrl, nasaCityLightsTileUrl, NASA_GIBS_MAX_LEVEL } from '@/services/globe-render-settings';
import { fetchEarthquakes } from '@/services/earthquakes';
import { fetchGpsInterference } from '@/services/gps-interference';
import type { GpsJamHex } from '@/services/gps-interference';
import { fetchRadiationWatch } from '@/services/radiation';
import type { RadiationObservation } from '@/services/radiation';
import { INTEL_HOTSPOTS, STRATEGIC_WATERWAYS, CONFLICT_ZONES } from '@/config/geo';
import { NUCLEAR_FACILITIES, SPACEPORTS, CRITICAL_MINERALS, ECONOMIC_CENTERS, UNDERSEA_CABLES } from '@/config/geo-map';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { MILITARY_BASES } from '@/config/military-bases';
import { PIPELINES } from '@/config/pipelines';
import { fetchSatelliteTLEs, initSatRecs, propagatePositions, startPropagationLoop } from '@/services/satellites';
import type { SatellitePosition } from '@/services/satellites';

// A just-for-fun "Truman Show" view: a flat disc textured with a REAL
// azimuthal-equidistant reprojection of actual NASA satellite imagery
// (north-pole-centered -- the same legitimate projection behind the UN
// emblem, and the one flat-earth theorists misread as "proof": at that
// projection, Antarctica (near -90deg latitude) doesn't shrink to a point,
// it stretches into a ring around the entire outer edge, because distance
// from the pole maps linearly to radius. That's real, unforced cartographic
// distortion -- this view just also puts a literal wall there, in on the
// joke rather than trying to sell it as anything else), plus live conflict
// event markers reprojected onto the same disc.
//
// Coordinate system note: to avoid any risk of the baked texture and the
// live markers subtly disagreeing about where a given lon/lat actually
// lands (a real risk when deriving world-space marker positions and
// canvas-texture pixel positions from two independently-reasoned formulas),
// both are derived from ONE shared pre-rotation local-space projection
// (projectLonLatLocal), and the disc geometry's UV attribute is explicitly
// overridden from its own real vertex data using that same formula --
// rather than relying on CircleGeometry's implicit default UV convention,
// which would otherwise be a second, easy-to-get-subtly-wrong formula to
// keep in sync by hand.

const DISC_RADIUS = 50;
const WALL_HEIGHT = 3.5; // was 9 -- read as a giant tower rather than a modest ice ridge
const WALL_THICKNESS = 2.2;
const WALL_TAPER = 1.5; // base this much wider than the top -- a sloped profile instead of a sheer vertical cylinder
const TEXTURE_SIZE = 2048;
const NASA_TILE_ZOOM = 4; // 16x16 tiles -- 2x oversampled vs. TEXTURE_SIZE, meaningfully sharper than 1:1
const MERCATOR_MAX_LAT = 85.0511; // Web Mercator/GIBS' standard valid latitude bound
const MARKER_ALTITUDE = 0.4; // slightly above the disc surface, avoids z-fighting
const SUN_DISTANCE = 300;
const MOON_DISTANCE = 150;
const TWILIGHT_BAND_DEG = 6; // matches real civil-twilight convention
const NIGHT_MAX_ALPHA = 0.72; // capped, not fully opaque -- imagery stays faintly visible at night

// Every toggleable layer this view knows about -- static reference-data
// layers (always available, no fetch) plus a handful of live-fetched ones
// (cached + periodically refreshed, see the caching section below).
const ALL_LAYER_KEYS = [
  'conflicts', 'conflictZones', 'hotspots', 'militaryBases', 'nuclear',
  'irradiators', 'spaceports', 'minerals', 'economic', 'waterways',
  'cables', 'pipelines', 'earthquakes', 'gpsJamming', 'radiationWatch',
  'satellites', 'sunMoon', 'dayNight',
] as const;

// `lines` -- not a single `detail` string -- so every layer can surface the
// same breadth of fields the 3D/2D map's own tooltips show (operator,
// status, historical context, etc.) instead of just one summary line.
// Rendered via textContent (see showTooltip), so no HTML escaping needed.
interface MarkerTooltipDatum {
  title: string;
  lines: string[];
}

// Pre-rotation, geometry-local (x, y) in world-scale units -- the single
// source of truth both the canvas texture and the live markers derive from.
function projectLonLatLocal(lon: number, lat: number): { x: number; y: number } {
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const rho = ((Math.PI / 2 - latRad) / Math.PI) * DISC_RADIUS;
  return { x: rho * Math.sin(lonRad), y: rho * Math.cos(lonRad) };
}

// After disc.rotation.x = -PI/2, a local point (x, y, 0) lands at world
// (x, 0, -y) -- see the rotation-about-X matrix (y'=z, wait: with theta=-90deg,
// y' = y*cos(theta) - z*sin(theta) = 0 - 0*(-1) = 0; z' = y*sin(theta) +
// z*cos(theta) = y*(-1) + 0 = -y). Local z is always 0 for a flat circle.
function localToWorld(local: { x: number; y: number }): THREE.Vector3 {
  return new THREE.Vector3(local.x, MARKER_ALTITUDE, -local.y);
}

function cssColor(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

// ─── Astronomy: subsolar point, moon phase, sublunar point ─────────────────
// All of this feeds the sun/moon markers, the day/night shading, and the
// directional light's real direction -- computed once from the actual
// current time when the view opens (not a live-updating simulation).

// NOAA/Spencer-1971-style approximation: solar declination good to a
// fraction of a degree, equation of time good to a few seconds. Widely used
// in day/night-map tools; this is the same standard formula, not something
// invented for this feature.
function getSubsolarPoint(date: Date): { lat: number; lon: number } {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = (date.getTime() - startOfYear) / 86_400_000; // continuous, already includes time-of-day
  const gamma = ((2 * Math.PI) / 365) * dayOfYear;

  const decl = 0.006918
    - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);

  const eqTimeMin = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma)
  );

  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = -15 * (utcHours - 12) - eqTimeMin / 4; // 15deg/hour Earth rotation, 4min/deg
  lon = (((lon + 180) % 360) + 360) % 360 - 180;

  return { lat: (decl * 180) / Math.PI, lon };
}

// Simple, robust synodic-period phase calculation -- this is the part that
// actually needs to be accurate, and this method is: illuminated fraction
// from a known reference new moon divides cleanly regardless of the moon's
// more complex true orbital position.
function getMoonPhaseInfo(date: Date): { phaseFraction: number; illuminatedFraction: number; phaseName: string; waxing: boolean } {
  const synodicMonthDays = 29.530588861;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14, 0);
  const daysSince = (date.getTime() - knownNewMoon) / 86_400_000;
  const phaseFraction = (((daysSince % synodicMonthDays) + synodicMonthDays) % synodicMonthDays) / synodicMonthDays;
  const illuminatedFraction = (1 - Math.cos(phaseFraction * 2 * Math.PI)) / 2;
  const waxing = phaseFraction < 0.5;

  let phaseName: string;
  if (phaseFraction < 0.02 || phaseFraction > 0.98) phaseName = 'New Moon';
  else if (phaseFraction < 0.23) phaseName = 'Waxing Crescent';
  else if (phaseFraction < 0.27) phaseName = 'First Quarter';
  else if (phaseFraction < 0.48) phaseName = 'Waxing Gibbous';
  else if (phaseFraction < 0.52) phaseName = 'Full Moon';
  else if (phaseFraction < 0.73) phaseName = 'Waning Gibbous';
  else if (phaseFraction < 0.77) phaseName = 'Last Quarter';
  else phaseName = 'Waning Crescent';

  return { phaseFraction, illuminatedFraction, phaseName, waxing };
}

function moonPhaseEmoji(phaseName: string): string {
  const map: Record<string, string> = {
    'New Moon': '\u{1F311}', 'Waxing Crescent': '\u{1F312}', 'First Quarter': '\u{1F313}',
    'Waxing Gibbous': '\u{1F314}', 'Full Moon': '\u{1F315}', 'Waning Gibbous': '\u{1F316}',
    'Last Quarter': '\u{1F317}', 'Waning Crescent': '\u{1F318}',
  };
  return map[phaseName] ?? '\u{1F315}';
}

// Sun's ecliptic longitude via the standard simple equation-of-center
// formula (mean anomaly + a two-term correction) -- an independent,
// commonly-used approximation, not derived from the subsolar-point formula
// above; only used here as an intermediate for the moon's position below.
function getSunEclipticLongitudeDeg(date: Date): number {
  const daysSinceJ2000 = (date.getTime() - Date.UTC(2000, 0, 1, 12, 0, 0)) / 86_400_000;
  const M = (((357.5291 + 0.98560028 * daysSinceJ2000) % 360) + 360) % 360;
  const Mr = (M * Math.PI) / 180;
  const eclLon = M + 280.459 + 1.915 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr);
  return ((eclLon % 360) + 360) % 360;
}

// Approximates the subluner point from the sun's position plus the moon's
// phase angle, rather than a full multi-term lunar ephemeris:
//  - Longitude: the moon's subpoint trails the sun's by exactly the phase
//    angle (new moon = same direction as the sun = 0deg trail; full moon =
//    opposite = 180deg trail) -- an exact geometric relationship, not an
//    approximation.
//  - Latitude: derived from the moon's ecliptic longitude (sun's + phase
//    angle) through Earth's obliquity, the same relationship that gives the
//    sun's own seasonal declination swing. This treats the moon's ecliptic
//    latitude as 0, ignoring its actual ~5.14deg orbital inclination (and
//    the 18.6-year precession of that tilt) -- a real simplification, good
//    for placing a marker on a novelty view, not a precise ephemeris.
function getSubLunarPoint(date: Date, subsolarLon: number, phaseFraction: number): { lat: number; lon: number } {
  const phaseAngleDeg = phaseFraction * 360;
  const sunEclLonDeg = getSunEclipticLongitudeDeg(date);
  const moonEclLonDeg = ((sunEclLonDeg + phaseAngleDeg) % 360 + 360) % 360;
  const obliquity = (23.4393 * Math.PI) / 180;
  const moonEclLonRad = (moonEclLonDeg * Math.PI) / 180;
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(moonEclLonRad));

  let lon = subsolarLon - phaseAngleDeg;
  lon = (((lon + 180) % 360) + 360) % 360 - 180;

  return { lat: (dec * 180) / Math.PI, lon };
}

// Positions an object "in the sky" above the point on the disc where
// (lat,lon) is directly overhead -- same radial/angular relationship as
// everything else on the disc, just scaled out to `distance` and lifted
// well above the surface, rather than sitting on it like a ground marker.
function skyPosition(lat: number, lon: number, distance: number): THREE.Vector3 {
  const local = projectLonLatLocal(lon, lat);
  const horizontalScale = distance / DISC_RADIUS;
  return new THREE.Vector3(local.x * horizontalScale, distance * 0.8, -local.y * horizontalScale);
}

// Unlike the sun/moon (positioned by direction only, at a fixed decorative
// distance), satellites keep their real horizontal ground-track position
// (directly above the matching point on the disc, like any other marker)
// and are just elevated by altitude -- so their movement actually tracks
// the map underneath as they pass over. Real altitudes span ~400km (ISS-
// class LEO) to ~36,000km (GEO); mapped into a modest, clamped scene-height
// range rather than to true scale (which would be absurd against a
// DISC_RADIUS=50 flat disc regardless).
function satellitePosition(lat: number, lon: number, altKm: number): THREE.Vector3 {
  const local = projectLonLatLocal(lon, lat);
  const height = Math.min(120, 20 + altKm / 400);
  return new THREE.Vector3(local.x, height, -local.y);
}

// Same country->color mapping GlobeMap.ts's own satellite layer uses, so a
// given satellite reads as the same color in both views.
const SAT_COUNTRY_COLORS: Record<string, number> = {
  CN: 0xff2020, RU: 0xff8800, US: 0x4488ff, EU: 0x44cc44,
  KR: 0xaa66ff, IN: 0xff66aa, TR: 0xff4466, OTHER: 0xccccff,
};

// Same lookup tables GlobeMap.ts's own satellite tooltip uses, so the two
// views agree on operator name/type label wording, not just marker color.
const SAT_OPERATOR_NAME: Record<string, string> = {
  CN: 'China', RU: 'Russia', US: 'United States', EU: 'ESA / EU',
  KR: 'South Korea', IN: 'India', TR: 'Turkey', OTHER: 'Other',
};
const SAT_TYPE_LABEL: Record<string, string> = {
  sar: 'SAR Imaging', optical: 'Optical Imaging', military: 'Military', sigint: 'SIGINT',
};

const SAT_BEAM_RAY_COUNT = 6;
const SAT_BEAM_GROUND_SPREAD = 2.5; // local-space units (DISC_RADIUS=50) -- footprint circle radius

// The "shroud": a translucent visibility cone (ray outline + filled
// triangle-fan mesh) flaring from each satellite's real elevated position
// down to a small footprint circle on the ground directly beneath it --
// same technique as GlobeMap.ts's rebuildSatBeams, adapted from sphere-
// surface geometry to this view's flat local (x,y) plane. Rebuilt wholesale
// on every propagation tick (like GlobeMap does) rather than updated in
// place -- BufferGeometry doesn't lend itself to per-satellite incremental
// updates, and satellite counts here are small enough (tens, not thousands)
// for a full rebuild every 2s to be cheap.
function buildSatelliteBeams(positions: SatellitePosition[]): THREE.Group {
  const group = new THREE.Group();
  const tmpColor = new THREE.Color();
  const rayPositions: number[] = [];
  const rayColors: number[] = [];
  const conePositions: number[] = [];
  const coneColors: number[] = [];

  for (const pos of positions) {
    if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) continue;
    const local = projectLonLatLocal(pos.lng, pos.lat);
    const beamTop = satellitePosition(pos.lat, pos.lng, pos.alt);
    const hex = SAT_COUNTRY_COLORS[pos.country] ?? 0xccccff;
    tmpColor.setHex(hex);
    const r = tmpColor.r, g = tmpColor.g, b = tmpColor.b;

    const groundPts: THREE.Vector3[] = [];
    for (let i = 0; i < SAT_BEAM_RAY_COUNT; i++) {
      const angle = (i / SAT_BEAM_RAY_COUNT) * Math.PI * 2;
      const gp = new THREE.Vector3(
        local.x + Math.cos(angle) * SAT_BEAM_GROUND_SPREAD,
        0.05,
        -local.y + Math.sin(angle) * SAT_BEAM_GROUND_SPREAD,
      );
      groundPts.push(gp);
      rayPositions.push(beamTop.x, beamTop.y, beamTop.z, gp.x, gp.y, gp.z);
      rayColors.push(r, g, b, r * 0.3, g * 0.3, b * 0.3);
    }
    for (let i = 0; i < SAT_BEAM_RAY_COUNT; i++) {
      const next = (i + 1) % SAT_BEAM_RAY_COUNT;
      const gi = groundPts[i]!;
      const gn = groundPts[next]!;
      conePositions.push(
        beamTop.x, beamTop.y, beamTop.z,
        gi.x, gi.y, gi.z,
        gn.x, gn.y, gn.z,
      );
      coneColors.push(r, g, b, r * 0.2, g * 0.2, b * 0.2, r * 0.2, g * 0.2, b * 0.2);
    }
  }

  if (rayPositions.length > 0) {
    const rayGeo = new THREE.BufferGeometry();
    rayGeo.setAttribute('position', new THREE.Float32BufferAttribute(rayPositions, 3));
    rayGeo.setAttribute('color', new THREE.Float32BufferAttribute(rayColors, 3));
    const rayMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false });
    group.add(new THREE.LineSegments(rayGeo, rayMat));
  }
  if (conePositions.length > 0) {
    const coneGeo = new THREE.BufferGeometry();
    coneGeo.setAttribute('position', new THREE.Float32BufferAttribute(conePositions, 3));
    coneGeo.setAttribute('color', new THREE.Float32BufferAttribute(coneColors, 3));
    const coneMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false });
    group.add(new THREE.Mesh(coneGeo, coneMat));
  }
  return group;
}

function disposeBeamGroup(group: THREE.Group): void {
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.LineSegments)) return;
    child.geometry.dispose();
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) mat.dispose();
  });
}

// A grayscale vertical gradient for the wall's alphaMap (three.js reads
// alphaMap as grayscale luminance, not the canvas's own alpha channel --
// white = opaque, black = transparent), so the wall fades away into the fog
// near its top edge instead of ending in a hard cylindrical rim.
// CylinderGeometry's V=0 is its bottom, V=1 its top; with the texture's
// default flipY, canvas row 0 (top of the image) maps to v=1 (wall top).
function buildWallFadeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#000000'); // canvas top -> wall top -> transparent
    gradient.addColorStop(0.55, '#666666');
    gradient.addColorStop(1, '#ffffff'); // canvas bottom -> wall bottom -> opaque
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return new THREE.CanvasTexture(canvas);
}

async function fetchAssembledMercatorCanvas(
  zoom: number,
  tileUrlFn: (x: number, y: number, level: number) => string = nasaBlueMarbleTileUrl,
): Promise<HTMLCanvasElement> {
  const tilesPerSide = 2 ** zoom;
  const tileSize = 256;
  const canvas = document.createElement('canvas');
  canvas.width = tilesPerSide * tileSize;
  canvas.height = tilesPerSide * tileSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const loads: Promise<void>[] = [];
  for (let tx = 0; tx < tilesPerSide; tx++) {
    for (let ty = 0; ty < tilesPerSide; ty++) {
      const url = tileUrlFn(tx, ty, zoom);
      loads.push(new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.referrerPolicy = 'no-referrer';
        img.onload = () => { ctx.drawImage(img, tx * tileSize, ty * tileSize); resolve(); };
        // A missing/failed tile just leaves that patch blank rather than
        // failing the whole reprojection -- most of GIBS' grid resolves fine.
        img.onerror = () => resolve();
        img.src = url;
      }));
    }
  }
  await Promise.all(loads);
  return canvas;
}

// In-memory (module-level) cache of the raw assembled Mercator canvases
// BEFORE reprojection, reused across open/close cycles within the same page
// load. Deliberately not caching the final built disc texture itself: the
// day/night shading and sun/moon positions need to reflect whatever time it
// actually is on each open, so those still get recomputed fresh every time,
// just reusing this same underlying imagery.
const tileImageryCache: { zoom: number | null; blueMarble: HTMLCanvasElement | null; cityLights: HTMLCanvasElement | null } = {
  zoom: null, blueMarble: null, cityLights: null,
};

// Persisted to IndexedDB (survives a full page reload / new tab, unlike the
// in-memory cache above) -- these are multi-megabyte images, well past what
// localStorage/sessionStorage's much smaller quota can reasonably hold, so
// IndexedDB is the right tool here. 24h TTL: Earth's daytime appearance
// doesn't meaningfully change day to day for a just-for-fun view like this.
const TILE_IMAGERY_DB_NAME = 'wm-flat-earth-tiles';
const TILE_IMAGERY_STORE = 'canvases';
const TILE_IMAGERY_PERSIST_TTL_MS = 24 * 60 * 60 * 1000;

function openTileImageryDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) { resolve(null); return; }
    try {
      const req = indexedDB.open(TILE_IMAGERY_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(TILE_IMAGERY_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function loadPersistedCanvas(key: string): Promise<HTMLCanvasElement | null> {
  try {
    const db = await openTileImageryDb();
    if (!db) return null;
    const entry = await new Promise<{ blob: Blob; savedAt: number } | undefined>((resolve) => {
      const tx = db.transaction(TILE_IMAGERY_STORE, 'readonly');
      const req = tx.objectStore(TILE_IMAGERY_STORE).get(key);
      req.onsuccess = () => resolve(req.result as { blob: Blob; savedAt: number } | undefined);
      req.onerror = () => resolve(undefined);
    });
    db.close();
    if (!entry || Date.now() - entry.savedAt > TILE_IMAGERY_PERSIST_TTL_MS) return null;
    const bitmap = await createImageBitmap(entry.blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

async function savePersistedCanvas(key: string, canvas: HTMLCanvasElement): Promise<void> {
  try {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
    if (!blob) return;
    const db = await openTileImageryDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(TILE_IMAGERY_STORE, 'readwrite');
      tx.objectStore(TILE_IMAGERY_STORE).put({ blob, savedAt: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // Best-effort -- a failed save just means the next open re-fetches.
  }
}

async function getCachedTileImagery(zoom: number): Promise<{ blueMarble: HTMLCanvasElement | null; cityLights: HTMLCanvasElement | null }> {
  if (tileImageryCache.zoom === zoom && (tileImageryCache.blueMarble || tileImageryCache.cityLights)) {
    return { blueMarble: tileImageryCache.blueMarble, cityLights: tileImageryCache.cityLights };
  }

  const [persistedBlueMarble, persistedCityLights] = await Promise.all([
    loadPersistedCanvas(`blueMarble-z${zoom}`),
    loadPersistedCanvas(`cityLights-z${zoom}`),
  ]);
  if (persistedBlueMarble || persistedCityLights) {
    tileImageryCache.zoom = zoom;
    tileImageryCache.blueMarble = persistedBlueMarble;
    tileImageryCache.cityLights = persistedCityLights;
    return { blueMarble: persistedBlueMarble, cityLights: persistedCityLights };
  }

  const [blueMarble, cityLights] = await Promise.all([
    fetchAssembledMercatorCanvas(zoom, nasaBlueMarbleTileUrl).catch((err) => {
      console.warn('[FlatEarthView] failed to load NASA Blue Marble tiles', err);
      return null;
    }),
    fetchAssembledMercatorCanvas(zoom, nasaCityLightsTileUrl).catch((err) => {
      console.warn('[FlatEarthView] failed to load NASA city-lights tiles', err);
      return null;
    }),
  ]);
  tileImageryCache.zoom = zoom;
  tileImageryCache.blueMarble = blueMarble;
  tileImageryCache.cityLights = cityLights;
  if (blueMarble) void savePersistedCanvas(`blueMarble-z${zoom}`, blueMarble);
  if (cityLights) void savePersistedCanvas(`cityLights-z${zoom}`, cityLights);
  return { blueMarble, cityLights };
}

// Shared by every place that needs a single pixel out of an assembled Web
// Mercator canvas, given a lon/lat in radians -- both the main reprojection
// below and the day/night overlay's city-lights/ocean sampling use this
// exact same formula, so they can't drift out of sync with each other.
function sampleMercatorPixel(srcData: ImageData, lonRad: number, latRad: number): [number, number, number] {
  const sw = srcData.width;
  const sh = srcData.height;
  const mercX = ((lonRad + Math.PI) / (2 * Math.PI)) * sw;
  const mercY = (0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI)) * sh;
  const sx = Math.max(0, Math.min(sw - 1, Math.round(mercX)));
  const sy = Math.max(0, Math.min(sh - 1, Math.round(mercY)));
  const idx = (sy * sw + sx) * 4;
  return [srcData.data[idx] ?? 0, srcData.data[idx + 1] ?? 0, srcData.data[idx + 2] ?? 0];
}

// Nearest-neighbor reprojection from the assembled Web Mercator canvas into
// azimuthal-equidistant space. Latitudes beyond Mercator's valid range (no
// GIBS coverage there) get a flat icy fill instead -- which conveniently
// lands exactly at the disc's center (the unmapped area right at the north
// pole) and in a band just inside the outer rim (unmapped near the south
// pole), blending straight into the literal ice wall already sitting there.
function reprojectMercatorToAzimuthal(source: HTMLCanvasElement, outSize: number): ImageData {
  const srcCtx = source.getContext('2d');
  const out = new ImageData(outSize, outSize);
  if (!srcCtx) return out;
  const srcData = srcCtx.getImageData(0, 0, source.width, source.height);
  const center = outSize / 2;
  const maxLatRad = (MERCATOR_MAX_LAT * Math.PI) / 180;

  for (let oy = 0; oy < outSize; oy++) {
    for (let ox = 0; ox < outSize; ox++) {
      const dx = ox - center;
      const dy = oy - center;
      const rho = Math.sqrt(dx * dx + dy * dy);
      const outIdx = (oy * outSize + ox) * 4;
      if (rho > center) continue; // outside the disc -- never sampled by the mesh anyway

      // Must be the exact inverse of projectLonLatLocal/toCanvas's forward
      // mapping (dx = rho*sin(lonRad), dy = rho*cos(lonRad)) -- an earlier
      // version had a stray negation here (atan2(dx, -dy)) that silently
      // reflected the sampled longitude (recovers PI-lonRad instead of
      // lonRad), which is what produced real, recognizable imagery that was
      // nonetheless mirrored relative to the correctly-projected border
      // outlines and markers drawn on top of it.
      const lonRad = Math.atan2(dx, dy);
      const latRad = Math.PI / 2 - (rho / center) * Math.PI;

      if (latRad > maxLatRad || latRad < -maxLatRad) {
        out.data[outIdx] = 232; out.data[outIdx + 1] = 242; out.data[outIdx + 2] = 248; out.data[outIdx + 3] = 255;
        continue;
      }

      const [r, g, b] = sampleMercatorPixel(srcData, lonRad, latRad);
      out.data[outIdx] = r;
      out.data[outIdx + 1] = g;
      out.data[outIdx + 2] = b;
      out.data[outIdx + 3] = 255;
    }
  }
  return out;
}

// ─── Live-layer caching ─────────────────────────────────────────────────────
// Persists each live-fetched layer's data in sessionStorage (survives a page
// reload within the tab, not just an open/close of the view) so reopening
// the view -- or a periodic background refresh -- doesn't force a visible
// re-fetch delay. A refresh only overwrites the cache if it actually
// succeeds; a failed fetch just leaves the previous good data (and its
// timestamp) in place rather than blanking the layer out.
const LIVE_LAYER_CACHE_PREFIX = 'wm-flat-earth-cache-';
const LIVE_LAYER_CACHE_TTL_MS = 10 * 60 * 1000;
const LIVE_LAYER_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface CachedLayerEntry<T> {
  data: T[];
  fetchedAt: number;
}

function loadCachedLayer<T>(key: string): CachedLayerEntry<T> | null {
  try {
    const raw = sessionStorage.getItem(LIVE_LAYER_CACHE_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedLayerEntry<T>;
  } catch {
    return null;
  }
}

function saveCachedLayer<T>(key: string, data: T[]): void {
  try {
    sessionStorage.setItem(LIVE_LAYER_CACHE_PREFIX + key, JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch {
    // Storage full/unavailable -- the in-memory render from this fetch still
    // works for the current session, just won't persist across a reload.
  }
}

export class FlatEarthView {
  private overlay: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private labelRenderer: CSS2DRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private animationFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private tooltipEl: HTMLElement | null = null;
  private sunMoonGroup: THREE.Group | null = null;
  private dayNightMesh: THREE.Mesh | null = null;
  // Every toggleable layer's Object3D, keyed the same as `layers` below --
  // lets setLayerEnabled() stay a one-line generic toggle instead of a long
  // if-chain as more layers get added.
  private layerObjects: Record<string, THREE.Object3D> = {};
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private satelliteStopFn: (() => void) | null = null;
  private layers: Record<string, boolean> = Object.fromEntries(
    ALL_LAYER_KEYS.map((key) => [key, localStorage.getItem(`wm-flat-earth-layer-${key}`) !== '0']),
  );

  public async open(): Promise<void> {
    if (this.overlay) return;

    // Computed once from the real current time when the view opens -- not a
    // live-updating simulation while the view stays open (matches the
    // imagery/markers, which are also a snapshot taken at open time).
    const now = new Date();
    const subsolar = getSubsolarPoint(now);
    const moonPhase = getMoonPhaseInfo(now);
    const sublunar = getSubLunarPoint(now, subsolar.lon, moonPhase.phaseFraction);

    const viewport = h('div', { className: 'flat-earth-viewport' });
    const status = h('div', { className: 'flat-earth-status' }, 'Loading NASA imagery and live conflict data...');
    const tooltip = h('div', { className: 'flat-earth-tooltip', style: { display: 'none' } });
    const layersPanel = this.buildLayersPanel();
    const moonInfo = h('div', { className: 'flat-earth-moon-info' },
      `${moonPhaseEmoji(moonPhase.phaseName)} ${moonPhase.phaseName} · ${Math.round(moonPhase.illuminatedFraction * 100)}% illuminated`,
    );
    const overlay = h('div', { className: 'flat-earth-overlay' },
      h('div', { className: 'flat-earth-header' },
        h('div', { className: 'flat-earth-title' }, '\u{1F9CA} Flat Earth View'),
        h('button', { className: 'flat-earth-close', 'aria-label': 'Close', onClick: () => this.close() }, '×'),
      ),
      h('div', { className: 'flat-earth-viewport-wrap' }, viewport, layersPanel, moonInfo, status, tooltip),
      h('div', { className: 'flat-earth-hint' }, 'Drag to look around · scroll to zoom · click a marker for details · purely for fun, not a serious model of the Earth'),
    );
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });
    document.addEventListener('keydown', this.handleKeydown);
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.tooltipEl = tooltip;

    try {
      await this.initScene(viewport, subsolar, sublunar, moonPhase);
      status.remove();
    } catch (err) {
      console.warn('[FlatEarthView] failed to initialize', err);
      status.textContent = 'Could not start the 3D view (WebGL unavailable?).';
    }
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close();
  };

  public close(): void {
    if (!this.overlay) return;
    document.removeEventListener('keydown', this.handleKeydown);
    if (this.animationFrame != null) cancelAnimationFrame(this.animationFrame);
    if (this.refreshTimer != null) clearInterval(this.refreshTimer);
    this.satelliteStopFn?.();
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.scene?.traverse((obj) => {
      // Mesh covers most of the scene; LineSegments (the satellite beam
      // rays) is a THREE.Line subtype, not a Mesh, but has the same
      // geometry/material shape and needs the same disposal.
      if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.LineSegments)) return;
      obj.geometry.dispose();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        // Generic check (not just MeshStandardMaterial) -- the day/night
        // overlay and sun/moon markers use MeshBasicMaterial, which also
        // has a `.map` that needs its own explicit disposal (Material.dispose()
        // doesn't cascade to textures, since a texture can be shared). The
        // wall's alphaMap (its fade-to-transparent gradient) needs the same.
        if ('map' in mat && mat.map instanceof THREE.Texture) mat.map.dispose();
        if ('alphaMap' in mat && mat.alphaMap instanceof THREE.Texture) mat.alphaMap.dispose();
        mat.dispose();
      }
    });
    this.renderer?.dispose();
    // labelRenderer.domElement is a child of viewport (itself inside
    // overlay), so overlay.remove() below takes the whole label DOM subtree
    // with it -- no separate disposal call needed (CSS2DRenderer has none).
    this.overlay.remove();

    this.overlay = null;
    this.renderer = null;
    this.labelRenderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.animationFrame = null;
    this.resizeObserver = null;
    this.tooltipEl = null;
    this.sunMoonGroup = null;
    this.dayNightMesh = null;
    this.layerObjects = {};
    this.refreshTimer = null;
    this.satelliteStopFn = null;
  }

  private async initScene(
    viewport: HTMLElement,
    subsolar: { lat: number; lon: number },
    sublunar: { lat: number; lon: number },
    moonPhase: { phaseFraction: number; illuminatedFraction: number; phaseName: string; waxing: boolean },
  ): Promise<void> {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030507);
    // Was 0.012 -- at the old default camera distance (~85 units) that
    // worked out to a ~65% blend toward near-black, which is what made the
    // whole disc read as flat grey regardless of the actual imagery/lighting
    // underneath. Tuned instead so it's barely perceptible at normal viewing
    // distance and only actually fades in near the far end of the zoom range.
    scene.fog = new THREE.FogExp2(0x030507, 0.0045);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 500);
    // Tighter default framing than a naive "fit the whole disc" distance --
    // CSS2D markers are fixed-pixel-size DOM elements, so the only way to
    // give closely-spaced satellites (or any other layer) more visual
    // separation is to have the disc itself occupy more of the screen by
    // default, not to change any world-space scale (which a fixed-multiple
    // camera distance would just cancel out).
    camera.position.set(0, DISC_RADIUS * 0.85, DISC_RADIUS * 1.0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    viewport.appendChild(renderer.domElement);

    // HTML/CSS glyph markers (matching the 3D globe's own GlobeMap.ts marker
    // style) instead of raw WebGL sphere meshes -- rendered as a separate
    // absolutely-positioned layer on top of the canvas. pointer-events:none
    // on the layer itself lets drag/orbit and empty-space clicks fall
    // through to the canvas below; individual marker elements opt back into
    // pointer-events:auto so they stay clickable.
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(width, height);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.left = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    viewport.appendChild(labelRenderer.domElement);
    this.labelRenderer = labelRenderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.minDistance = DISC_RADIUS * 0.3;
    controls.maxDistance = DISC_RADIUS * 3;
    // Stop just above the horizon -- keeps the camera from dipping below the
    // disc plane and looking at the underside of the whole scene.
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();

    scene.add(new THREE.AmbientLight(0x8899bb, 0.85));
    const sunPos = skyPosition(subsolar.lat, subsolar.lon, SUN_DISTANCE);
    // Real subsolar direction -- lights the wall/markers from the actual
    // current sun direction, not a fixed decorative angle.
    const sunLight = new THREE.DirectionalLight(0xfff4d6, 1.1);
    sunLight.position.copy(sunPos);
    sunLight.target.position.set(0, 0, 0);
    scene.add(sunLight);
    scene.add(sunLight.target);

    // Cached in memory across open/close cycles (see getCachedTileImagery) --
    // reused for both the base disc texture and the day/night overlay's
    // city-lights/ocean-glint blending below.
    const tileZoom = Math.min(NASA_TILE_ZOOM, NASA_GIBS_MAX_LEVEL);
    const { blueMarble: blueMarbleCanvas, cityLights: cityLightsCanvas } = await getCachedTileImagery(tileZoom);

    const { texture, geometry } = await this.buildDisc(blueMarbleCanvas);
    // Unlit (MeshBasicMaterial), not MeshStandardMaterial: the dedicated
    // dayNightMesh overlay right below already does the actual day/night
    // shading against real sun position, so a standard material's own
    // cosine-falloff lighting on the disc itself was double-dimming
    // everything away from the subsolar point on top of that -- between
    // that and the old fog density, the disc read as flat grey almost
    // everywhere instead of showing the real NASA imagery colors. `fog:
    // false` keeps the true colors legible even at the outer edge of the
    // zoom range, where fog still fades the wall/background for depth.
    const disc = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, fog: false }));
    disc.rotation.x = -Math.PI / 2;
    scene.add(disc);

    const sunMoonGroup = new THREE.Group();
    sunMoonGroup.visible = this.layers.sunMoon !== false;
    scene.add(sunMoonGroup);
    this.sunMoonGroup = sunMoonGroup;

    // fog:false on both -- at SUN_DISTANCE/MOON_DISTANCE (300/150 units),
    // the scene's own fog was blending them so far toward the near-black
    // background that toggling this layer had no visible effect: the
    // sky spheres were already almost invisible whether the layer was on
    // or off. Also: neither previously had any marker on the disc itself
    // (unlike every other layer's glyph convention), so there was nothing
    // reliably in view to notice regardless of camera orientation -- the
    // sky spheres sit far outside the default framing whenever the real
    // subsolar/sublunar direction doesn't happen to point where the camera
    // starts out looking. The ground markers below fix that: they sit on
    // the disc itself, inside the default camera framing like every other
    // layer's markers.
    const sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(8, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff4d6, fog: false }),
    );
    sunMesh.position.copy(sunPos);
    sunMoonGroup.add(sunMesh);

    // Deliberately NOT a hand-drawn phase texture: a plain lit sphere,
    // positioned at the real sublunar direction and lit by the same
    // real-direction sun light above, naturally renders the correct
    // crescent/gibbous shape as a straightforward consequence of actual 3D
    // lighting geometry -- more honest than faking the shadow shape, and
    // simpler. The separate "% illuminated" readout (top of the view) comes
    // from the accurate synodic-phase calculation, decoupled from whatever
    // this particular camera angle happens to show.
    const moonPos = skyPosition(sublunar.lat, sublunar.lon, MOON_DISTANCE);
    const moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(4, 24, 24),
      new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.9, metalness: 0, fog: false }),
    );
    moonMesh.position.copy(moonPos);
    sunMoonGroup.add(moonMesh);

    // Ground-point glyph markers -- same CSS2DObject convention every other
    // layer uses, at the subsolar/sublunar point directly below each sky
    // object, so there's always something to see on the disc itself
    // regardless of where the sky spheres land relative to the camera.
    const sunGlyphEl = this.buildMarkerElement('☀️', 0xfff4d6);
    sunGlyphEl.addEventListener('click', (e) => this.showTooltip(e, {
      title: 'Sun',
      lines: [`Subsolar point: ${subsolar.lat.toFixed(1)}°, ${subsolar.lon.toFixed(1)}°`],
    }));
    const sunGlyph = new CSS2DObject(sunGlyphEl);
    sunGlyph.position.copy(localToWorld(projectLonLatLocal(subsolar.lon, subsolar.lat)));
    sunMoonGroup.add(sunGlyph);

    const moonGlyphEl = this.buildMarkerElement(moonPhaseEmoji(moonPhase.phaseName), 0xcccccc);
    moonGlyphEl.addEventListener('click', (e) => this.showTooltip(e, {
      title: 'Moon',
      lines: [
        `${moonPhase.phaseName} · ${Math.round(moonPhase.illuminatedFraction * 100)}% illuminated`,
        `Sublunar point: ${sublunar.lat.toFixed(1)}°, ${sublunar.lon.toFixed(1)}°`,
      ],
    }));
    const moonGlyph = new CSS2DObject(moonGlyphEl);
    moonGlyph.position.copy(localToWorld(projectLonLatLocal(sublunar.lon, sublunar.lat)));
    sunMoonGroup.add(moonGlyph);

    // Day/night shading -- a thin transparent disc floating just above the
    // base disc, darkening the night side based on real solar elevation at
    // each point (same +/-6deg civil-twilight band convention as real
    // day/night maps). A separate, toggleable layer rather than baked into
    // the base imagery texture, so it can be regenerated/toggled cheaply
    // without re-fetching or re-reprojecting the NASA tiles.
    const dayNightTexture = this.buildDayNightTexture(subsolar, sublunar, blueMarbleCanvas, cityLightsCanvas);
    const dayNightMesh = new THREE.Mesh(
      geometry.clone(), // same UV-overridden shape, no need to redo that per-vertex loop
      new THREE.MeshBasicMaterial({ map: dayNightTexture, transparent: true, depthWrite: false, fog: false }),
    );
    dayNightMesh.rotation.x = -Math.PI / 2;
    dayNightMesh.position.y = 0.05; // just above the base disc, avoids z-fighting
    dayNightMesh.visible = this.layers.dayNight !== false;
    scene.add(dayNightMesh);
    this.dayNightMesh = dayNightMesh;

    // The ice wall -- rises right at the disc's outer rim, exactly where the
    // texture's Antarctica ring (and the polar-fill from Mercator's own
    // coverage limit) lands, so the illusion continues into 3D. Tapered
    // (narrower at the top than the base) and faded via alphaMap near its
    // top edge, rather than a sheer cylinder with a hard rim -- reads as a
    // sloped ice ridge instead of a tower.
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(
        DISC_RADIUS + WALL_THICKNESS, DISC_RADIUS + WALL_THICKNESS * WALL_TAPER,
        WALL_HEIGHT, 128, 1, true,
      ),
      new THREE.MeshStandardMaterial({
        color: 0xdcefff, roughness: 0.35, metalness: 0.05,
        emissive: 0x224466, emissiveIntensity: 0.25,
        alphaMap: buildWallFadeTexture(),
        side: THREE.DoubleSide, transparent: true, opacity: 0.92,
      }),
    );
    wall.position.y = WALL_HEIGHT / 2;
    scene.add(wall);

    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.controls = controls;

    this.initLayers(scene, geometry);

    // Markers now handle their own clicks directly (see buildMarkerElement);
    // this just hides the tooltip when a click reaches the canvas itself,
    // i.e. lands on empty space rather than a marker element on top of it.
    renderer.domElement.addEventListener('click', () => {
      if (this.tooltipEl) this.tooltipEl.style.display = 'none';
    });

    const resizeObserver = new ResizeObserver(() => this.handleResize(viewport));
    resizeObserver.observe(viewport);
    this.resizeObserver = resizeObserver;

    const animate = (): void => {
      this.animationFrame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    animate();
  }

  // One row per signal type, same set as the 2D/3D map's own Layers panel
  // where a reasonably direct equivalent exists. A few of that panel's
  // layers are deliberately not here yet -- webcams, military flights/
  // vessels (feature-gated + clustering logic upstream) and a handful of
  // other-map-variant-only layers -- left for a follow-up rather than a
  // rushed, likely-buggy first pass.
  private buildLayersPanel(): HTMLElement {
    const rows: Array<{ key: string; label: string }> = [
      { key: 'conflicts', label: '⚔️ Conflict events (live)' },
      { key: 'conflictZones', label: '\u{1F534} Conflict zones' },
      { key: 'hotspots', label: '\u{1F3AF} Intel hotspots' },
      { key: 'militaryBases', label: '\u{1FA96} Military bases' },
      { key: 'nuclear', label: '☢️ Nuclear facilities' },
      { key: 'irradiators', label: '☣️ Gamma irradiators' },
      { key: 'spaceports', label: '\u{1F680} Spaceports' },
      { key: 'minerals', label: '⛏️ Critical minerals' },
      { key: 'economic', label: '\u{1F4B9} Economic centers' },
      { key: 'waterways', label: '\u{1F30A} Strategic waterways' },
      { key: 'cables', label: '\u{1F50C} Undersea cables' },
      { key: 'pipelines', label: '\u{1F6E2}️ Pipelines' },
      { key: 'earthquakes', label: '\u{1F30D} Earthquakes (live)' },
      { key: 'gpsJamming', label: '\u{1F4E1} GPS jamming (live)' },
      { key: 'radiationWatch', label: '☢️ Radiation watch (live)' },
      { key: 'satellites', label: '\u{1F6F0}️ Satellites (live, animated)' },
      { key: 'sunMoon', label: '☀️ Sun & Moon' },
      { key: 'dayNight', label: '\u{1F317} Day / night shading' },
    ];
    return h('div', { className: 'flat-earth-layers' },
      h('div', { className: 'flat-earth-layers-title' }, 'Signals'),
      ...rows.map(({ key, label }) => {
        const checkbox = h('input', {
          type: 'checkbox',
          onChange: (e: Event) => this.setLayerEnabled(key, (e.target as HTMLInputElement).checked),
        }) as HTMLInputElement;
        // Set as a real DOM property, not an h()-applied attribute -- a
        // "false" value passed through setAttribute('checked', 'false')
        // would still render checked, since HTML checkbox state is
        // presence-based, not value-based.
        checkbox.checked = this.layers[key] !== false;
        return h('label', { className: 'flat-earth-layer-row' }, checkbox, label);
      }),
    );
  }

  private setLayerEnabled(key: string, enabled: boolean): void {
    this.layers[key] = enabled;
    localStorage.setItem(`wm-flat-earth-layer-${key}`, enabled ? '1' : '0');
    const obj = this.layerObjects[key];
    if (obj) obj.visible = enabled;
    if (key === 'sunMoon' && this.sunMoonGroup) this.sunMoonGroup.visible = enabled;
    if (key === 'dayNight' && this.dayNightMesh) this.dayNightMesh.visible = enabled;
  }

  private handleResize(viewport: HTMLElement): void {
    if (!this.renderer || !this.camera) return;
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.labelRenderer?.setSize(width, height);
  }

  // Shown/positioned from a marker element's own click listener now,
  // instead of a scene-wide raycast -- CSS2DObject markers are real DOM
  // elements, so they can just tell us directly when they're clicked.
  private showTooltip(e: MouseEvent, datum: MarkerTooltipDatum): void {
    if (!this.tooltipEl) return;
    e.stopPropagation();
    this.tooltipEl.style.left = `${e.clientX}px`;
    this.tooltipEl.style.top = `${e.clientY}px`;
    this.tooltipEl.style.display = '';
    clearChildren(this.tooltipEl);
    const strong = document.createElement('strong');
    strong.textContent = datum.title;
    this.tooltipEl.appendChild(strong);
    for (const text of datum.lines) {
      const line = document.createElement('div');
      line.textContent = text;
      this.tooltipEl.appendChild(line);
    }
  }

  // Same visual convention GlobeMap.ts's own glyph markers use: a small
  // emoji, colored and glowing via text-shadow, in an invisible 20x20px hit
  // target for easier clicking. `color` only styles the glyph -- there's no
  // separate geometry/material to manage since this is a plain DOM element.
  private buildMarkerElement(glyph: string, color: number): HTMLElement {
    const c = cssColor(color);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:20px;height:20px;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;user-select:none;';
    const glyphEl = document.createElement('div');
    glyphEl.style.cssText = `font-size:13px;color:${c};text-shadow:0 0 4px ${c}88;line-height:1;`;
    glyphEl.textContent = glyph;
    wrap.appendChild(glyphEl);
    return wrap;
  }

  // Satellites get their own marker style (a small glowing dot, not an
  // emoji glyph) to match GlobeMap.ts's satellite markers exactly.
  private buildSatelliteDotElement(color: number): HTMLElement {
    const c = cssColor(color);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:16px;height:16px;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;user-select:none;';
    const dot = document.createElement('div');
    dot.style.cssText = `width:5px;height:5px;border-radius:50%;background:${c};box-shadow:0 0 6px 2px ${c}88;`;
    wrap.appendChild(dot);
    return wrap;
  }

  // The ground "footprint" ring directly beneath each satellite -- same
  // faint translucent-circle style GlobeMap.ts uses for its satFootprint
  // markers. Not clickable (pointer-events:none): it's a passive visual
  // anchor for the beam/shroud above it, the dot marker already handles
  // clicks/tooltips.
  private buildSatFootprintElement(color: number): HTMLElement {
    const c = cssColor(color);
    const el = document.createElement('div');
    el.style.cssText = `width:12px;height:12px;border-radius:50%;border:1px solid ${c}66;background:${c}15;pointer-events:none;`;
    return el;
  }

  // Registers every layer this view knows about: static reference-data
  // layers render synchronously (no fetch involved, always available),
  // live-fetched layers go through the cache-then-refresh path below, and
  // path/polygon layers (cables, pipelines, conflict zones) get baked into
  // their own toggleable overlay texture rather than individual 3D line
  // meshes, reusing the same disc geometry (and its UV override) as the
  // day/night overlay already does.
  private initLayers(scene: THREE.Scene, geometry: THREE.CircleGeometry): void {
    this.addStaticLayer(scene, 'hotspots', INTEL_HOTSPOTS, (d) => ({ lat: d.lat, lon: d.lon }), '\u{1F3AF}', 0xffaa00,
      (d) => ({
        title: d.name,
        lines: [
          d.location ?? d.subtext ?? '',
          d.level ? `Level: ${d.level}` : '',
          d.status ?? '',
          d.agencies?.length ? `Agencies: ${d.agencies.join(', ')}` : '',
          d.description ?? '',
          d.whyItMatters ? `Why it matters: ${d.whyItMatters}` : '',
        ].filter(Boolean),
      }));
    this.addStaticLayer(scene, 'militaryBases', MILITARY_BASES, (d) => ({ lat: d.lat, lon: d.lon }), '\u{1FA96}', 0x6699ff,
      (d) => ({
        title: d.name,
        lines: [
          [d.country, d.arm].filter(Boolean).join(' · '),
          d.status ? `Status: ${d.status}` : '',
          d.description ?? '',
        ].filter(Boolean),
      }));
    this.addStaticLayer(scene, 'nuclear', NUCLEAR_FACILITIES, (d) => ({ lat: d.lat, lon: d.lon }), '☢️', 0xffdd00,
      (d) => ({
        title: d.name,
        lines: [
          `${d.type} · ${d.status}`,
          d.operator ? `Operator: ${d.operator}` : '',
          d.operationalSince ? `Operational since: ${d.operationalSince}` : '',
          d.iaeaStatus ? `IAEA status: ${d.iaeaStatus}` : '',
          d.treaties?.length ? `Treaties: ${d.treaties.join(', ')}` : '',
          d.keyEvents?.length ? `Key events: ${d.keyEvents.join('; ')}` : '',
        ].filter(Boolean),
      }));
    this.addStaticLayer(scene, 'irradiators', GAMMA_IRRADIATORS, (d) => ({ lat: d.lat, lon: d.lon }), '☣️', 0xaaff00,
      (d) => ({ title: d.city, lines: [d.country, d.organization ? `Operator: ${d.organization}` : ''].filter(Boolean) }));
    this.addStaticLayer(scene, 'spaceports', SPACEPORTS, (d) => ({ lat: d.lat, lon: d.lon }), '\u{1F680}', 0xff66ff,
      (d) => ({
        title: d.name,
        lines: [`${d.country} · ${d.status}`, `Operator: ${d.operator}`, `Launch frequency: ${d.launches}`],
      }));
    this.addStaticLayer(scene, 'minerals', CRITICAL_MINERALS, (d) => ({ lat: d.lat, lon: d.lon }), '⛏️', 0x00ffcc,
      (d) => ({
        title: d.name,
        lines: [`${d.mineral} · ${d.country}`, `Operator: ${d.operator}`, `Status: ${d.status}`, d.significance ?? ''].filter(Boolean),
      }));
    this.addStaticLayer(scene, 'economic', ECONOMIC_CENTERS, (d) => ({ lat: d.lat, lon: d.lon }), '\u{1F4B9}', 0x44ff88,
      (d) => ({
        title: d.name,
        lines: [
          `${d.type} · ${d.country}`,
          d.marketHours ? `Hours: ${d.marketHours.open}–${d.marketHours.close} (${d.marketHours.timezone})` : '',
          d.description ?? '',
        ].filter(Boolean),
      }));
    this.addStaticLayer(scene, 'waterways', STRATEGIC_WATERWAYS, (d) => ({ lat: d.lat, lon: d.lon }), '\u{1F30A}', 0x00ccff,
      (d) => ({ title: d.name, lines: [d.description ?? ''].filter(Boolean) }));

    const earthquakeGroup = this.makeLayerGroup(scene, 'earthquakes');
    const gpsJamGroup = this.makeLayerGroup(scene, 'gpsJamming');
    const radiationGroup = this.makeLayerGroup(scene, 'radiationWatch');
    const conflictGroup = this.makeLayerGroup(scene, 'conflicts');

    const refreshAll = (): void => {
      // '〽' (not the 🌍 globe emoji this used to use) -- same earthquake
      // glyph convention GlobeMap.ts's own natural-disaster layer uses;
      // 🌍 read as an odd choice for a marker on a view that's already a
      // whole rendered Earth.
      void this.loadLiveLayer('earthquakes', earthquakeGroup, fetchEarthquakes,
        (d) => (d.location ? { lat: d.location.latitude, lon: d.location.longitude } : null), '〽', 0xff5500,
        (d) => ({
          title: `M${d.magnitude.toFixed(1)} — ${d.place}`,
          lines: [
            `Depth: ${d.depthKm}km`,
            d.occurredAt ? `Time: ${new Date(d.occurredAt).toLocaleString()}` : '',
            d.concernLevel ? `Concern: ${d.concernLevel}` : '',
            d.nearTestSite ? `Near test site: ${d.testSiteName ?? 'yes'}` : '',
          ].filter(Boolean),
        }));
      void this.loadLiveLayer('gpsJamming', gpsJamGroup, async () => (await fetchGpsInterference())?.hexes ?? [],
        (d: GpsJamHex) => ({ lat: d.lat, lon: d.lon }), '\u{1F4E1}', 0xff00ff,
        (d: GpsJamHex) => ({
          title: `GPS jamming (${d.level})`,
          lines: [`${d.pct.toFixed(1)}% of aircraft affected`, `${d.affectedAircraft} of ${d.totalAircraft} aircraft`],
        }));
      void this.loadLiveLayer('radiationWatch', radiationGroup, async () => (await fetchRadiationWatch()).observations,
        (d: RadiationObservation) => ({ lat: d.lat, lon: d.lon }), '☢️', 0x00ff00,
        (d: RadiationObservation) => ({
          title: d.location,
          lines: [
            d.country,
            `${d.value.toFixed(1)} ${d.unit} (baseline ${d.baselineValue.toFixed(1)})`,
            `Δ ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(1)} vs baseline`,
            `${d.severity.toUpperCase()} · ${d.confidence} confidence`,
            d.corroborated ? 'Corroborated by multiple sources' : '',
            d.conflictingSources ? 'Conflicting sources' : '',
          ].filter(Boolean),
        }));
      void this.loadLiveLayer('conflicts', conflictGroup,
        async () => { const resp = await fetchUcdpEvents(); return resp.success ? resp.data : []; },
        (d) => ({ lat: d.latitude, lon: d.longitude }), '⚔️', 0xff3b3b,
        (d) => ({
          title: d.country,
          lines: [
            `${d.side_a} vs ${d.side_b}`,
            `${d.deaths_best || 0} fatalities (${d.date_start})`,
            d.type_of_violence ? `Type: ${d.type_of_violence}` : '',
          ].filter(Boolean),
        }));
    };
    refreshAll();
    this.refreshTimer = setInterval(refreshAll, LIVE_LAYER_REFRESH_INTERVAL_MS);

    this.addOverlayLayer(scene, geometry, 'cables',
      (ctx, toCanvas) => this.drawPaths(ctx, toCanvas, UNDERSEA_CABLES, 'rgba(255, 210, 60, 0.85)'));
    this.addOverlayLayer(scene, geometry, 'pipelines',
      (ctx, toCanvas) => this.drawPaths(ctx, toCanvas, PIPELINES, 'rgba(255, 120, 40, 0.85)'));
    this.addConflictZonesLayer(scene, geometry);

    void this.loadSatellites(scene);
  }

  // Real-time SGP4 propagation (satellite.js, already a dependency for the
  // 3D globe's own satellite layer -- same TLE fetch, same propagation
  // functions, reused directly here). Unlike the other live layers, this
  // isn't cache-then-refresh-every-5-minutes: satellites genuinely move, so
  // marker positions get updated in place every few seconds via
  // startPropagationLoop, reusing the same dot/footprint per satellite
  // rather than rebuilding the group each tick -- only the beam/shroud
  // geometry (see buildSatelliteBeams) gets rebuilt wholesale each tick,
  // matching GlobeMap.ts's own rebuildSatBeams.
  private async loadSatellites(scene: THREE.Scene): Promise<void> {
    const group = this.makeLayerGroup(scene, 'satellites');
    let beamGroup: THREE.Group | null = null;
    try {
      const tles = await fetchSatelliteTLEs();
      if (!tles || tles.length === 0) return;
      const satRecs = await initSatRecs(tles);
      // Tracks the dot marker, ground footprint marker, and latest known
      // position/name/etc per satellite -- the click listener reads
      // `latest` at click-time (via the Map, keyed by the closed-over
      // noradId) rather than capturing a snapshot, so the tooltip always
      // reflects the most recent propagated position even though the
      // element itself is only created once.
      const byNoradId = new Map<string, { dot: CSS2DObject; footprint: CSS2DObject; latest: SatellitePosition }>();

      const render = (positions: SatellitePosition[]): void => {
        for (const pos of positions) {
          if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) continue;
          const color = SAT_COUNTRY_COLORS[pos.country] ?? 0xccccff;
          const world = satellitePosition(pos.lat, pos.lng, pos.alt);
          const local = projectLonLatLocal(pos.lng, pos.lat);
          let entry = byNoradId.get(pos.noradId);
          if (!entry) {
            const dotEl = this.buildSatelliteDotElement(color);
            dotEl.addEventListener('click', (e) => {
              const current = byNoradId.get(pos.noradId)?.latest;
              if (!current) return;
              // Same field set GlobeMap.ts's own satellite tooltip shows --
              // this used to only surface type/alt/velocity.
              const altBand = current.alt < 2000 ? 'LEO' : current.alt < 35786 ? 'MEO' : 'GEO';
              const operatorName = SAT_OPERATOR_NAME[current.country] || getCountryNameByCode(current.country) || current.country;
              const overHit = getCountryAtCoordinates(current.lat, current.lng);
              this.showTooltip(e, {
                title: `${current.name} (${current.country})`,
                lines: [
                  `NORAD ${current.noradId}`,
                  `Type: ${SAT_TYPE_LABEL[current.type] ?? current.type}`,
                  `Operator: ${operatorName}`,
                  `Over: ${overHit ? overHit.name : 'Ocean'}`,
                  `Alt. band: ${altBand} · ${Math.round(current.alt)} km`,
                  `Incl.: ${current.inclination.toFixed(1)}°`,
                  `Velocity: ${current.velocity.toFixed(1)} km/s`,
                ],
              });
            });
            const dot = new CSS2DObject(dotEl);
            group.add(dot);

            const footprint = new CSS2DObject(this.buildSatFootprintElement(color));
            group.add(footprint);

            entry = { dot, footprint, latest: pos };
            byNoradId.set(pos.noradId, entry);
          }
          entry.dot.position.copy(world);
          entry.footprint.position.set(local.x, 0.05, -local.y);
          entry.latest = pos;
        }

        if (beamGroup) {
          group.remove(beamGroup);
          disposeBeamGroup(beamGroup);
        }
        beamGroup = buildSatelliteBeams(positions);
        group.add(beamGroup);
      };

      render(propagatePositions(satRecs));
      this.satelliteStopFn = startPropagationLoop(satRecs, render, 2000);
    } catch (err) {
      console.warn('[FlatEarthView] failed to load satellites', err);
    }
  }

  private makeLayerGroup(scene: THREE.Scene, key: string): THREE.Group {
    const group = new THREE.Group();
    group.visible = this.layers[key] !== false;
    scene.add(group);
    this.layerObjects[key] = group;
    return group;
  }

  private addStaticLayer<T>(
    scene: THREE.Scene, key: string, items: T[],
    getLatLon: (item: T) => { lat: number; lon: number },
    glyph: string, color: number,
    getTooltip: (item: T) => MarkerTooltipDatum,
  ): void {
    const group = this.makeLayerGroup(scene, key);
    this.addPointMarkers(group, items, getLatLon, glyph, color, getTooltip);
  }

  // Reprojected via the exact same local(x,y) formula the disc texture and
  // geometry UVs derive from, so every layer lines up with the map
  // underneath rather than drifting from independently-reasoned coordinate
  // systems -- same principle the original conflict-marker comment here
  // established, now shared by every point layer. Markers are CSS2DObject-
  // wrapped HTML glyphs (see buildMarkerElement) rather than WebGL sphere
  // meshes, matching the 3D globe's own marker style.
  private addPointMarkers<T>(
    group: THREE.Group, items: T[],
    getLatLon: (item: T) => { lat: number; lon: number } | null,
    glyph: string, color: number,
    getTooltip: (item: T) => MarkerTooltipDatum,
  ): void {
    for (const item of items) {
      const ll = getLatLon(item);
      if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lon)) continue;
      const world = localToWorld(projectLonLatLocal(ll.lon, ll.lat));
      const el = this.buildMarkerElement(glyph, color);
      const datum = getTooltip(item);
      el.addEventListener('click', (e) => this.showTooltip(e, datum));
      const obj = new CSS2DObject(el);
      obj.position.copy(world);
      group.add(obj);
    }
  }

  // CSS2DObject fires a 'removed' event (see its constructor) that detaches
  // its own DOM element automatically once removed from the scene graph --
  // no manual per-marker DOM/material disposal needed here any more.
  private clearGroupMarkers(group: THREE.Group): void {
    for (const child of [...group.children]) group.remove(child);
  }

  // Cache-then-refresh: renders immediately from sessionStorage if present
  // (even if stale, for an instant view rather than a loading gap), then
  // fetches fresh data if the cache is missing/old and re-renders -- but
  // only on success, so a failed fetch leaves whatever was already showing
  // in place instead of clearing it.
  private async loadLiveLayer<T>(
    key: string, group: THREE.Group, fetchFn: () => Promise<T[]>,
    getLatLon: (item: T) => { lat: number; lon: number } | null,
    glyph: string, color: number,
    getTooltip: (item: T) => MarkerTooltipDatum,
  ): Promise<void> {
    const render = (items: T[]): void => {
      this.clearGroupMarkers(group);
      this.addPointMarkers(group, items, getLatLon, glyph, color, getTooltip);
    };

    const cached = loadCachedLayer<T>(key);
    if (cached) render(cached.data);

    const isStale = !cached || Date.now() - cached.fetchedAt > LIVE_LAYER_CACHE_TTL_MS;
    if (isStale) {
      try {
        const fresh = await fetchFn();
        saveCachedLayer(key, fresh);
        render(fresh);
      } catch (err) {
        console.warn(`[FlatEarthView] failed to refresh layer "${key}"`, err);
      }
    }
  }

  // Path/polygon layers get baked into their own small overlay texture
  // (same disc shape/UV as the day/night overlay) rather than individual
  // 3D line meshes -- simpler, and static data that never needs a redraw.
  // Factored out of addOverlayLayer so addConflictZonesLayer below can bake
  // the same kind of canvas-texture overlay (for the shaded zone shapes)
  // while ALSO adding real clickable markers into the same group -- plain
  // addOverlayLayer only ever produces a non-interactive painted mesh.
  private buildOverlayMesh(
    geometry: THREE.CircleGeometry,
    draw: (ctx: CanvasRenderingContext2D, toCanvas: (local: { x: number; y: number }) => [number, number]) => void,
    yOffset: number,
  ): THREE.Mesh | null {
    const canvas = document.createElement('canvas');
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const center = TEXTURE_SIZE / 2;
    const toCanvas = (local: { x: number; y: number }): [number, number] => [
      center + (local.x / DISC_RADIUS) * center,
      center + (local.y / DISC_RADIUS) * center,
    ];
    draw(ctx, toCanvas);

    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = false;
    const mesh = new THREE.Mesh(
      geometry.clone(), // same UV-overridden shape as the base disc
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = yOffset;
    return mesh;
  }

  private addOverlayLayer(
    scene: THREE.Scene, geometry: THREE.CircleGeometry, key: string,
    draw: (ctx: CanvasRenderingContext2D, toCanvas: (local: { x: number; y: number }) => [number, number]) => void,
  ): void {
    // Stacked just above the base disc/day-night overlay, each subsequent
    // one a hair higher to avoid z-fighting between overlays.
    const mesh = this.buildOverlayMesh(geometry, draw, 0.1 + Object.keys(this.layerObjects).length * 0.01);
    if (!mesh) return;
    mesh.visible = this.layers[key] !== false;
    scene.add(mesh);
    this.layerObjects[key] = mesh;
  }

  // Unlike the other polygon overlays (cables, pipelines are just painted
  // onto the shared canvas texture, non-interactive), conflict zones also
  // get a real clickable marker at each zone's center point -- same as
  // GlobeMap.ts's own conflictZone markers -- so clicking one actually shows
  // the zone's parties/casualties/history instead of nothing. Both the
  // shaded-region texture and the markers live in one group so the layer
  // toggle still governs both together.
  private addConflictZonesLayer(scene: THREE.Scene, geometry: THREE.CircleGeometry): void {
    const yOffset = 0.1 + Object.keys(this.layerObjects).length * 0.01;
    const group = this.makeLayerGroup(scene, 'conflictZones');
    const overlayMesh = this.buildOverlayMesh(geometry, (ctx, toCanvas) => this.drawConflictZones(ctx, toCanvas), yOffset);
    if (overlayMesh) group.add(overlayMesh);

    for (const zone of CONFLICT_ZONES) {
      const color = zone.intensity === 'high' ? 0xff3030 : zone.intensity === 'medium' ? 0xff8800 : 0xffcc00;
      const [lon, lat] = zone.center;
      const world = localToWorld(projectLonLatLocal(lon, lat));
      const el = this.buildMarkerElement('⚔️', color);
      const lines = [
        zone.location ?? '',
        zone.parties?.length ? `Parties: ${zone.parties.join(', ')}` : '',
        zone.casualties ? `Casualties: ${zone.casualties}` : '',
        zone.displaced ? `Displaced: ${zone.displaced}` : '',
        zone.startDate ? `Since: ${zone.startDate}` : '',
        zone.totalFatalities ? `Total fatalities: ${zone.totalFatalities}` : '',
        zone.peaceAgreements?.length ? `Peace agreements: ${zone.peaceAgreements.join(', ')}` : '',
        zone.description ?? '',
      ].filter((line): line is string => Boolean(line));
      el.addEventListener('click', (e) => this.showTooltip(e, { title: zone.name, lines }));
      const obj = new CSS2DObject(el);
      obj.position.copy(world);
      group.add(obj);
    }
  }

  private drawPaths(
    ctx: CanvasRenderingContext2D,
    toCanvas: (local: { x: number; y: number }) => [number, number],
    items: Array<{ points: [number, number][] }>,
    color: string,
  ): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (const item of items) {
      ctx.beginPath();
      item.points.forEach(([lon, lat], i) => {
        const [x, y] = toCanvas(projectLonLatLocal(lon ?? 0, lat ?? 0));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  private drawConflictZones(
    ctx: CanvasRenderingContext2D,
    toCanvas: (local: { x: number; y: number }) => [number, number],
  ): void {
    for (const zone of CONFLICT_ZONES) {
      const [fill, stroke] = zone.intensity === 'high' ? ['rgba(255, 40, 40, 0.30)', 'rgba(255, 40, 40, 0.9)']
        : zone.intensity === 'medium' ? ['rgba(255, 120, 0, 0.25)', 'rgba(255, 120, 0, 0.9)']
        : ['rgba(255, 200, 0, 0.20)', 'rgba(255, 200, 0, 0.9)'];
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      zone.coords.forEach(([lon, lat], i) => {
        const [x, y] = toCanvas(projectLonLatLocal(lon ?? 0, lat ?? 0));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  // Same lon/lat recovery formula as reprojectMercatorToAzimuthal (already
  // verified correct there -- see its comment on the earlier sign bug).
  // Beyond the base darkening alpha, this also blends in two things:
  //  - Real NASA VIIRS city-lights imagery on the night side (verified
  //    real data, not a hand-drawn glow -- see nasaCityLightsTileUrl).
  //  - A moonlit-sea glint: a soft highlight over ocean-like pixels,
  //    strongest directly under the moon and fading with its local
  //    elevation. There's no real per-viewing-angle specular reflection in
  //    a baked texture like this, so this is a stylistic approximation, not
  //    a physically exact one -- "ocean" itself is also just a coarse
  //    color heuristic (dark + blue-dominant) on the Blue Marble imagery,
  //    not a real land/water mask.
  private buildDayNightTexture(
    subsolar: { lat: number; lon: number },
    sublunar: { lat: number; lon: number },
    blueMarbleCanvas: HTMLCanvasElement | null,
    cityLightsCanvas: HTMLCanvasElement | null,
  ): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.CanvasTexture(canvas);

    const imageData = ctx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
    const center = TEXTURE_SIZE / 2;
    const sunLatRad = (subsolar.lat * Math.PI) / 180;
    const sunLonRad = (subsolar.lon * Math.PI) / 180;
    const moonLatRad = (sublunar.lat * Math.PI) / 180;
    const moonLonRad = (sublunar.lon * Math.PI) / 180;

    const blueMarbleData = blueMarbleCanvas?.getContext('2d')?.getImageData(0, 0, blueMarbleCanvas.width, blueMarbleCanvas.height) ?? null;
    const cityLightsData = cityLightsCanvas?.getContext('2d')?.getImageData(0, 0, cityLightsCanvas.width, cityLightsCanvas.height) ?? null;

    for (let oy = 0; oy < TEXTURE_SIZE; oy++) {
      for (let ox = 0; ox < TEXTURE_SIZE; ox++) {
        const dx = ox - center;
        const dy = oy - center;
        const rho = Math.sqrt(dx * dx + dy * dy);
        const idx = (oy * TEXTURE_SIZE + ox) * 4;
        if (rho > center) continue; // transparent, outside the disc

        const lonRad = Math.atan2(dx, dy);
        const latRad = Math.PI / 2 - (rho / center) * Math.PI;

        const sinElev = Math.sin(latRad) * Math.sin(sunLatRad)
          + Math.cos(latRad) * Math.cos(sunLatRad) * Math.cos(lonRad - sunLonRad);
        const elevDeg = (Math.asin(Math.max(-1, Math.min(1, sinElev))) * 180) / Math.PI;

        let alpha: number;
        let nightFactor: number;
        if (elevDeg > TWILIGHT_BAND_DEG) { alpha = 0; nightFactor = 0; }
        else if (elevDeg < -TWILIGHT_BAND_DEG) { alpha = NIGHT_MAX_ALPHA; nightFactor = 1; }
        else { nightFactor = 1 - (elevDeg + TWILIGHT_BAND_DEG) / (2 * TWILIGHT_BAND_DEG); alpha = NIGHT_MAX_ALPHA * nightFactor; }

        let r = 8, g = 12, b = 28;

        if (nightFactor > 0) {
          if (cityLightsData) {
            const [cr, cg, cb] = sampleMercatorPixel(cityLightsData, lonRad, latRad);
            // Only the actually-lit pixels (city clusters) contribute --
            // VIIRS' own near-black background already reads as ~0,0,0.
            r += cr * nightFactor;
            g += cg * 0.75 * nightFactor;
            b += cb * 0.35 * nightFactor;
          }

          if (blueMarbleData) {
            const [br, bg, bb] = sampleMercatorPixel(blueMarbleData, lonRad, latRad);
            const isOceanish = bb > br * 1.1 && bb > bg * 1.02 && br + bg + bb < 300;
            if (isOceanish) {
              const sinMoonElev = Math.sin(latRad) * Math.sin(moonLatRad)
                + Math.cos(latRad) * Math.cos(moonLatRad) * Math.cos(lonRad - moonLonRad);
              const moonElevDeg = (Math.asin(Math.max(-1, Math.min(1, sinMoonElev))) * 180) / Math.PI;
              if (moonElevDeg > 0) {
                const glint = Math.sin((moonElevDeg * Math.PI) / 180) * nightFactor * 55;
                r += glint * 0.8; g += glint * 0.9; b += glint;
              }
            }
          }
        }

        imageData.data[idx] = Math.min(255, r);
        imageData.data[idx + 1] = Math.min(255, g);
        imageData.data[idx + 2] = Math.min(255, b);
        imageData.data[idx + 3] = Math.round(alpha * 255);
      }
    }
    ctx.putImageData(imageData, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = false; // matches the base disc's UV convention
    return texture;
  }

  private async buildDisc(blueMarbleCanvas: HTMLCanvasElement | null): Promise<{ texture: THREE.CanvasTexture; geometry: THREE.CircleGeometry }> {
    const geometry = new THREE.CircleGeometry(DISC_RADIUS, 128);

    // Override the geometry's UVs from its own real vertex data using the
    // same local(x,y)->uv formula the canvas below is drawn with, instead
    // of relying on CircleGeometry's implicit default UV convention --
    // guarantees the texture and the geometry agree on where lon/lat 0,0
    // and everything else lands, by construction.
    const posAttr = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    if (!posAttr || !uv) return { texture: new THREE.CanvasTexture(document.createElement('canvas')), geometry };
    for (let i = 0; i < posAttr.count; i++) {
      const vx = posAttr.getX(i);
      const vy = posAttr.getY(i);
      uv.setXY(i, 0.5 + (vx / DISC_RADIUS) * 0.5, 0.5 + (vy / DISC_RADIUS) * 0.5);
    }
    uv.needsUpdate = true;

    const canvas = document.createElement('canvas');
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { texture: new THREE.CanvasTexture(canvas), geometry };

    ctx.fillStyle = '#050a12';
    ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

    const center = TEXTURE_SIZE / 2;

    // Maps geometry-local (x,y) -> canvas pixel, matching the UV override
    // above exactly (no v-flip needed since the texture below has flipY
    // explicitly disabled -- see the end of this function).
    const toCanvas = (local: { x: number; y: number }): [number, number] => [
      center + (local.x / DISC_RADIUS) * center,
      center + (local.y / DISC_RADIUS) * center,
    ];

    if (blueMarbleCanvas) {
      try {
        const imageData = reprojectMercatorToAzimuthal(blueMarbleCanvas, TEXTURE_SIZE);
        ctx.putImageData(imageData, 0, 0);
      } catch (err) {
        console.warn('[FlatEarthView] failed to reproject NASA imagery, falling back to a plain background', err);
      }
    }

    ctx.strokeStyle = 'rgba(140, 200, 255, 0.25)';
    ctx.lineWidth = 1;
    for (const lat of [60, 30, 0, -30, -60]) {
      const [, py] = toCanvas(projectLonLatLocal(0, lat));
      const r = Math.abs(py - center);
      ctx.beginPath();
      ctx.arc(center, center, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    try {
      const geojson = await getCountriesGeoJson();
      if (geojson) {
        ctx.strokeStyle = 'rgba(90, 255, 140, 0.75)';
        ctx.lineWidth = 1.1;
        for (const feature of geojson.features) {
          const geom = feature.geometry;
          if (!geom) continue;
          const polys = geom.type === 'Polygon' ? [geom.coordinates]
            : geom.type === 'MultiPolygon' ? geom.coordinates
            : [];
          for (const poly of polys) {
            for (const ring of poly) {
              ctx.beginPath();
              ring.forEach((coord, i) => {
                const [x, y] = toCanvas(projectLonLatLocal(coord[0] ?? 0, coord[1] ?? 0));
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
              });
              ctx.stroke();
            }
          }
        }
      }
    } catch {
      // Falls back to just the imagery + latitude rings.
    }

    const [nx, ny] = toCanvas({ x: 0, y: 0 });
    ctx.fillStyle = 'rgba(90, 255, 140, 0.9)';
    ctx.beginPath();
    ctx.arc(nx, ny, 3, 0, Math.PI * 2);
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Disabling the default vertical flip removes any ambiguity about which
    // direction is "up" in the mapping between canvas pixels and UV space --
    // the toCanvas()/UV-override formulas above both assume this.
    texture.flipY = false;
    return { texture, geometry };
  }
}
