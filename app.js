// =============================================
// AR OLS Surface Viewer
// Renders OLS surfaces as proper 3D meshes
// =============================================

let userPos = null;
let userHeading = 0;
let surfaceData = null;
let renderRadius = 2000;
let testMode = false;
let anchorPos = null; // {lat, lon} where surfaces are placed
let scene = null;
let surfacesEntity = null;

// Color per surface type
const SURFACE_COLORS = {
  'inner horizontal': 0x3b82f6,
  'conical':          0x8b5cf6,
  'approach':         0x22c55e,
  'take-off':         0xf59e0b,
  'takeoff':          0xf59e0b,
  'transitional':     0xec4899,
  'default':          0x94a3b8
};

function getSurfaceColor(name) {
  if (!name) return SURFACE_COLORS.default;
  const lower = name.toLowerCase();
  for (const key in SURFACE_COLORS) {
    if (lower.includes(key)) return SURFACE_COLORS[key];
  }
  return SURFACE_COLORS.default;
}

// ----- UI helpers -----
function setStatus(html) {
  const el = document.getElementById('status');
  if (el) el.innerHTML = html;
}

function showAR() {
  document.getElementById('file-input').style.display = 'none';
  document.getElementById('ui').style.display = 'block';
  document.getElementById('legend').style.display = 'flex';
  document.getElementById('scene').style.display = 'block';
  scene = document.querySelector('a-scene');
  surfacesEntity = document.getElementById('surfaces');
  startStatusLoop();
}

