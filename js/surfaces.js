import * as THREE from 'three';
import { makeEnuTransform, haversine } from './geodesy.js';

// Color palette per surface name pattern
const COLORS = {
  'Inner Horizontal': 0x4fc3f7,
  'Conical':          0x81c784,
  'Approach':         0xffb74d,
  'Take-off':         0xff8a65,
  'Transitional':     0xba68c8,
  'Area 2':           0xe57373,
};
function colorFor(name) {
  for (const key of Object.keys(COLORS)) {
    if (name.includes(key)) return COLORS[key];
  }
  return 0xffffff;
}

// Normalize every polygon feature into a flat list:
// { name, kind: 'OLS'|'OCS', rings: [ [[lon,lat,h],...], holes... ] }
export function flattenFeatures(geojson, kind) {
  const out = [];
  for (const f of geojson.features) {
    const name = f.properties?.name ?? 'unnamed';
    const g = f.geometry;
    if (g.type === 'Polygon') {
      out.push({ name, kind, rings: g.coordinates });
    } else if (g.type === 'MultiPolygon') {
      g.coordinates.forEach((poly, i) => {
        out.push({ name: `${name} #${i+1}`, kind, rings: poly });
      });
    }
  }
  return out;
}

// Simple earcut-free triangulation via THREE.ShapeGeometry is overkill for these
// nearly-planar tilted polygons. We use fan triangulation of the outer ring
// (all OCS/OLS polygons in ICAO Annex 14 are convex or near-convex quads/
// trapezoids / annular sectors already split). Holes are ignored.
function fanTriangulate(ringEnu) {
  const tris = [];
  const n = ringEnu.length;
  // skip duplicate closing vertex
  const m = (ringEnu[0][0]===ringEnu[n-1][0] && ringEnu[0][1]===ringEnu[n-1][1] && ringEnu[0][2]===ringEnu[n-1][2]) ? n-1 : n;
  for (let i = 1; i < m - 1; i++) {
    tris.push([ringEnu[0], ringEnu[i], ringEnu[i+1]]);
  }
  return tris;
}

// Build a THREE.Mesh for each feature
export function buildMeshes(features, toEnu, userLonLat, rangeM) {
  const group = new THREE.Group();
  const surfaceQueries = []; // for point-in-polygon height query

  for (const feat of features) {
    // Culling by distance: check if any vertex is within range
    const outer = feat.rings[0];
    let anyClose = false;
    for (const c of outer) {
      if (haversine(userLonLat[0], userLonLat[1], c[0], c[1]) <= rangeM) { anyClose = true; break; }
    }
    if (!anyClose) continue;

    const ringEnu = outer.map(c => toEnu(c[0], c[1], c[2]));
    const tris = fanTriangulate(ringEnu);
    if (tris.length === 0) continue;

    const positions = new Float32Array(tris.length * 9);
    let p = 0;
    for (const tri of tris) {
      for (const v of tri) {
        // ENU -> Three.js (X=east, Y=up, Z=-north)  right-handed, camera looks -Z
        positions[p++] = v[0];
        positions[p++] = v[2];
        positions[p++] = -v[1];
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.computeVertexNormals();

    const color = colorFor(feat.name);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = feat.name;
    mesh.userData.kind = feat.kind;
    group.add(mesh);

    // Wireframe edges for clarity
    const edges = new THREE.EdgesGeometry(geom, 1);
    const line = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color, transparent:true, opacity:0.8 })
    );
    line.userData.kind = feat.kind;
    group.add(line);

    surfaceQueries.push({
      name: feat.name,
      kind: feat.kind,
      lonLatH: outer, // keep original for point-in-polygon in lon/lat
    });
  }

  return { group, surfaceQueries };
}

// Ray casting point-in-polygon in lon/lat space
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-20) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Plane interpolation: given triangle with 3 (lon,lat,h) vertices,
// compute h at (lon,lat) via barycentric in lon/lat plane.
function interpHeightInTri(lon, lat, a, b, c) {
  const x1=a[0], y1=a[1], z1=a[2];
  const x2=b[0], y2=b[1], z2=b[2];
  const x3=c[0], y3=c[1], z3=c[2];
  const denom = (y2-y3)*(x1-x3) + (x3-x2)*(y1-y3);
  if (Math.abs(denom) < 1e-20) return null;
  const w1 = ((y2-y3)*(lon-x3) + (x3-x2)*(lat-y3)) / denom;
  const w2 = ((y3-y1)*(lon-x3) + (x1-x3)*(lat-y3)) / denom;
  const w3 = 1 - w1 - w2;
  return w1*z1 + w2*z2 + w3*z3;
}

// Query: for a given (lon,lat) find all surfaces covering it, return their
// interpolated ellipsoid height using fan triangulation of the outer ring.
export function queryHeights(lon, lat, surfaceQueries) {
  const hits = [];
  for (const s of surfaceQueries) {
    const ring = s.lonLatH;
    if (!pointInRing(lon, lat, ring)) continue;
    // triangulate by fan and find the triangle that contains the point
    const n = ring.length;
    const m = (ring[0][0]===ring[n-1][0] && ring[0][1]===ring[n-1][1]) ? n-1 : n;
    for (let i = 1; i < m - 1; i++) {
      const a = ring[0], b = ring[i], c = ring[i+1];
      if (pointInRing(lon, lat, [a,b,c,a])) {
        const h = interpHeightInTri(lon, lat, a, b, c);
        if (h !== null) { hits.push({ name: s.name, kind: s.kind, h }); break; }
      }
    }
  }
  return hits;
}
