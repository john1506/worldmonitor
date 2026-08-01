import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { h, clearChildren } from '@/utils/dom-utils';
import { getCountriesGeoJson, getCountryAtCoordinates, getCountryNameByCode } from '@/services/country-geometry';
import { fetchUcdpEvents } from '@/services/conflict';
import { nasaBlueMarbleTileUrl, nasaCityLightsTileUrl, nasaShadedReliefTileUrl, NASA_GIBS_MAX_LEVEL } from '@/services/globe-render-settings';
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
// Was 2048/zoom-4 (16x16 tiles). At controls.minDistance (0.3 * DISC_RADIUS),
// the camera's visible slice of the disc is roughly an eighth of its
// diameter, so that whole-globe-in-one-texture bake was only contributing
// ~250px of real source detail across the screen at closest zoom -- visibly
// blocky/smeared (see the zoomed-in disc screenshots that prompted this).
// Doubling both keeps the same 2x oversample ratio (32x32 tiles = 8192px
// source vs 4096px output) while roughly doubling the source pixels
// available per screen pixel at max zoom-in. NASA_GIBS_MAX_LEVEL is 8, so
// zoom 5 has headroom left; the nearest-neighbor reprojection below is a
// one-time O(TEXTURE_SIZE^2) cost per view-open (~4x pixels vs before), not
// per-frame, so this doesn't touch render-loop performance.
const TEXTURE_SIZE = 4096;
const NASA_TILE_ZOOM = 5;
const MERCATOR_MAX_LAT = 85.0511; // Web Mercator/GIBS' standard valid latitude bound
const MARKER_ALTITUDE = 0.4; // slightly above the disc surface, avoids z-fighting
const SUN_DISTANCE = 300;
const MOON_DISTANCE = 150;
const TWILIGHT_BAND_DEG = 6; // matches real civil-twilight convention
const NIGHT_MAX_ALPHA = 0.72; // capped, not fully opaque -- imagery stays faintly visible at night

// ─── Zoom-based tile LOD (Flat Earth disc) ─────────────────────────────────
// The disc's base bake (see NASA_TILE_ZOOM/TEXTURE_SIZE above) is one
// fixed-resolution texture for the whole globe -- unlike the 3D globe view,
// which streams real per-zoom NASA tiles via three-globe's built-in tile
// engine, zooming the disc's camera in just magnifies that fixed bake. This
// section adds real LOD: as the camera settles closer than
// LOD_ENGAGE_DISTANCE, fetch and composite higher-zoom NASA tiles for just
// the visible region (see refineDiscLod).
const LOD_BASE_ZOOM = Math.min(NASA_TILE_ZOOM, NASA_GIBS_MAX_LEVEL); // 5
const LOD_MAX_ZOOM = NASA_GIBS_MAX_LEVEL; // 8
const LOD_ENGAGE_DISTANCE = DISC_RADIUS * 0.16; // 8 units -- below this, refine kicks in
const LOD_SETTLE_DELAY_MS = 800; // mirrors GlobeMap.ts's controlsEndHandler debounce
const LOD_MIN_REGION_SHIFT_DEG = 1.5; // lon/lat delta required before refetching at the same tier
const LOD_TILE_FETCH_CAP = 256; // hard per-layer tile cap per refine

// Doubling ladder: each halving of distance below LOD_ENGAGE_DISTANCE earns
// one more tile-zoom level (8 -> 4 -> 2 -> 1 unit maps to zoom 5 -> 6 -> 7 ->
// 8, landing zoom LOD_MAX_ZOOM exactly at controls.minDistance).
function lodZoomForDistance(distance: number): number {
  if (distance >= LOD_ENGAGE_DISTANCE) return LOD_BASE_ZOOM;
  const levels = Math.round(Math.log2(LOD_ENGAGE_DISTANCE / Math.max(distance, 0.01)));
  return Math.min(LOD_MAX_ZOOM, LOD_BASE_ZOOM + Math.max(0, levels));
}