// ----- File loading -----
function loadFile() {
  const fileInput = document.getElementById('geojson-file');
  const file = fileInput.files[0];
  if (!file) {
    alert('กรุณาเลือกไฟล์ GeoJSON');
    return;
  }
  renderRadius = parseInt(document.getElementById('render-radius').value) || 2000;
  testMode = document.getElementById('test-mode').checked;

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      surfaceData = JSON.parse(evt.target.result);
      console.log('Loaded GeoJSON:', surfaceData);
      console.log('Features:', surfaceData.features.length);
      showAR();
      waitForGPSThenRender();
    } catch (err) {
      alert('ไฟล์ไม่ถูกต้อง: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ----- GPS handling -----
function waitForGPSThenRender() {
  setStatus('รอ GPS fix...');
  navigator.geolocation.watchPosition((pos) => {
    userPos = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      alt: pos.coords.altitude,
      acc: pos.coords.accuracy,
      altAcc: pos.coords.altitudeAccuracy
    };
    if (!window._rendered) {
      decideAnchorAndRender();
      window._rendered = true;
    }
  }, (err) => {
    setStatus('GPS error: ' + err.message);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

// Decide where to anchor surfaces
function decideAnchorAndRender() {
  if (testMode) {
    // Test mode: shift entire surface so its centroid sits at user location
    const centroid = computeFeaturesCentroid(surfaceData);
    if (centroid) {
      const shiftLat = userPos.lat - centroid.lat;
      const shiftLon = userPos.lon - centroid.lon;
      anchorPos = { lat: userPos.lat, lon: userPos.lon };
      console.log(`Test mode: shifting surfaces by ${shiftLat}, ${shiftLon}`);
      shiftAllCoords(surfaceData, shiftLat, shiftLon);
    } else {
      anchorPos = { lat: userPos.lat, lon: userPos.lon };
    }
  } else {
    // Real mode: anchor at user position, surfaces at their real geo coords
    anchorPos = { lat: userPos.lat, lon: userPos.lon };
  }

  // Set anchor entity to user's position
  const anchor = document.getElementById('anchor');
  anchor.setAttribute('gps-entity-place',
    `latitude: ${anchorPos.lat}; longitude: ${anchorPos.lon}`);

  renderSurfaces();
}

function computeFeaturesCentroid(geojson) {
  let sumLat = 0, sumLon = 0, n = 0;
  function walk(c) {
    if (typeof c[0] === 'number') {
      sumLon += c[0]; sumLat += c[1]; n++;
    } else {
      c.forEach(walk);
    }
  }
  geojson.features.forEach(f => walk(f.geometry.coordinates));
  if (n === 0) return null;
  return { lat: sumLat/n, lon: sumLon/n };
}

function shiftAllCoords(geojson, dLat, dLon) {
  function walk(c) {
    if (typeof c[0] === 'number') {
      c[0] += dLon;
      c[1] += dLat;
    } else {
      c.forEach(walk);
    }
  }
  geojson.features.forEach(f => walk(f.geometry.coordinates));
}

// ----- Lat/Lon to local ENU (East-North-Up) meters relative to anchor -----
function llToEnu(lat, lon, alt) {
  const R = 6378137;
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLatRad = anchorPos.lat * Math.PI / 180;
  const east  = dLon * R * Math.cos(refLatRad);
  const north = dLat * R;
  const up = (alt || 0) - (userPos.alt || 0);
  // A-Frame uses X=east, Y=up, Z=-north (right-handed)
  return { x: east, y: up, z: -north };
}

// Distance from anchor in meters
function horizDistFromAnchor(lat, lon) {
  const R = 6378137;
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLatRad = anchorPos.lat * Math.PI / 180;
  const east  = dLon * R * Math.cos(refLatRad);
  const north = dLat * R;
  return Math.sqrt(east*east + north*north);
}

// ----- Main renderer -----
function renderSurfaces() {
  if (!surfaceData) return;
  setStatus('กำลังสร้าง mesh...');

  // Wait for THREE to be ready (A-Frame initializes it)
  if (!window.THREE || !scene.object3D) {
    setTimeout(renderSurfaces, 200);
    return;
  }

  let polyCount = 0;
  let totalTris = 0;

  surfaceData.features.forEach((feat, idx) => {
    const name = feat.properties?.name || `Feature ${idx}`;
    const color = getSurfaceColor(name);
    const geom = feat.geometry;

    let polygons = []; // each polygon: [outer_ring, hole1, hole2, ...]
    if (geom.type === 'Polygon') {
      polygons = [geom.coordinates];
    } else if (geom.type === 'MultiPolygon') {
      polygons = geom.coordinates;
    } else {
      return;
    }

    polygons.forEach(rings => {
      const mesh = createPolygonMesh(rings, color, name);
      if (mesh) {
        surfacesEntity.object3D.add(mesh);
        polyCount++;
        totalTris += mesh.userData.triCount || 0;
      }
    });
  });

  console.log(`Rendered ${polyCount} polygons, ~${totalTris} triangles`);
  setStatus(`✓ Render เสร็จ: ${polyCount} polygons, ${totalTris} tris`);
}

// Create a Three.js mesh from a polygon (outer ring + optional holes)
function createPolygonMesh(rings, color, name) {
  const outer = rings[0];
  if (!outer || outer.length < 3) return null;

  // Check if any vertex is within renderRadius
  let inRange = false;
  for (const v of outer) {
    if (horizDistFromAnchor(v[1], v[0]) < renderRadius) {
      inRange = true;
      break;
    }
  }
  if (!inRange) {
    console.log(`Skipping ${name}: out of range`);
    return null;
  }

  // Convert rings to flat ENU coords for earcut
  // earcut expects: [x0, y0, x1, y1, ...] flat array (2D for triangulation)
  // We keep the 3D position separately
  const flatCoords2D = [];
  const positions3D = [];
  const holeIndices = [];

  let vertIdx = 0;
  rings.forEach((ring, ringIdx) => {
    if (ringIdx > 0) holeIndices.push(vertIdx);
    // Skip last vertex if it's a duplicate of the first (closed ring)
    const lastIdx = (ring.length > 1 &&
      ring[0][0] === ring[ring.length-1][0] &&
      ring[0][1] === ring[ring.length-1][1])
      ? ring.length - 1 : ring.length;

    for (let i = 0; i < lastIdx; i++) {
      const [lon, lat, alt] = ring[i];
      const enu = llToEnu(lat, lon, alt);
      flatCoords2D.push(enu.x, enu.z); // use x, z for 2D triangulation (top-down)
      positions3D.push(enu.x, enu.y, enu.z);
      vertIdx++;
    }
  });

  // Triangulate
  const triangles = earcut(flatCoords2D, holeIndices, 2);
  if (triangles.length === 0) {
    console.log(`Triangulation failed for ${name}`);
    return null;
  }

  // Build BufferGeometry
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions3D, 3));
  geometry.setIndex(triangles);
  geometry.computeVertexNormals();

  // Material — semi-transparent, double-sided
  const material = new THREE.MeshBasicMaterial({
    color: color,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.name = name;
  mesh.userData.triCount = triangles.length / 3;

  // Wireframe outline overlay for visibility
  const wireGeom = new THREE.BufferGeometry();
  wireGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions3D, 3));
  wireGeom.setIndex(triangles);
  const wireMat = new THREE.MeshBasicMaterial({
    color: color,
    wireframe: true,
    transparent: true,
    opacity: 0.6
  });
  const wireMesh = new THREE.Mesh(wireGeom, wireMat);
  mesh.add(wireMesh);

  // Outline of the outer ring (thick line at the edge)
  const outlinePoints = [];
  const ringEnd = (outer.length > 1 &&
    outer[0][0] === outer[outer.length-1][0] &&
    outer[0][1] === outer[outer.length-1][1])
    ? outer.length : outer.length;
  for (let i = 0; i < ringEnd; i++) {
    const [lon, lat, alt] = outer[i % outer.length];
    const enu = llToEnu(lat, lon, alt);
    outlinePoints.push(new THREE.Vector3(enu.x, enu.y, enu.z));
  }
  // close
  const first = outer[0];
  const enu0 = llToEnu(first[1], first[0], first[2]);
  outlinePoints.push(new THREE.Vector3(enu0.x, enu0.y, enu0.z));

  const lineGeom = new THREE.BufferGeometry().setFromPoints(outlinePoints);
  const lineMat = new THREE.LineBasicMaterial({ color: color, linewidth: 3 });
  const line = new THREE.Line(lineGeom, lineMat);
  mesh.add(line);

  return mesh;
}

// ----- Compass -----
let hasAbsolute = false;
window.addEventListener('deviceorientationabsolute', (e) => {
  if (e.alpha != null) { userHeading = 360 - e.alpha; hasAbsolute = true; }
}, true);
window.addEventListener('deviceorientation', (e) => {
  if (e.webkitCompassHeading) userHeading = e.webkitCompassHeading;
  else if (e.alpha != null && !hasAbsolute) userHeading = 360 - e.alpha;
});

// iOS permission
if (typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function') {
  document.body.addEventListener('click', () => {
    DeviceOrientationEvent.requestPermission();
  }, { once: true });
}

// ----- Status loop -----
function startStatusLoop() {
  setInterval(() => {
    if (!userPos) return;
    const accClass = userPos.acc < 5 ? 'good' : userPos.acc < 15 ? 'warn' : 'bad';
    const altAccClass = !userPos.altAcc ? 'bad' : userPos.altAcc < 10 ? 'good' : 'warn';

    let html = `
      <div class="row"><span class="label">Lat</span><span>${userPos.lat.toFixed(6)}</span></div>
      <div class="row"><span class="label">Lon</span><span>${userPos.lon.toFixed(6)}</span></div>
      <div class="row"><span class="label">Alt MSL</span><span>${userPos.alt ? userPos.alt.toFixed(1) + ' m' : 'N/A'}</span></div>
      <div class="row"><span class="label">H-acc</span><span class="${accClass}">±${userPos.acc.toFixed(1)} m</span></div>
      <div class="row"><span class="label">V-acc</span><span class="${altAccClass}">${userPos.altAcc ? '±' + userPos.altAcc.toFixed(1) + ' m' : 'N/A'}</span></div>
      <div class="row"><span class="label">Heading</span><span>${userHeading.toFixed(0)}°</span></div>
      <div class="row"><span class="label">Mode</span><span>${testMode ? 'TEST (centered)' : 'REAL geo'}</span></div>
      <div class="row"><span class="label">Render R</span><span>${renderRadius} m</span></div>
    `;
    setStatus(html);
  }, 500);
}
