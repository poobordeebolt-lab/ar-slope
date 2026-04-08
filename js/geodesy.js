// WGS84 ellipsoid constants
const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// Geodetic (lon, lat, h ellipsoid) -> ECEF
export function geodeticToEcef(lonDeg, latDeg, h) {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const x = (N + h) * cosLat * Math.cos(lon);
  const y = (N + h) * cosLat * Math.sin(lon);
  const z = (N * (1 - E2) + h) * sinLat;
  return [x, y, z];
}

// Build ECEF->ENU rotation anchored at (lon0,lat0)
function enuRotation(lon0Deg, lat0Deg) {
  const lat = lat0Deg * D2R;
  const lon = lon0Deg * D2R;
  const sL = Math.sin(lat), cL = Math.cos(lat);
  const sO = Math.sin(lon), cO = Math.cos(lon);
  // rows: east, north, up
  return [
    [-sO,          cO,         0 ],
    [-sL * cO,   -sL * sO,    cL ],
    [ cL * cO,    cL * sO,    sL ],
  ];
}

// Create a reusable transformer anchored at given geodetic origin
export function makeEnuTransform(lon0, lat0, h0) {
  const origin = geodeticToEcef(lon0, lat0, h0);
  const R = enuRotation(lon0, lat0);
  return function toEnu(lon, lat, h) {
    const p = geodeticToEcef(lon, lat, h);
    const dx = p[0] - origin[0];
    const dy = p[1] - origin[1];
    const dz = p[2] - origin[2];
    const e = R[0][0]*dx + R[0][1]*dy + R[0][2]*dz;
    const n = R[1][0]*dx + R[1][1]*dy + R[1][2]*dz;
    const u = R[2][0]*dx + R[2][1]*dy + R[2][2]*dz;
    return [e, n, u]; // meters
  };
}

// Haversine great-circle distance in meters (ignoring height)
export function haversine(lon1, lat1, lon2, lat2) {
  const R = 6371008.8;
  const φ1 = lat1*D2R, φ2 = lat2*D2R;
  const dφ = (lat2-lat1)*D2R;
  const dλ = (lon2-lon1)*D2R;
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
