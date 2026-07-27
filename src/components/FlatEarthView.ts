import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { h } from '@/utils/dom-utils';
import { getCountriesGeoJson } from '@/services/country-geometry';

// A just-for-fun "Truman Show" view: a flat disc textured with a REAL
// azimuthal-equidistant reprojection of the app's own country-border data
// (north-pole-centered -- the same legitimate projection behind the UN
// emblem, and the one flat-earth theorists misread as "proof": at that
// projection, Antarctica (near -90deg latitude) doesn't shrink to a point,
// it stretches into a ring around the entire outer edge, because distance
// from the pole maps linearly to radius. That's real, unforced cartographic
// distortion -- this view just also puts a literal wall there, in on the
// joke rather than trying to sell it as anything else.
//
// Static/novelty scope for this first pass: no live data layers plotted on
// it yet, just the real country outlines baked into one texture. A live
// version (reprojecting the same marker feeds GlobeMap.ts already has)
// would be a reasonable follow-up if this turns out to be fun enough to
// keep around.

const DISC_RADIUS = 50;
const WALL_HEIGHT = 9;
const WALL_THICKNESS = 2.2;
const TEXTURE_SIZE = 2048;

export class FlatEarthView {
  private overlay: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private animationFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  public async open(): Promise<void> {
    if (this.overlay) return;

    const viewport = h('div', { className: 'flat-earth-viewport' });
    const status = h('div', { className: 'flat-earth-status' }, 'Rendering...');
    const overlay = h('div', { className: 'flat-earth-overlay' },
      h('div', { className: 'flat-earth-header' },
        h('div', { className: 'flat-earth-title' }, '\u{1F9CA} Flat Earth View'),
        h('button', { className: 'flat-earth-close', 'aria-label': 'Close', onClick: () => this.close() }, '×'),
      ),
      h('div', { className: 'flat-earth-viewport-wrap' }, viewport, status),
      h('div', { className: 'flat-earth-hint' }, 'Drag to look around · scroll to zoom · purely for fun, not a serious model of the Earth'),
    );
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });
    document.addEventListener('keydown', this.handleKeydown);
    document.body.appendChild(overlay);
    this.overlay = overlay;

    try {
      await this.initScene(viewport);
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
        if (mat instanceof THREE.MeshStandardMaterial) mat.map?.dispose();
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
  }

  private async initScene(viewport: HTMLElement): Promise<void> {
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

    scene.add(new THREE.AmbientLight(0x6688aa, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(30, 60, 20);
    scene.add(sun);

    const texture = await this.buildDiscTexture();
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(DISC_RADIUS, 128),
      new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0.05 }),
    );
    disc.rotation.x = -Math.PI / 2;
    scene.add(disc);

    // The ice wall -- rises right at the disc's outer rim, exactly where the
    // texture's Antarctica ring lands, so the illusion continues into 3D.
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

  private handleResize(viewport: HTMLElement): void {
    if (!this.renderer || !this.camera) return;
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private async buildDiscTexture(): Promise<THREE.CanvasTexture> {
    const canvas = document.createElement('canvas');
    canvas.width = TEXTURE_SIZE;
    canvas.height = TEXTURE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.CanvasTexture(canvas);

    ctx.fillStyle = '#050a12';
    ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

    const center = TEXTURE_SIZE / 2;
    const maxR = center * 0.96;

    // Standard polar azimuthal-equidistant projection: colatitude (distance
    // from the north pole) maps linearly to radius, longitude to angle.
    const project = (lon: number, lat: number): [number, number] => {
      const latRad = (lat * Math.PI) / 180;
      const lonRad = (lon * Math.PI) / 180;
      const rho = ((Math.PI / 2 - latRad) / Math.PI) * maxR;
      return [center + rho * Math.sin(lonRad), center - rho * Math.cos(lonRad)];
    };

    ctx.strokeStyle = 'rgba(80, 160, 120, 0.18)';
    ctx.lineWidth = 1;
    for (const lat of [60, 30, 0, -30, -60]) {
      const r = ((90 - lat) / 180) * maxR;
      ctx.beginPath();
      ctx.arc(center, center, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    try {
      const geojson = await getCountriesGeoJson();
      if (geojson) {
        ctx.strokeStyle = 'rgba(90, 255, 140, 0.85)';
        ctx.fillStyle = 'rgba(60, 200, 120, 0.06)';
        ctx.lineWidth = 1.3;
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
                const [x, y] = project(coord[0] ?? 0, coord[1] ?? 0);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
              });
              ctx.closePath();
              ctx.fill();
              ctx.stroke();
            }
          }
        }
      }
    } catch {
      // Falls back to just the background + latitude rings.
    }

    ctx.fillStyle = 'rgba(90, 255, 140, 0.9)';
    ctx.beginPath();
    ctx.arc(center, center, 3, 0, Math.PI * 2);
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
}