// Every toggleable layer this view knows about -- static reference-data
// layers (always available, no fetch) plus a handful of live-fetched ones
// (cached + periodically refreshed, see the caching section below).
const ALL_LAYER_KEYS = [
  'conflicts', 'conflictZones', 'hotspots', 'militaryBases', 'nuclear',
  'irradiators', 'spaceports', 'minerals', 'economic', 'waterways',
  'cables', 'pipelines', 'earthquakes', 'gpsJamming', 'radiationWatch',
  'satellites', 'sunMoon', 'dayNight', 'reliefShading',
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

// Inverse of projectLonLatLocal. `radius` lets callers use either raw
// local-space units (DISC_RADIUS) or texture-pixel units (TEXTURE_SIZE/2) --
// both the LOD camera-viewport lookup and the per-pixel reprojection/patch
// functions below need this identical rho/lonRad/latRad math, just at
// different scales, so it's factored out once rather than hand-copied at
// each call site.
function localToLonLat(local: { x: number; y: number }, radius: number): { lonRad: number; latRad: number } | null {
  const rho = Math.sqrt(local.x * local.x + local.y * local.y);
  if (rho > radius) return null; // off the disc entirely
  const lonRad = Math.atan2(local.x, local.y);
  const latRad = Math.PI / 2 - (rho / radius) * Math.PI;
  return { lonRad, latRad };
}

// Forward local-space -> texture-pixel helper, matching buildDisc's toCanvas
// closure exactly (same formula, needed again by the LOD patch functions).
function discLocalToTexturePixel(local: { x: number; y: number }, textureSize: number): [number, number] {
  const center = textureSize / 2;
  return [center + (local.x / DISC_RADIUS) * center, center + (local.y / DISC_RADIUS) * center];
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
// given satellite reads as the same color in both views -- plus a
// FlatEarthView-only 'STARLINK' bucket (GlobeMap has no per-country filter,
// so it excludes Starlink outright rather than adding a color for it; see
// GlobeMap.ts's setSatellites). Kept separate from 'US' specifically so
// toggling it off doesn't also hide actual US ISR satellites.
const SAT_COUNTRY_COLORS: Record<string, number> = {
  CN: 0xff2020, RU: 0xff8800, US: 0x4488ff, EU: 0x44cc44,
  KR: 0xaa66ff, IN: 0xff66aa, TR: 0xff4466, OTHER: 0xccccff,
  STARLINK: 0x999999,
};

// Country buckets that should default to *off* the first time this view
// ever runs (no localStorage entry yet) -- everything else defaults on.
// Starlink alone is ~7,000 satellites, a real jump in marker count versus
// every other bucket here (tens each); CSS2DObject markers are real DOM
// elements repositioned every animation frame, so this is opt-in rather
// than something that suddenly floods the view for existing users.
const SAT_COUNTRY_DEFAULT_ENABLED: Record<string, boolean> = { STARLINK: false };

// Same lookup tables GlobeMap.ts's own satellite tooltip uses, so the two
// views agree on operator name/type label wording, not just marker color.
const SAT_OPERATOR_NAME: Record<string, string> = {
  CN: 'China', RU: 'Russia', US: 'United States', EU: 'ESA / EU',
  KR: 'South Korea', IN: 'India', TR: 'Turkey', OTHER: 'Other',
  STARLINK: 'Starlink (SpaceX, US)',
};
const SAT_TYPE_LABEL: Record<string, string> = {
  sar: 'SAR Imaging', optical: 'Optical Imaging', military: 'Military', sigint: 'SIGINT',
  comms: 'Communications',
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

// Bounds how many tile Image() loads (and therefore how many concurrent
// requests to this add-on's own imagery-relay backend, which itself proxies
// to NASA GIBS on a cache miss) are in flight at once. Three layers
// (blue-marble/city-lights/shaded-relief) fetch in parallel via
// Promise.all, so real concurrency is roughly 3x this. Needed because
// firing the whole grid unbounded worked fine at zoom 4 (256 tiles/layer,
// ~768 total) but started failing outright (net::ERR_FAILED, not a GIBS
// error -- confirmed the same coordinates 200 directly against GIBS) once
// the zoom-5 bump (1024 tiles/layer, ~3072 total) overwhelmed either the
// relay running on a Pi or its outbound connection pool.
const TILE_FETCH_CONCURRENCY = 16;

// Session-lifetime only (no TTL of its own -- the server's Cache-Control:
// max-age=86400 already governs staleness, see imagery-relay.mjs's NASA
// tile proxy+cache). Collapses duplicate in-flight requests for the exact
// same tile URL (e.g. two overlapping LOD refines racing, or a patch
// re-requesting a tile the whole-disc bake already has) and skips redundant
// image-decode work. Bounded FIFO eviction so it can't grow unbounded across
// a long session of continuous zooming.
const tileImageCache = new Map<string, Promise<HTMLImageElement | null>>();
const TILE_IMAGE_CACHE_MAX = 2048;

function loadTileImageCached(url: string): Promise<HTMLImageElement | null> {
  const hit = tileImageCache.get(url);
  if (hit) return hit;
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve(img);
    // A missing/failed tile just leaves that patch blank rather than
    // failing the whole reprojection -- most of GIBS' grid resolves fine.
    img.onerror = () => resolve(null);
    img.src = url;
  });
  tileImageCache.set(url, promise);
  if (tileImageCache.size > TILE_IMAGE_CACHE_MAX) {
    const oldest = tileImageCache.keys().next().value;
    if (oldest) tileImageCache.delete(oldest);
  }
  return promise;
}

// Shared bounded-worker-pool tile loader used by both the whole-globe bake
// (fetchAssembledMercatorCanvas) and the region-limited LOD patch fetch
// (fetchAssembledMercatorPatch) below, so the concurrency-pool logic exists
// in exactly one place. `coords` are tile (tx,ty) pairs at `zoom`; each tile
// draws onto `ctx` at `((tx-originX)*tileSize, (ty-originY)*tileSize)`.
async function loadTileGrid(
  coords: [number, number][],
  zoom: number,
  tileUrlFn: (x: number, y: number, level: number) => string,
  ctx: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  tileSize: number,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(TILE_FETCH_CONCURRENCY, coords.length) }, async () => {
    while (next < coords.length) {
      const coord = coords[next++];
      if (!coord) break;
      const [tx, ty] = coord;
      const img = await loadTileImageCached(tileUrlFn(tx, ty, zoom));
      if (img) ctx.drawImage(img, (tx - originX) * tileSize, (ty - originY) * tileSize);
    }
  });
  await Promise.all(workers);
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
  const context = canvas.getContext('2d');
  if (!context) return canvas;

  const coords: [number, number][] = [];
  for (let tx = 0; tx < tilesPerSide; tx++) {
    for (let ty = 0; ty < tilesPerSide; ty++) coords.push([tx, ty]);
  }

  await loadTileGrid(coords, zoom, tileUrlFn, context, 0, 0, tileSize);
  return canvas;
}

// Region-limited variant of fetchAssembledMercatorCanvas: fetches only the
// explicit [txMin..txMax] x [tyMin..tyMax] tile window instead of the full
// 2^zoom x 2^zoom grid -- used by the LOD refine path, which only ever needs
// the tiles covering the currently-visible patch of the disc, not the whole
// globe. Deliberately does NOT pre-fill the canvas background -- failed or
// never-fetched tiles are left as the canvas's default transparent-black,
// which the patch functions below use (alpha === 0) to distinguish "no data
// here" from real imagery and skip those texels rather than overwriting
// existing content.
async function fetchAssembledMercatorPatch(
  zoom: number,
  txMin: number, txMax: number, tyMin: number, tyMax: number,
  tileUrlFn: (x: number, y: number, level: number) => string,
): Promise<{ canvas: HTMLCanvasElement; tileOriginX: number; tileOriginY: number } | null> {
  const tileSize = 256;
  const width = (txMax - txMin + 1) * tileSize;
  const height = (tyMax - tyMin + 1) * tileSize;
  if (width <= 0 || height <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const coords: [number, number][] = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) coords.push([tx, ty]);
  }

  await loadTileGrid(coords, zoom, tileUrlFn, ctx, txMin, tyMin, tileSize);
  return { canvas, tileOriginX: txMin, tileOriginY: tyMin };
}

