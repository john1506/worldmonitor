import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { h, clearChildren } from '@/utils/dom-utils';
import { getCountriesGeoJson } from '@/services/country-geometry';
import { fetchUcdpEvents } from '@/services/conflict';
import { nasaBlueMarbleTileUrl, NASA_GIBS_MAX_LEVEL } from '@/services/globe-render-settings';

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
const WALL_HEIGHT = 9;
const WALL_THICKNESS = 2.2;
const TEXTURE_SIZE = 2048;
const NASA_TILE_ZOOM = 4; // 16x16 tiles -- 2x oversampled vs. TEXTURE_SIZE, meaningfully sharper than 1:1
const MERCATOR_MAX_LAT = 85.0511; // Web Mercator/GIBS' standard valid latitude bound
const MARKER_ALTITUDE = 0.4; // slightly above the disc surface, avoids z-fighting
const SUN_DISTANCE = 300;
const MOON_DISTANCE = 150;
const TWILIGHT_BAND_DEG = 6; // matches real civil-twilight convention
const NIGHT_MAX_ALPHA = 0.72; // capped, not fully opaque -- imagery stays faintly visible at night

interface ConflictMarkerDatum {
  country: string;
  lat: number;
  lon: number;
  deathsBest: number;
  dateStart: string;
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

async function fetchAssembledMercatorCanvas(zoom: number): Promise<HTMLCanvasElement> {
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
      const url = nasaBlueMarbleTileUrl(tx, ty, zoom);
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
  const sw = source.width;
  const sh = source.height;
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

      const mercX = ((lonRad + Math.PI) / (2 * Math.PI)) * sw;
      const mercY = (0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI)) * sh;
      const sx = Math.max(0, Math.min(sw - 1, Math.round(mercX)));
      const sy = Math.max(0, Math.min(sh - 1, Math.round(mercY)));
      const srcIdx = (sy * sw + sx) * 4;
      out.data[outIdx] = srcData.data[srcIdx] ?? 0;
      out.data[outIdx + 1] = srcData.data[srcIdx + 1] ?? 0;
      out.data[outIdx + 2] = srcData.data[srcIdx + 2] ?? 0;
      out.data[outIdx + 3] = 255;
    }
  }
  return out;
}

