// Constants shared by the main thread and the tile worker.
export const Z = 14; // tile zoom level (the deepest OpenFreeMap serves)
export const EARTH = 40075016.686; // equatorial circumference, metres
export const CELL = 40; // spatial-grid cell size, metres
export const PAD = 40; // spatial grids extend this far beyond the tile edge, metres

// Road segment kinds (stored per segment for collision / minimap / spawning).
export const KIND_ROAD = 0;
export const KIND_PATH = 1;
export const KIND_RAIL = 2;
export const KIND_RUNWAY = 3;

export const SEG_STRIDE = 6; // x1, z1, x2, z2, halfWidth, kind
export const NAME_STRIDE = 5; // x1, z1, x2, z2, nameIndex
export const TREE_STRIDE = 4; // x, z, scale, tint

export const lonLatToMerc = (lon, lat) => [
  (lon + 180) / 360,
  (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2,
];
export const mercToLonLat = (mx, my) => [
  mx * 360 - 180,
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI,
];