// In-memory (module-level) cache of the raw assembled Mercator canvases
// BEFORE reprojection, reused across open/close cycles within the same page
// load. Deliberately not caching the final built disc texture itself: the
// day/night shading and sun/moon positions need to reflect whatever time it
// actually is on each open, so those still get recomputed fresh every time,
// just reusing this same underlying imagery.
const tileImageryCache: {
  zoom: number | null;
  blueMarble: HTMLCanvasElement | null;
  cityLights: HTMLCanvasElement | null;
  shadedRelief: HTMLCanvasElement | null;
} = {
  zoom: null, blueMarble: null, cityLights: null, shadedRelief: null,
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

async function getCachedTileImagery(zoom: number): Promise<{
  blueMarble: HTMLCanvasElement | null;
  cityLights: HTMLCanvasElement | null;
  shadedRelief: HTMLCanvasElement | null;
}> {
  if (tileImageryCache.zoom === zoom && (tileImageryCache.blueMarble || tileImageryCache.cityLights || tileImageryCache.shadedRelief)) {
    return { blueMarble: tileImageryCache.blueMarble, cityLights: tileImageryCache.cityLights, shadedRelief: tileImageryCache.shadedRelief };
  }

  const [persistedBlueMarble, persistedCityLights, persistedShadedRelief] = await Promise.all([
    loadPersistedCanvas(`blueMarble-z${zoom}`),
    loadPersistedCanvas(`cityLights-z${zoom}`),
    loadPersistedCanvas(`shadedRelief-z${zoom}`),
  ]);
  if (persistedBlueMarble || persistedCityLights || persistedShadedRelief) {
    tileImageryCache.zoom = zoom;
    tileImageryCache.blueMarble = persistedBlueMarble;
    tileImageryCache.cityLights = persistedCityLights;
    tileImageryCache.shadedRelief = persistedShadedRelief;
    return { blueMarble: persistedBlueMarble, cityLights: persistedCityLights, shadedRelief: persistedShadedRelief };
  }

  const [blueMarble, cityLights, shadedRelief] = await Promise.all([
    fetchAssembledMercatorCanvas(zoom, nasaBlueMarbleTileUrl).catch((err) => {
      console.warn('[FlatEarthView] failed to load NASA Blue Marble tiles', err);
      return null;
    }),
    fetchAssembledMercatorCanvas(zoom, nasaCityLightsTileUrl).catch((err) => {
      console.warn('[FlatEarthView] failed to load NASA city-lights tiles', err);
      return null;
    }),
    fetchAssembledMercatorCanvas(zoom, nasaShadedReliefTileUrl).catch((err) => {
      console.warn('[FlatEarthView] failed to load NASA shaded-relief tiles', err);
      return null;
    }),
  ]);
  tileImageryCache.zoom = zoom;
  tileImageryCache.blueMarble = blueMarble;
  tileImageryCache.cityLights = cityLights;
  tileImageryCache.shadedRelief = shadedRelief;
  if (blueMarble) void savePersistedCanvas(`blueMarble-z${zoom}`, blueMarble);
  if (cityLights) void savePersistedCanvas(`cityLights-z${zoom}`, cityLights);
  if (shadedRelief) void savePersistedCanvas(`shadedRelief-z${zoom}`, shadedRelief);
  return { blueMarble, cityLights, shadedRelief };
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

// Region-limited counterpart to reprojectMercatorToAzimuthal, used by the
// LOD refine path: mutates `existing` (a [pxMin,pyMin]..[pxMin+w,pyMin+h]
// sub-rectangle of the full TEXTURE_SIZE x TEXTURE_SIZE texture, already
// fetched via ctx.getImageData) in place, sampling from a freshly-fetched
// higher-zoom `source` patch canvas (from fetchAssembledMercatorPatch)
// instead of the whole-globe bake. Every skip path below leaves the
// corresponding `existing` texel exactly as it was -- non-destructive by
// construction, so a partially-covered or failed patch never overwrites
// good existing imagery with garbage or black.
function patchAzimuthalRegion(
  existing: ImageData,
  pxMin: number,
  pyMin: number,
  source: HTMLCanvasElement,
  tileOriginX: number,
  tileOriginY: number,
  sourceZoom: number,
  textureSize: number,
): void {
  const srcCtx = source.getContext('2d');
  if (!srcCtx) return;
  const srcData = srcCtx.getImageData(0, 0, source.width, source.height);
  const center = textureSize / 2;
  const maxLatRad = (MERCATOR_MAX_LAT * Math.PI) / 180;
  const tileSize = 256;
  const fullMercSize = 2 ** sourceZoom * tileSize;

  for (let row = 0; row < existing.height; row++) {
    for (let col = 0; col < existing.width; col++) {
      const ox = pxMin + col;
      const oy = pyMin + row;
      const dx = ox - center;
      const dy = oy - center;
      const rho = Math.sqrt(dx * dx + dy * dy);
      if (rho > center) continue; // outside the disc

      const lonRad = Math.atan2(dx, dy);
      const latRad = Math.PI / 2 - (rho / center) * Math.PI;
      if (latRad > maxLatRad || latRad < -maxLatRad) continue; // no GIBS coverage at any zoom --
                                                                 // leave the existing icy fill alone

      // Same Mercator-pixel formula as sampleMercatorPixel, but against the
      // full sourceZoom grid, then offset into the smaller fetched patch's
      // local pixel space via tileOriginX/tileOriginY.
      const mercX = ((lonRad + Math.PI) / (2 * Math.PI)) * fullMercSize - tileOriginX * tileSize;
      const mercY = (0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI)) * fullMercSize - tileOriginY * tileSize;
      const sx = Math.round(mercX);
      const sy = Math.round(mercY);
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue; // outside the fetched patch

      const sIdx = (sy * source.width + sx) * 4;
      if (srcData.data[sIdx + 3] === 0) continue; // tile failed to load / never painted here

      const dIdx = (row * existing.width + col) * 4;
      existing.data[dIdx] = srcData.data[sIdx] ?? 0;
      existing.data[dIdx + 1] = srcData.data[sIdx + 1] ?? 0;
      existing.data[dIdx + 2] = srcData.data[sIdx + 2] ?? 0;
      existing.data[dIdx + 3] = 255;
    }
  }
}

// A grayscale "how much to darken this point" multiplier, derived from real
// terrain elevation via NASA GIBS' BlueMarble_ShadedRelief layer (Blue
// Marble imagery pre-lit against actual elevation data -- visible mountain
// shadows, snow, valleys) rather than showing that layer's own colors
// directly. Applied as a THREE.MultiplyBlending overlay on top of the plain
// (unlit, true-color) base disc, so real basemap colors stay intact and
// this only adds a relief cue on top -- same reasoning as the day/night
// overlay being a separate mesh rather than baked into the base texture.
//
// MultiplyBlending can only ever darken a base color, never brighten past
// it (values >1 aren't representable) -- so this only encodes the
// "recessed/shadowed" half of relief shading (valleys, shadowed slopes read
// darker), not a brightening pass for sunlit ridges/snow. That's still the
// dominant real-world legibility cue for reading terrain height
// differences, and keeping this a single overlay mesh (instead of adding a
// second additive-blended one for the brightening half) matches how much
// visual payoff this "just for fun" view needs for the complexity cost.
// BlueMarble_ShadedRelief's brightest features (snow, ice) consistently land
// near this luminance across the whole global dataset -- pixels at or above
// it multiply by 1 (no darkening); darker relief shading scales down from
// there. Floored at RELIEF_MIN_FACTOR so deep-shadow/ocean areas don't
// multiply the base imagery all the way to black. Shared (not local to
// buildReliefShadingTexture) so patchReliefShadingRegion's LOD refine uses
// the exact same formula rather than a hand-copied second version.
const RELIEF_PEAK_LUMINANCE = 245;
const RELIEF_MIN_FACTOR = 0.35;

function buildReliefShadingTexture(
  shadedReliefCanvas: HTMLCanvasElement | null,
  outSize: number,
): { texture: THREE.CanvasTexture; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = outSize;
  canvas.height = outSize;
  const ctx = canvas.getContext('2d');
  if (!ctx || !shadedReliefCanvas) return { texture: new THREE.CanvasTexture(canvas), canvas };
  const srcCtx = shadedReliefCanvas.getContext('2d');
  if (!srcCtx) return { texture: new THREE.CanvasTexture(canvas), canvas };
  const srcData = srcCtx.getImageData(0, 0, shadedReliefCanvas.width, shadedReliefCanvas.height);

  const out = ctx.createImageData(outSize, outSize);
  const center = outSize / 2;
  const maxLatRad = (MERCATOR_MAX_LAT * Math.PI) / 180;

  for (let oy = 0; oy < outSize; oy++) {
    for (let ox = 0; ox < outSize; ox++) {
      const dx = ox - center;
      const dy = oy - center;
      const rho = Math.sqrt(dx * dx + dy * dy);
      const outIdx = (oy * outSize + ox) * 4;
      if (rho > center) continue;

      let pixelValue = 255; // no darkening outside Mercator's coverage (poles/ice wall)
      const lonRad = Math.atan2(dx, dy);
      const latRad = Math.PI / 2 - (rho / center) * Math.PI;
      if (latRad <= maxLatRad && latRad >= -maxLatRad) {
        const [r, g, b] = sampleMercatorPixel(srcData, lonRad, latRad);
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const factor = Math.max(RELIEF_MIN_FACTOR, Math.min(1, lum / RELIEF_PEAK_LUMINANCE));
        pixelValue = Math.round(factor * 255);
      }

      out.data[outIdx] = pixelValue;
      out.data[outIdx + 1] = pixelValue;
      out.data[outIdx + 2] = pixelValue;
      out.data[outIdx + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false; // matches the base disc's UV convention
  return { texture, canvas };
}

// Region-limited counterpart to buildReliefShadingTexture's per-pixel loop,
// used by the LOD refine path -- same non-destructive skip-on-miss shape as
// patchAzimuthalRegion (see its comment), just computing a luminance-factor
// grayscale instead of copying RGB.
function patchReliefShadingRegion(
  existing: ImageData,
  pxMin: number,
  pyMin: number,
  source: HTMLCanvasElement,
  tileOriginX: number,
  tileOriginY: number,
  sourceZoom: number,
  textureSize: number,
): void {
  const srcCtx = source.getContext('2d');
  if (!srcCtx) return;
  const srcData = srcCtx.getImageData(0, 0, source.width, source.height);
  const center = textureSize / 2;
  const maxLatRad = (MERCATOR_MAX_LAT * Math.PI) / 180;
  const tileSize = 256;
  const fullMercSize = 2 ** sourceZoom * tileSize;

  for (let row = 0; row < existing.height; row++) {
    for (let col = 0; col < existing.width; col++) {
      const ox = pxMin + col;
      const oy = pyMin + row;
      const dx = ox - center;
      const dy = oy - center;
      const rho = Math.sqrt(dx * dx + dy * dy);
      if (rho > center) continue;

      const lonRad = Math.atan2(dx, dy);
      const latRad = Math.PI / 2 - (rho / center) * Math.PI;
      if (latRad > maxLatRad || latRad < -maxLatRad) continue; // leave the existing no-darkening fill

      const mercX = ((lonRad + Math.PI) / (2 * Math.PI)) * fullMercSize - tileOriginX * tileSize;
      const mercY = (0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI)) * fullMercSize - tileOriginY * tileSize;
      const sx = Math.round(mercX);
      const sy = Math.round(mercY);
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;

      const sIdx = (sy * source.width + sx) * 4;
      if (srcData.data[sIdx + 3] === 0) continue;

      const r = srcData.data[sIdx] ?? 0;
      const g = srcData.data[sIdx + 1] ?? 0;
      const b = srcData.data[sIdx + 2] ?? 0;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const factor = Math.max(RELIEF_MIN_FACTOR, Math.min(1, lum / RELIEF_PEAK_LUMINANCE));
      const pixelValue = Math.round(factor * 255);

      const dIdx = (row * existing.width + col) * 4;
      existing.data[dIdx] = pixelValue;
      existing.data[dIdx + 1] = pixelValue;
      existing.data[dIdx + 2] = pixelValue;
      existing.data[dIdx + 3] = 255;
    }
  }
}

// Region-limited counterpart to buildDayNightTexture's per-pixel loop, used
// by the LOD refine path. Unlike patchAzimuthalRegion/patchReliefShadingRegion,
// this does NOT skip-and-leave-existing when a source patch is missing --
// the sun-elevation-based alpha is pure geometry/time, independent of any
// imagery, so every non-off-disc pixel always gets a fresh alpha; only the
// cityLights/moon-glint RGB *contribution* gracefully degrades to "none" if
// its source patch is absent or didn't cover that pixel, mirroring
// buildDayNightTexture's own existing null-data handling exactly.
function patchDayNightRegion(
  existing: ImageData,
  pxMin: number,
  pyMin: number,
  blueMarblePatch: { canvas: HTMLCanvasElement; tileOriginX: number; tileOriginY: number } | null,
  cityLightsPatch: { canvas: HTMLCanvasElement; tileOriginX: number; tileOriginY: number } | null,
  sourceZoom: number,
  textureSize: number,
  subsolar: { lat: number; lon: number },
  sublunar: { lat: number; lon: number },
): void {
  const center = textureSize / 2;
  const sunLatRad = (subsolar.lat * Math.PI) / 180;
  const sunLonRad = (subsolar.lon * Math.PI) / 180;
  const moonLatRad = (sublunar.lat * Math.PI) / 180;
  const moonLonRad = (sublunar.lon * Math.PI) / 180;
  const tileSize = 256;
  const fullMercSize = 2 ** sourceZoom * tileSize;

  const blueMarbleData = blueMarblePatch?.canvas.getContext('2d')?.getImageData(0, 0, blueMarblePatch.canvas.width, blueMarblePatch.canvas.height) ?? null;
  const cityLightsData = cityLightsPatch?.canvas.getContext('2d')?.getImageData(0, 0, cityLightsPatch.canvas.width, cityLightsPatch.canvas.height) ?? null;

  // Windowed counterpart to sampleMercatorPixel: looks up a lon/lat inside
  // one of the fetched patch canvases, offset by its own tileOriginX/Y into
  // the full sourceZoom Mercator grid. Returns null (not a clamped nearest
  // pixel) if the lon/lat falls outside the fetched patch or that tile never
  // loaded (alpha === 0), so callers fall back to "no contribution" instead
  // of sampling garbage/wrapped data from an unrelated part of the canvas.
  function samplePatch(data: ImageData | null, originX: number, originY: number, lonRad: number, latRad: number): [number, number, number] | null {
    if (!data) return null;
    const mercX = ((lonRad + Math.PI) / (2 * Math.PI)) * fullMercSize - originX * tileSize;
    const mercY = (0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI)) * fullMercSize - originY * tileSize;
    const sx = Math.round(mercX);
    const sy = Math.round(mercY);
    if (sx < 0 || sy < 0 || sx >= data.width || sy >= data.height) return null;
    const idx = (sy * data.width + sx) * 4;
    if (data.data[idx + 3] === 0) return null;
    return [data.data[idx] ?? 0, data.data[idx + 1] ?? 0, data.data[idx + 2] ?? 0];
  }

  for (let row = 0; row < existing.height; row++) {
    for (let col = 0; col < existing.width; col++) {
      const ox = pxMin + col;
      const oy = pyMin + row;
      const dx = ox - center;
      const dy = oy - center;
      const rho = Math.sqrt(dx * dx + dy * dy);
      if (rho > center) continue; // outside the disc

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
        const cityLightsRgb = samplePatch(cityLightsData, cityLightsPatch?.tileOriginX ?? 0, cityLightsPatch?.tileOriginY ?? 0, lonRad, latRad);
        if (cityLightsRgb) {
          const [cr, cg, cb] = cityLightsRgb;
          r += cr * nightFactor;
          g += cg * 0.75 * nightFactor;
          b += cb * 0.35 * nightFactor;
        }

        const blueMarbleRgb = samplePatch(blueMarbleData, blueMarblePatch?.tileOriginX ?? 0, blueMarblePatch?.tileOriginY ?? 0, lonRad, latRad);
        if (blueMarbleRgb) {
          const [br, bg, bb] = blueMarbleRgb;
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

      const dIdx = (row * existing.width + col) * 4;
      existing.data[dIdx] = Math.min(255, r);
      existing.data[dIdx + 1] = Math.min(255, g);
      existing.data[dIdx + 2] = Math.min(255, b);
      existing.data[dIdx + 3] = Math.round(alpha * 255);
    }
  }
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
  private reliefMesh: THREE.Mesh | null = null;
  // Underlying canvases + textures for the three LOD-refinable layers, and
  // the astronomy snapshot needed to re-run the day/night patch algorithm
  // later -- all captured once in initScene, since refineDiscLod runs long
  // after initScene's own local params/variables are out of scope. See the
  // "Zoom-based tile LOD" section near the top of this file.
  private discTexture: THREE.CanvasTexture | null = null;
  private discCanvas: HTMLCanvasElement | null = null;
  private reliefTexture: THREE.CanvasTexture | null = null;
  private reliefCanvas: HTMLCanvasElement | null = null;
  private dayNightTexture: THREE.CanvasTexture | null = null;
  private dayNightCanvas: HTMLCanvasElement | null = null;
  private subsolar: { lat: number; lon: number } | null = null;
  private sublunar: { lat: number; lon: number } | null = null;
  private lodFetchTimer: ReturnType<typeof setTimeout> | null = null;
  private lodFetchVersion = 0;
  private lastLodRegion: { lonRad: number; latRad: number; zoom: number } | null = null;
  // Every toggleable layer's Object3D, keyed the same as `layers` below --
  // lets setLayerEnabled() stay a one-line generic toggle instead of a long
  // if-chain as more layers get added.
  private layerObjects: Record<string, THREE.Object3D> = {};
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private satelliteStopFn: (() => void) | null = null;
  // Per-country sub-filter within the satellites layer, so a busy sky
  // (100+ objects tracked at once) can be thinned to just the operators
  // someone cares about instead of all-or-nothing. Persisted the same way
  // as `layers` below, keyed by SAT_COUNTRY_COLORS' country codes.
  private satelliteCountryFilter: Record<string, boolean> = Object.fromEntries(
    Object.keys(SAT_COUNTRY_COLORS).map((c) => {
      const stored = localStorage.getItem(`wm-flat-earth-sat-country-${c}`);
      // No stored preference yet -> this bucket's own default (see
      // SAT_COUNTRY_DEFAULT_ENABLED); a stored '0'/'1' always wins once the
      // user has actually touched this checkbox.
      const enabled = stored === null ? (SAT_COUNTRY_DEFAULT_ENABLED[c] ?? true) : stored !== '0';
      return [c, enabled];
    }),
  );
  // Replays the last-known satellite positions through loadSatellites' own
  // render() closure -- reused so toggling a country filter takes effect
  // immediately (updated marker visibility + a re-filtered beam rebuild)
  // instead of waiting up to 2s for the next propagation tick.
  private rerenderSatellites: (() => void) | null = null;
  private latestSatellitePositions: SatellitePosition[] = [];
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
    if (this.lodFetchTimer != null) { clearTimeout(this.lodFetchTimer); this.lodFetchTimer = null; }
    this.lodFetchVersion++; // orphan any in-flight refineDiscLod so its result is discarded on resolve
    // OrbitControls.dispose() only removes its own internal pointer/wheel DOM
    // listeners, not custom 'end' listeners callers registered on its
    // EventDispatcher -- must remove this explicitly first.
    this.controls?.removeEventListener('end', this.handleControlsEnd);
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
    this.reliefMesh = null;
    this.discTexture = null;
    this.discCanvas = null;
    this.reliefTexture = null;
    this.reliefCanvas = null;
    this.dayNightTexture = null;
    this.dayNightCanvas = null;
    this.subsolar = null;
    this.sublunar = null;
    this.lastLodRegion = null;
    this.layerObjects = {};
    this.refreshTimer = null;
    this.satelliteStopFn = null;
    this.rerenderSatellites = null;
    this.latestSatellitePositions = [];
  }

  private async initScene(
    viewport: HTMLElement,
    subsolar: { lat: number; lon: number },
    sublunar: { lat: number; lon: number },
    moonPhase: { phaseFraction: number; illuminatedFraction: number; phaseName: string; waxing: boolean },
  ): Promise<void> {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);

    // Needed later by refineDiscLod/patchDayNightRegion, long after this
    // function's own local params are out of scope.
    this.subsolar = subsolar;
    this.sublunar = sublunar;

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
    // Was 0.3, then 0.08 -- both far more conservative than the 3D globe
    // (GlobeMap.ts's OrbitControls: minDistance 101 against a ~100-unit
    // globe radius, i.e. ~1% of radius above the surface) allows. 0.02
    // brings the disc's relative zoom-in range to that same ~1% ratio.
    // Past a certain point the baked disc texture (see TEXTURE_SIZE/
    // NASA_TILE_ZOOM above) is still a fixed-resolution whole-globe bake,
    // not a real per-zoom tile LOD system like the globe has, so the very
    // closest zoom will read softer than the equivalent 3D globe zoom.
    controls.minDistance = DISC_RADIUS * 0.02;
    controls.maxDistance = DISC_RADIUS * 3;
    // Stop just above the horizon -- keeps the camera from dipping below the
    // disc plane and looking at the underside of the whole scene.
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();
    // Zoom-based tile LOD: fires (debounced) whenever the user stops
    // dragging/scrolling, not on every frame -- see refineDiscLod.
    controls.addEventListener('end', this.handleControlsEnd);

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
    // reused for the base disc texture, the day/night overlay's city-lights/
    // ocean-glint blending, and the relief-shading overlay below.
    const { blueMarble: blueMarbleCanvas, cityLights: cityLightsCanvas, shadedRelief: shadedReliefCanvas } = await getCachedTileImagery(LOD_BASE_ZOOM);

    const { texture, geometry, canvas: discCanvas } = await this.buildDisc(blueMarbleCanvas);
    this.discTexture = texture;
    this.discCanvas = discCanvas;
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

    // Relief shading -- a thin MultiplyBlending overlay (real terrain
    // elevation, via NASA's BlueMarble_ShadedRelief) that darkens shadowed
    // slopes/valleys against the plain basemap underneath, so height
    // differences actually read visually instead of the disc looking
    // uniformly flat. Sits just above the base disc and below the day/night
    // overlay -- see buildReliefShadingTexture for why this is multiply-only
    // (darkening, not brightening) and toggleable independently.
    const { texture: reliefTexture, canvas: reliefCanvas } = buildReliefShadingTexture(shadedReliefCanvas, TEXTURE_SIZE);
    const reliefMesh = new THREE.Mesh(
      geometry.clone(),
      // premultipliedAlpha: true -- without it, three.js's WebGLState hits an
      // error() branch for MultiplyBlending that logs every frame AND skips
      // setting the GL blend function entirely, leaving stale blend state
      // rather than actually applying the darkening. Safe here since this
      // texture's alpha is always 255 wherever the mesh draws (see
      // buildReliefShadingTexture), so premultiplied vs. straight alpha is
      // identical -- this only fixes the blend-state bug, no visual change.
      new THREE.MeshBasicMaterial({ map: reliefTexture, transparent: true, depthWrite: false, fog: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true }),
    );
    reliefMesh.rotation.x = -Math.PI / 2;
    reliefMesh.position.y = 0.02; // above the base disc (0), below the day/night overlay (0.05)
    reliefMesh.visible = this.layers.reliefShading !== false;
    scene.add(reliefMesh);
    this.reliefMesh = reliefMesh;
    this.reliefTexture = reliefTexture;
    this.reliefCanvas = reliefCanvas;

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
    const { texture: dayNightTexture, canvas: dayNightCanvas } = this.buildDayNightTexture(subsolar, sublunar, blueMarbleCanvas, cityLightsCanvas);
    const dayNightMesh = new THREE.Mesh(
      geometry.clone(), // same UV-overridden shape, no need to redo that per-vertex loop
      new THREE.MeshBasicMaterial({ map: dayNightTexture, transparent: true, depthWrite: false, fog: false }),
    );
    dayNightMesh.rotation.x = -Math.PI / 2;
    dayNightMesh.position.y = 0.05; // just above the base disc, avoids z-fighting
    dayNightMesh.visible = this.layers.dayNight !== false;
    scene.add(dayNightMesh);
    this.dayNightMesh = dayNightMesh;
    this.dayNightTexture = dayNightTexture;
    this.dayNightCanvas = dayNightCanvas;

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
      { key: 'reliefShading', label: '\u{26F0}️ Relief shading' },
    ];
    const rowElements: HTMLElement[] = [];
    for (const { key, label } of rows) {
      const checkbox = h('input', {
        type: 'checkbox',
        onChange: (e: Event) => this.setLayerEnabled(key, (e.target as HTMLInputElement).checked),
      }) as HTMLInputElement;
      // Set as a real DOM property, not an h()-applied attribute -- a
      // "false" value passed through setAttribute('checked', 'false')
      // would still render checked, since HTML checkbox state is
      // presence-based, not value-based.
      checkbox.checked = this.layers[key] !== false;
      rowElements.push(h('label', { className: 'flat-earth-layer-row' }, checkbox, label));
      if (key === 'satellites') rowElements.push(this.buildSatelliteCountryFilterRows());
    }
    return h('div', { className: 'flat-earth-layers' },
      h('div', { className: 'flat-earth-layers-title' }, 'Signals'),
      ...rowElements,
    );
  }

  // Nested under the "Satellites" row -- lets a given nation's satellites
  // be toggled independently, so a busy sky (100+ objects at once) can be
  // thinned to just the operators someone cares about instead of only an
  // all-or-nothing layer toggle.
  private buildSatelliteCountryFilterRows(): HTMLElement {
    return h('div', { className: 'flat-earth-layer-subrows' },
      ...Object.keys(SAT_COUNTRY_COLORS).map((country) => {
        const checkbox = h('input', {
          type: 'checkbox',
          onChange: (e: Event) => this.setSatelliteCountryEnabled(country, (e.target as HTMLInputElement).checked),
        }) as HTMLInputElement;
        checkbox.checked = this.satelliteCountryFilter[country] !== false;
        const swatch = h('span', {
          className: 'flat-earth-sat-swatch',
          style: { background: cssColor(SAT_COUNTRY_COLORS[country] ?? 0xccccff) },
        });
        return h('label', { className: 'flat-earth-layer-row flat-earth-layer-subrow' },
          checkbox, swatch, SAT_OPERATOR_NAME[country] ?? country);
      }),
    );
  }

  private setSatelliteCountryEnabled(country: string, enabled: boolean): void {
    this.satelliteCountryFilter[country] = enabled;
    localStorage.setItem(`wm-flat-earth-sat-country-${country}`, enabled ? '1' : '0');
    this.rerenderSatellites?.();
  }

  private setLayerEnabled(key: string, enabled: boolean): void {
    this.layers[key] = enabled;
    localStorage.setItem(`wm-flat-earth-layer-${key}`, enabled ? '1' : '0');
    const obj = this.layerObjects[key];
    if (obj) obj.visible = enabled;
    if (key === 'sunMoon' && this.sunMoonGroup) this.sunMoonGroup.visible = enabled;
    if (key === 'dayNight' && this.dayNightMesh) this.dayNightMesh.visible = enabled;
    if (key === 'reliefShading' && this.reliefMesh) this.reliefMesh.visible = enabled;
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

  // Where the camera is actually looking, on the disc. Deliberately does NOT
  // use controls.target -- default OrbitControls panning (live, unmodified
  // in this file) moves .target freely and can drift it off the y=0 disc
  // plane over repeated oblique pans, so it can't be trusted as "the point
  // the camera is centered on". Instead: an analytic ray/plane intersection
  // from the camera through the screen-center view direction against the
  // disc's world-space y=0 plane -- cheap, and correct regardless of pan
  // drift.
  private getDiscCameraTarget(): { local: { x: number; y: number }; distance: number } | null {
    if (!this.camera) return null;
    const origin = this.camera.position;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    if (Math.abs(dir.y) < 1e-6) return null; // view direction ~parallel to the disc plane
    const t = -origin.y / dir.y;
    if (t <= 0) return null; // disc plane is behind the camera
    const hit = origin.clone().addScaledVector(dir, t);
    // Inverse of localToWorld's rotation note (see the comment above
    // localToWorld near the top of this file): world (x, 0, z) -> local
    // (x, y) is local.x = world.x, local.y = -world.z.
    return { local: { x: hit.x, y: -hit.z }, distance: origin.distanceTo(hit) };
  }

  // Debounced trigger for refineDiscLod -- fires ~LOD_SETTLE_DELAY_MS after
  // the user stops dragging/scrolling (OrbitControls' 'end' event), not on
  // every frame. Bound arrow-function class property (matches this file's
  // own handleKeydown convention) so add/removeEventListener see the same
  // reference both times.
  private handleControlsEnd = (): void => {
    if (this.lodFetchTimer != null) clearTimeout(this.lodFetchTimer);
    this.lodFetchTimer = setTimeout(() => { void this.refineDiscLod(); }, LOD_SETTLE_DELAY_MS);
  };

  // Core LOD orchestration: figure out whether the camera has settled
  // somewhere that warrants higher-res imagery than the base bake, fetch
  // just the tiles needed for that region at the appropriate zoom, and
  // composite them into all three disc layers (base imagery, relief
  // shading, day/night) -- see the "Zoom-based tile LOD" section near the
  // top of this file for the overall design.
  private async refineDiscLod(): Promise<void> {
    if (!this.camera || !this.discCanvas || !this.discTexture || !this.subsolar || !this.sublunar) return;

    const target = this.getDiscCameraTarget();
    if (!target || target.distance >= LOD_ENGAGE_DISTANCE) return;

    const zoom = lodZoomForDistance(target.distance);
    if (zoom <= LOD_BASE_ZOOM) return;

    const geo = localToLonLat(target.local, DISC_RADIUS);
    if (!geo) return; // panned past the disc edge

    const maxLatRad = (MERCATOR_MAX_LAT * Math.PI) / 180;
    if (Math.abs(geo.latRad) > maxLatRad) return; // inside the unmapped polar cap --
                                                    // nothing GIBS can provide at any zoom here

    if (this.lastLodRegion && this.lastLodRegion.zoom === zoom) {
      const dLon = Math.abs(geo.lonRad - this.lastLodRegion.lonRad) * (180 / Math.PI);
      const dLat = Math.abs(geo.latRad - this.lastLodRegion.latRad) * (180 / Math.PI);
      if (dLon < LOD_MIN_REGION_SHIFT_DEG && dLat < LOD_MIN_REGION_SHIFT_DEG) return;
    }

    // Loose over-fetch radius (1.4x margin) instead of an exact
    // frustum-corner intersection, which can extend absurdly far or fail to
    // intersect at all once maxPolarAngle allows near-horizon grazing
    // angles -- LOD_ENGAGE_DISTANCE's own bail-out above already self-limits
    // any pathological grazing-angle hit distance, so no separate cap is
    // needed here.
    const halfFovRad = (this.camera.fov * Math.PI / 180) / 2;
    const footprintRadiusLocal = Math.min(DISC_RADIUS, Math.max(0.5, target.distance * Math.tan(halfFovRad) * 1.4));

    // Geographic tile-range bbox: sample 8 points around the footprint
    // circle (plus the center) rather than just the local-space bounding
    // square's corners -- the azimuthal projection is nonlinear, so this
    // gives a tighter, more accurate tile range for a genuinely circular
    // visible footprint. Points that land off the disc (rho > DISC_RADIUS)
    // are simply skipped; the center point itself is always included as a
    // guaranteed-valid fallback.
    const tilesPerSide = 2 ** zoom;
    let txMin = Infinity, txMax = -Infinity, tyMin = Infinity, tyMax = -Infinity;
    const includeSample = (lonRad: number, latRad: number): void => {
      const clampedLat = Math.max(-maxLatRad, Math.min(maxLatRad, latRad));
      const mercX = ((lonRad + Math.PI) / (2 * Math.PI)) * tilesPerSide;
      const mercY = (0.5 - Math.log(Math.tan(Math.PI / 4 + clampedLat / 2)) / (2 * Math.PI)) * tilesPerSide;
      const tx = Math.max(0, Math.min(tilesPerSide - 1, Math.floor(mercX)));
      const ty = Math.max(0, Math.min(tilesPerSide - 1, Math.floor(mercY)));
      txMin = Math.min(txMin, tx); txMax = Math.max(txMax, tx);
      tyMin = Math.min(tyMin, ty); tyMax = Math.max(tyMax, ty);
    };
    includeSample(geo.lonRad, geo.latRad);
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const sampleLocal = {
        x: target.local.x + Math.cos(angle) * footprintRadiusLocal,
        y: target.local.y + Math.sin(angle) * footprintRadiusLocal,
      };
      const sampleGeo = localToLonLat(sampleLocal, DISC_RADIUS);
      if (sampleGeo) includeSample(sampleGeo.lonRad, sampleGeo.latRad);
    }

    // Hard per-layer tile cap, independent of how wide the sampled bbox
    // came out (e.g. an oblique/grazing framing) -- clamp to a maxSide x
    // maxSide window centered on the target's own tile, rather than growing
    // unbounded.
    const maxSide = Math.floor(Math.sqrt(LOD_TILE_FETCH_CAP));
    const centerTx = Math.max(0, Math.min(tilesPerSide - 1, Math.floor(((geo.lonRad + Math.PI) / (2 * Math.PI)) * tilesPerSide)));
    const centerTy = Math.max(0, Math.min(tilesPerSide - 1,
      Math.floor((0.5 - Math.log(Math.tan(Math.PI / 4 + geo.latRad / 2)) / (2 * Math.PI)) * tilesPerSide)));
    if (txMax - txMin + 1 > maxSide) { txMin = Math.max(0, centerTx - Math.floor(maxSide / 2)); txMax = Math.min(tilesPerSide - 1, txMin + maxSide - 1); }
    if (tyMax - tyMin + 1 > maxSide) { tyMin = Math.max(0, centerTy - Math.floor(maxSide / 2)); tyMax = Math.min(tilesPerSide - 1, tyMin + maxSide - 1); }

    const version = ++this.lodFetchVersion;
    const [blueMarblePatch, cityLightsPatch, shadedReliefPatch] = await Promise.all([
      fetchAssembledMercatorPatch(zoom, txMin, txMax, tyMin, tyMax, nasaBlueMarbleTileUrl).catch((err) => {
        console.warn('[FlatEarthView] LOD patch fetch failed for blueMarble', err);
        return null;
      }),
      fetchAssembledMercatorPatch(zoom, txMin, txMax, tyMin, tyMax, nasaCityLightsTileUrl).catch((err) => {
        console.warn('[FlatEarthView] LOD patch fetch failed for cityLights', err);
        return null;
      }),
      fetchAssembledMercatorPatch(zoom, txMin, txMax, tyMin, tyMax, nasaShadedReliefTileUrl).catch((err) => {
        console.warn('[FlatEarthView] LOD patch fetch failed for shadedRelief', err);
        return null;
      }),
    ]);
    if (version !== this.lodFetchVersion) return; // superseded by a newer refine -- discard

    // Bounding rect in texture-pixel space, from the same local-space
    // footprint square used above (expanded 10% further for safety margin),
    // clamped to the texture's own bounds.
    const [cx1, cy1] = discLocalToTexturePixel(
      { x: target.local.x - footprintRadiusLocal * 1.1, y: target.local.y - footprintRadiusLocal * 1.1 }, TEXTURE_SIZE);
    const [cx2, cy2] = discLocalToTexturePixel(
      { x: target.local.x + footprintRadiusLocal * 1.1, y: target.local.y + footprintRadiusLocal * 1.1 }, TEXTURE_SIZE);
    const pxMin = Math.max(0, Math.floor(Math.min(cx1, cx2)));
    const pxMax = Math.min(TEXTURE_SIZE - 1, Math.ceil(Math.max(cx1, cx2)));
    const pyMin = Math.max(0, Math.floor(Math.min(cy1, cy2)));
    const pyMax = Math.min(TEXTURE_SIZE - 1, Math.ceil(Math.max(cy1, cy2)));
    const w = pxMax - pxMin;
    const h = pyMax - pyMin;
    if (w <= 0 || h <= 0) return;

    if (blueMarblePatch && this.discCanvas && this.discTexture) {
      const ctx = this.discCanvas.getContext('2d');
      if (ctx) {
        const existing = ctx.getImageData(pxMin, pyMin, w, h);
        patchAzimuthalRegion(existing, pxMin, pyMin, blueMarblePatch.canvas, blueMarblePatch.tileOriginX, blueMarblePatch.tileOriginY, zoom, TEXTURE_SIZE);
        ctx.putImageData(existing, pxMin, pyMin);
        await this.drawDiscOverlays(ctx, TEXTURE_SIZE); // unconditional full redraw -- cheap, see its own comment
        this.discTexture.needsUpdate = true;
      }
    }
    if (shadedReliefPatch && this.reliefCanvas && this.reliefTexture) {
      const ctx = this.reliefCanvas.getContext('2d');
      if (ctx) {
        const existing = ctx.getImageData(pxMin, pyMin, w, h);
        patchReliefShadingRegion(existing, pxMin, pyMin, shadedReliefPatch.canvas, shadedReliefPatch.tileOriginX, shadedReliefPatch.tileOriginY, zoom, TEXTURE_SIZE);
        ctx.putImageData(existing, pxMin, pyMin);
        this.reliefTexture.needsUpdate = true;
      }
    }
    if (this.dayNightCanvas && this.dayNightTexture && (blueMarblePatch || cityLightsPatch)) {
      const ctx = this.dayNightCanvas.getContext('2d');
      if (ctx) {
        const existing = ctx.getImageData(pxMin, pyMin, w, h);
        patchDayNightRegion(existing, pxMin, pyMin, blueMarblePatch, cityLightsPatch, zoom, TEXTURE_SIZE, this.subsolar, this.sublunar);
        ctx.putImageData(existing, pxMin, pyMin);
        this.dayNightTexture.needsUpdate = true;
      }
    }

    this.lastLodRegion = { lonRad: geo.lonRad, latRad: geo.latRad, zoom };
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
        this.latestSatellitePositions = positions;
        for (const pos of positions) {
          if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) continue;
          const color = SAT_COUNTRY_COLORS[pos.country] ?? 0xccccff;
          const world = satellitePosition(pos.lat, pos.lng, pos.alt);
          const local = projectLonLatLocal(pos.lng, pos.lat);
          // Per-country sub-filter (see satelliteCountryFilter) -- hides
          // this satellite's dot/footprint independently of the master
          // "Satellites" layer toggle above it.
          const visible = this.satelliteCountryFilter[pos.country] !== false;
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
          entry.dot.visible = visible;
          entry.footprint.position.set(local.x, 0.05, -local.y);
          entry.footprint.visible = visible;
          entry.latest = pos;
        }

        if (beamGroup) {
          group.remove(beamGroup);
          disposeBeamGroup(beamGroup);
        }
        beamGroup = buildSatelliteBeams(positions.filter((p) => this.satelliteCountryFilter[p.country] !== false));
        group.add(beamGroup);
      };

      render(propagatePositions(satRecs));
      this.satelliteStopFn = startPropagationLoop(satRecs, render, 2000);
      this.rerenderSatellites = () => render(this.latestSatellitePositions);
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
  ): { texture: THREE.CanvasTexture; canvas: HTMLCanvasElement } {
    const canvas = document.createElement('canvas');
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { texture: new THREE.CanvasTexture(canvas), canvas };

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
    return { texture, canvas };
  }

  private async buildDisc(blueMarbleCanvas: HTMLCanvasElement | null): Promise<{ texture: THREE.CanvasTexture; geometry: THREE.CircleGeometry; canvas: HTMLCanvasElement }> {
    const geometry = new THREE.CircleGeometry(DISC_RADIUS, 128);

    // Override the geometry's UVs from its own real vertex data using the
    // same local(x,y)->uv formula the canvas below is drawn with, instead
    // of relying on CircleGeometry's implicit default UV convention --
    // guarantees the texture and the geometry agree on where lon/lat 0,0
    // and everything else lands, by construction.
    const posAttr = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    if (!posAttr || !uv) {
      const emptyCanvas = document.createElement('canvas');
      return { texture: new THREE.CanvasTexture(emptyCanvas), geometry, canvas: emptyCanvas };
    }
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
    if (!ctx) return { texture: new THREE.CanvasTexture(canvas), geometry, canvas };

    ctx.fillStyle = '#050a12';
    ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

    if (blueMarbleCanvas) {
      try {
        const imageData = reprojectMercatorToAzimuthal(blueMarbleCanvas, TEXTURE_SIZE);
        ctx.putImageData(imageData, 0, 0);
      } catch (err) {
        console.warn('[FlatEarthView] failed to reproject NASA imagery, falling back to a plain background', err);
      }
    }

    await this.drawDiscOverlays(ctx, TEXTURE_SIZE);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Disabling the default vertical flip removes any ambiguity about which
    // direction is "up" in the mapping between canvas pixels and UV space --
    // the toCanvas()/UV-override formulas above both assume this.
    texture.flipY = false;
    return { texture, geometry, canvas };
  }

  // Lat rings, country borders, and the north-pole marker dot -- drawn ON
  // TOP of the base imagery in the same 2D context. Extracted out of
  // buildDisc so refineDiscLod's LOD patches can redraw exactly this same
  // overlay pass after patching a sub-region of the canvas: ctx.putImageData
  // is a hard overwrite with no blending, so a patch that didn't redraw
  // these afterward would silently erase whatever border/ring strokes fall
  // in the patched area. Cheap enough (countries.geojson is ~7.3k line-
  // segment points total) to redraw unconditionally rather than clip to the
  // patched region.
  private async drawDiscOverlays(ctx: CanvasRenderingContext2D, textureSize: number): Promise<void> {
    const center = textureSize / 2;
    const toCanvas = (local: { x: number; y: number }): [number, number] => discLocalToTexturePixel(local, textureSize);

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
  }
}