export class FlatEarthView {
  private overlay: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private animationFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private markerMeshes: THREE.Mesh[] = [];
  private markerData = new WeakMap<THREE.Mesh, ConflictMarkerDatum>();
  private raycaster = new THREE.Raycaster();
  private tooltipEl: HTMLElement | null = null;
  private conflictGroup: THREE.Group | null = null;
  private sunMoonGroup: THREE.Group | null = null;
  private dayNightMesh: THREE.Mesh | null = null;
  // Extensible on purpose -- more signal types (flights, ships, satellites)
  // can each get their own THREE.Group + a row in this same layers panel
  // later, following the same pattern as this first one.
  private layers: Record<string, boolean> = {
    conflicts: localStorage.getItem('wm-flat-earth-layer-conflicts') !== '0',
    sunMoon: localStorage.getItem('wm-flat-earth-layer-sunmoon') !== '0',
    dayNight: localStorage.getItem('wm-flat-earth-layer-daynight') !== '0',
  };

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
      await this.initScene(viewport, subsolar, sublunar);
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
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.scene?.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.geometry.dispose();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        // Generic check (not just MeshStandardMaterial) -- the day/night
        // overlay and sun/moon markers use MeshBasicMaterial, which also
        // has a `.map` that needs its own explicit disposal (Material.dispose()
        // doesn't cascade to textures, since a texture can be shared).
        if ('map' in mat && mat.map instanceof THREE.Texture) mat.map.dispose();
        mat.dispose();
      }
    });
    this.renderer?.dispose();
    this.overlay.remove();

    this.overlay = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.animationFrame = null;
    this.resizeObserver = null;
    this.markerMeshes = [];
    this.tooltipEl = null;
    this.conflictGroup = null;
    this.sunMoonGroup = null;
    this.dayNightMesh = null;
  }

  private async initScene(viewport: HTMLElement, subsolar: { lat: number; lon: number }, sublunar: { lat: number; lon: number }): Promise<void> {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030507);
    scene.fog = new THREE.FogExp2(0x030507, 0.012);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 500);
    camera.position.set(0, DISC_RADIUS * 1.1, DISC_RADIUS * 1.3);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    viewport.appendChild(renderer.domElement);

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

    scene.add(new THREE.AmbientLight(0x8899bb, 0.7));
    const sunPos = skyPosition(subsolar.lat, subsolar.lon, SUN_DISTANCE);
    // Real subsolar direction -- lights the wall/markers from the actual
    // current sun direction, not a fixed decorative angle.
    const sunLight = new THREE.DirectionalLight(0xfff4d6, 1.1);
    sunLight.position.copy(sunPos);
    sunLight.target.position.set(0, 0, 0);
    scene.add(sunLight);
    scene.add(sunLight.target);

    const { texture, geometry } = await this.buildDisc();
    const disc = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0.05 }));
    disc.rotation.x = -Math.PI / 2;
    scene.add(disc);

    const sunMoonGroup = new THREE.Group();
    sunMoonGroup.visible = this.layers.sunMoon !== false;
    scene.add(sunMoonGroup);
    this.sunMoonGroup = sunMoonGroup;

    const sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(8, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff4d6 }),
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
      new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.9, metalness: 0 }),
    );
    moonMesh.position.copy(moonPos);
    sunMoonGroup.add(moonMesh);

    // Day/night shading -- a thin transparent disc floating just above the
    // base disc, darkening the night side based on real solar elevation at
    // each point (same +/-6deg civil-twilight band convention as real
    // day/night maps). A separate, toggleable layer rather than baked into
    // the base imagery texture, so it can be regenerated/toggled cheaply
    // without re-fetching or re-reprojecting the NASA tiles.
    const dayNightTexture = this.buildDayNightTexture(subsolar);
    const dayNightMesh = new THREE.Mesh(
      geometry.clone(), // same UV-overridden shape, no need to redo that per-vertex loop
      new THREE.MeshBasicMaterial({ map: dayNightTexture, transparent: true, depthWrite: false }),
    );
    dayNightMesh.rotation.x = -Math.PI / 2;
    dayNightMesh.position.y = 0.05; // just above the base disc, avoids z-fighting
    dayNightMesh.visible = this.layers.dayNight !== false;
    scene.add(dayNightMesh);
    this.dayNightMesh = dayNightMesh;

    // The ice wall -- rises right at the disc's outer rim, exactly where the
    // texture's Antarctica ring (and the polar-fill from Mercator's own
    // coverage limit) lands, so the illusion continues into 3D.
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(
        DISC_RADIUS + WALL_THICKNESS, DISC_RADIUS + WALL_THICKNESS,
        WALL_HEIGHT, 128, 1, true,
      ),
      new THREE.MeshStandardMaterial({
        color: 0xdcefff, roughness: 0.35, metalness: 0.05,
        emissive: 0x224466, emissiveIntensity: 0.25,
        side: THREE.DoubleSide, transparent: true, opacity: 0.92,
      }),
    );
    wall.position.y = WALL_HEIGHT / 2;
    scene.add(wall);

    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.controls = controls;

    const conflictGroup = new THREE.Group();
    conflictGroup.visible = this.layers.conflicts !== false;
    scene.add(conflictGroup);
    this.conflictGroup = conflictGroup;
    void this.loadConflictMarkers(conflictGroup);

    renderer.domElement.addEventListener('click', (e) => this.handleClick(e, renderer, camera));

    const resizeObserver = new ResizeObserver(() => this.handleResize(viewport));
    resizeObserver.observe(viewport);
    this.resizeObserver = resizeObserver;

    const animate = (): void => {
      this.animationFrame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
  }

  // One row per signal type. Only "conflicts" is wired to real data right
  // now; more (flights, ships, satellites) can follow the same pattern --
  // add a THREE.Group, a default in `layers`, and a row here.
  private buildLayersPanel(): HTMLElement {
    const rows: Array<{ key: string; label: string }> = [
      { key: 'conflicts', label: '⚔️ Conflict events' },
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
    if (key === 'conflicts' && this.conflictGroup) {
      this.conflictGroup.visible = enabled;
    }
    if (key === 'sunMoon' && this.sunMoonGroup) {
      this.sunMoonGroup.visible = enabled;
    }
    if (key === 'dayNight' && this.dayNightMesh) {
      this.dayNightMesh.visible = enabled;
    }
  }

  private handleResize(viewport: HTMLElement): void {
    if (!this.renderer || !this.camera) return;
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private handleClick(e: MouseEvent, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    if (!this.tooltipEl || this.markerMeshes.length === 0 || this.layers.conflicts === false) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, camera);
    const hits = this.raycaster.intersectObjects(this.markerMeshes, false);
    const hit = hits[0]?.object;
    const datum = hit instanceof THREE.Mesh ? this.markerData.get(hit) : undefined;
    if (!datum) {
      this.tooltipEl.style.display = 'none';
      return;
    }
    this.tooltipEl.style.left = `${e.clientX}px`;
    this.tooltipEl.style.top = `${e.clientY}px`;
    this.tooltipEl.style.display = '';
    const dateStr = datum.dateStart ? new Date(datum.dateStart).toLocaleDateString() : 'unknown date';
    clearChildren(this.tooltipEl);
    const strong = document.createElement('strong');
    strong.textContent = datum.country;
    const line = document.createElement('div');
    line.textContent = `${datum.deathsBest} fatalities · ${dateStr}`;
    this.tooltipEl.appendChild(strong);
    this.tooltipEl.appendChild(line);
  }

  // Live conflict-event markers, reprojected via the exact same local(x,y)
  // formula the disc texture and geometry UVs derive from, so they line up
  // with the map underneath rather than drifting from two independently
  // reasoned coordinate systems.
  private async loadConflictMarkers(group: THREE.Group): Promise<void> {
    try {
      const resp = await fetchUcdpEvents();
      if (!resp.success) return;
      const markerGeo = new THREE.SphereGeometry(0.6, 12, 12);
      for (const event of resp.data) {
        if (!Number.isFinite(event.latitude) || !Number.isFinite(event.longitude)) continue;
        const local = projectLonLatLocal(event.longitude, event.latitude);
        const world = localToWorld(local);
        const intensity = Math.min(1, (event.deaths_best || 1) / 50);
        const mat = new THREE.MeshStandardMaterial({
          color: 0xff3b3b,
          emissive: 0xff2020,
          emissiveIntensity: 0.6 + intensity * 0.8,
        });
        const marker = new THREE.Mesh(markerGeo, mat);
        marker.position.copy(world);
        group.add(marker);
        this.markerMeshes.push(marker);
        this.markerData.set(marker, {
          country: event.country,
          lat: event.latitude,
          lon: event.longitude,
          deathsBest: event.deaths_best || 0,
          dateStart: event.date_start,
        });
      }
    } catch (err) {
      console.warn('[FlatEarthView] failed to load conflict markers', err);
    }
  }

  // Same lon/lat recovery formula as reprojectMercatorToAzimuthal (already
  // verified correct there -- see its comment on the earlier sign bug), just
  // producing a darkness alpha instead of sampling imagery.
  private buildDayNightTexture(subsolar: { lat: number; lon: number }): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.CanvasTexture(canvas);

    const imageData = ctx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
    const center = TEXTURE_SIZE / 2;
    const sunLatRad = (subsolar.lat * Math.PI) / 180;
    const sunLonRad = (subsolar.lon * Math.PI) / 180;

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
        if (elevDeg > TWILIGHT_BAND_DEG) alpha = 0;
        else if (elevDeg < -TWILIGHT_BAND_DEG) alpha = NIGHT_MAX_ALPHA;
        else alpha = NIGHT_MAX_ALPHA * (1 - (elevDeg + TWILIGHT_BAND_DEG) / (2 * TWILIGHT_BAND_DEG));

        imageData.data[idx] = 8;
        imageData.data[idx + 1] = 12;
        imageData.data[idx + 2] = 28;
        imageData.data[idx + 3] = Math.round(alpha * 255);
      }
    }
    ctx.putImageData(imageData, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = false; // matches the base disc's UV convention
    return texture;
  }

  private async buildDisc(): Promise<{ texture: THREE.CanvasTexture; geometry: THREE.CircleGeometry }> {
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

    try {
      const mercatorCanvas = await fetchAssembledMercatorCanvas(Math.min(NASA_TILE_ZOOM, NASA_GIBS_MAX_LEVEL));
      const imageData = reprojectMercatorToAzimuthal(mercatorCanvas, TEXTURE_SIZE);
      ctx.putImageData(imageData, 0, 0);
    } catch (err) {
      console.warn('[FlatEarthView] failed to load/reproject NASA imagery, falling back to a plain background', err);
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
