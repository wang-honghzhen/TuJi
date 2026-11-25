import type { Point } from '../v3/types';

export interface SpatialPoint { x: number; y: number; z: number }
export interface SpatialCamera { target: SpatialPoint; yaw: number; pitch: number; zoom: number }
interface Viewport { width: number; height: number }
interface ProjectedPoint extends Point { depth: number }

export const DEFAULT_SPATIAL_CAMERA: SpatialCamera = { target: { x: 0, y: 0, z: 0 }, yaw: -.25, pitch: .85, zoom: 1 };
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Orthographic projection of the canvas X/Z plane. Larger depth is closer to
 * the observer. At yaw zero and pitch π/2 the mapping agrees with the 2D view. */
function projectPoint(p: SpatialPoint, camera: SpatialCamera, viewport: Viewport): ProjectedPoint {
  const x = p.x - camera.target.x, y = p.y - camera.target.y, z = p.z - camera.target.z;
  const cos = Math.cos(camera.yaw), sin = Math.sin(camera.yaw), along = sin * x + cos * z;
  const incline = Math.sin(camera.pitch), rise = Math.cos(camera.pitch);
  return { x: viewport.width / 2 + camera.zoom * (cos * x - sin * z),
    y: viewport.height / 2 + camera.zoom * (incline * along - rise * y), depth: rise * along + incline * y };
}

/** Reuse the camera basis for every object drawn in this frame. */
export function createSpatialProjection(camera: SpatialCamera, viewport: Viewport) {
  const cos = Math.cos(camera.yaw), sin = Math.sin(camera.yaw);
  const incline = Math.sin(camera.pitch), rise = Math.cos(camera.pitch), zoom = camera.zoom;
  const cx = viewport.width / 2, cy = viewport.height / 2;
  const target = camera.target;
  function point(p: SpatialPoint): ProjectedPoint {
    const x = p.x - target.x, y = p.y - target.y, z = p.z - target.z;
    const along = sin * x + cos * z;
    return { x: cx + zoom * (cos * x - sin * z), y: cy + zoom * (incline * along - rise * y),
      depth: rise * along + incline * y };
  }
  /** Intersect a screen position with the horizontal plane that owns the object. */
  function onPlane(screen: Point, height: number): Point {
    const across = (screen.x - cx) / zoom;
    const along = ((screen.y - cy) / zoom + rise * (height - target.y)) / incline;
    return { x: target.x + cos * across + sin * along, y: target.z - sin * across + cos * along };
  }
  return { point, onPlane };
}

export function orbitSpatialCamera(camera: SpatialCamera, dx: number, dy: number, pivot?: SpatialPoint): SpatialCamera {
  const next = { ...camera, yaw: (camera.yaw - dx * .007) % (2 * Math.PI), pitch: clamp(camera.pitch + dy * .007, .14, Math.PI / 2) };
  if (!pivot) return next;
  // Orbit around the picked point without snapping it to the middle of the screen.
  const offset = projectPoint(pivot, camera, { width: 0, height: 0 });
  return panSpatialCamera({ ...next, target: pivot }, offset.x, offset.y);
}

/** Translate along the target's horizontal plane to move the world by dx/dy screen pixels. */
export function panSpatialCamera(camera: SpatialCamera, dx: number, dy: number): SpatialCamera {
  const across = -dx / camera.zoom, along = -dy / (camera.zoom * Math.sin(camera.pitch));
  const cos = Math.cos(camera.yaw), sin = Math.sin(camera.yaw);
  return { ...camera, target: { x: camera.target.x + across * cos + along * sin, y: camera.target.y,
    z: camera.target.z - across * sin + along * cos } };
}

export function zoomSpatialCamera(camera: SpatialCamera, factor: number, anchor?: Point, viewport?: Viewport): SpatialCamera {
  if (!Number.isFinite(factor) || factor <= 0) return camera;
  const zoom = clamp(camera.zoom * factor, Math.min(camera.zoom, .003), 8);
  const next = { ...camera, zoom };
  const offset = 1 - zoom / camera.zoom;
  return anchor && viewport ? panSpatialCamera(next, offset * (anchor.x - viewport.width / 2), offset * (anchor.y - viewport.height / 2)) : next;
}
