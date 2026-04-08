// =============================================
// AR OLS Surface Viewer - Fixed file handling
// =============================================

let userPos = null;
let userHeading = 0;
let surfaceData = null;
let renderRadius = 5000;
let testMode = false;
let anchorPos = null;
let scene = null;
let surfacesEntity = null;

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

// ----- Logging visible on screen -----
function showLog(msg, isError = false) {
  console.log(msg);
  const logEl = document.getElementById('log');
  if (logEl) {
    logEl.style.display = 'block';
    logEl.style.color = isError ? '#f87171' : '#4ade80';
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function hideLog() {
  const logEl = document.getElementById('log');
  if (logEl) logEl.style.display = 'none';
}

function setFileStatus(html, color = '#fbbf24') {
  const el = document.getElementById('file-status');
  if (el) {
    el.innerHTML = html;
    el.style.color = color;
  }
}

// ----- File selection -----
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('geojson-file');
  const fileLabel = document.getElementById('file-label');
  const startBtn = document.getElementById('start-btn');

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) {
      setFileStatus('ยังไม่ได้เลือกไฟล์');
      startBtn.disabled = true;
      fileLabel.classList.remove('has-file');
      return;
    }

    setFileStatus(`กำลังโหลด: ${file.name}...`, '#fbbf24');

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        surfaceData = JSON.parse(evt.target.result);
        if (!surfaceData.features || !Array.isArray(surfaceData.features)) {
          throw new Error('ไม่ใช่ FeatureCollection');
        }
        const numFeatures = surfaceData.features.length;
        let totalVerts = 0;
        function countV(c) {
          if (typeof c[0] === 'number') return 1;
          return c.reduce((s, x) => s + countV(x), 0);
        }
        surfaceData.features.forEach(f => totalVerts += countV(f.geometry.coordinates));

        setFileStatus(
          `✓ โหลดสำเร็จ<br>` +
          `📄 ${file.name}<br>` +
          `🔢 ${numFeatures} features, ${totalVerts} vertices`,
          '#4ade80'
        );
        fileLabel.classList.add('has-file');
        fileLabel.textContent = `✓ ${file.name}`;
        startBtn.disabled = false;
      } catch (err) {
        setFileStatus(`✗ ไฟล์ผิดพลาด: ${err.message}`, '#f87171');
        startBtn.disabled = true;
        fileLabel.classList.remove('has-file');
        surfaceData = null;
      }
    };
    reader.onerror = () => {
      setFileStatus('✗ อ่านไฟล์ไม่ได้', '#f87171');
      startBtn.disabled = true;
    };
    reader.readAsText(file);
  });
});

// ----- Start AR -----
function startAR() {
  if (!surfaceData) {
    alert('กรุณาเลือกไฟล์ GeoJSON ก่อน');
    return;
  }

  renderRadius = parseInt(document.getElementById('render-radius').value) || 5000;
  testMode = document.getElementById('test-mode').checked;

  showLog('=== Starting AR ===');
  showLog(`Mode: ${testMode ? 'TEST' : 'REAL GEO'}`);
  showLog(`Render radius: ${renderRadius} m`);
  showLog(`Features: ${surfaceData.features.length}`);

  // Hide file picker, show AR
  document.getElementById('file-input').style.display = 'none';
  document.getElementById('ui').style.display = 'block';
  document.getElementById('legend').style.display = 'flex';
  document.getElementById('scene').style.display = 'block';

  scene = document.querySelector('a-scene');
  surfacesEntity = document.getElementById('surfaces');

  startStatusLoop();
  waitForGPSThenRender();
}

// ----- GPS handling -----
function waitForGPSThenRender() {
  setStatus('รอ GPS fix...');
  showLog('Waiting for GPS...');

  if (!navigator.geolocation) {
    showLog('GPS not supported!', true);
    return;
  }

  navigator.geolocation.watchPosition((pos) => {
    userPos = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      alt: pos.coords.altitude,
      acc: pos.coords.accuracy,
      altAcc: pos.coords.altitudeAccuracy
    };
    if (!window._rendered) {
      showLog(`GPS fix: ${userPos.lat.toFixed(5)}, ${userPos.lon.toFixed(5)}`);
      showLog(`Accuracy: ±${userPos.acc.toFixed(0)} m`);
      decideAnchorAndRender();
      window._rendered = true;
      // Hide log after 5 sec
      setTimeout(hideLog, 5000);
    }
  }, (err) => {
    setStatus('GPS error: ' + err.message);
    showLog('GPS error: ' + err.message, true);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function decideAnchorAndRender() {
  if (testMode) {
    const centroid = computeFeaturesCentroid(surfaceData);
    if (centroid) {
      const shiftLat = userPos.lat - centroid.lat;
      const shiftLon = userPos.lon - centroid.lon;
      showLog(`Test mode: shift surfaces ${shiftLat.toFixed(4)}, ${shiftLon.toFixed(4)}`);
      shiftAllCoords(surfaceData, shiftLat, shiftLon);
    }
  }
  anchorPos = { lat: userPos.lat, lon: userPos.lon };

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

// Lat/Lon to local ENU meters relative to anchor
function llToEnu(lat, lon, alt) {
  const R = 6378137;
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLatRad = anchorPos.lat * Math.PI / 180;
  const east  = dLon * R * Math.cos(refLatRad);
  const north = dLat * R;
  const up = (alt || 0) - (userPos.alt || 0);
  return { x: east, y: up, z: -north };
}

function horizDistFromAnchor(lat, lon) {
  const R = 6378137;
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLatRad = anchorPos.lat * Math.PI / 180;
  const east  = dLon * R * Math.cos(refLatRad);
  const north = dLat * R;
  return Math.sqrt(east*east + north*north);
}

// ----- Renderer -----
function renderSurfaces() {
  if (!surfaceData) return;
  setStatus('กำลังสร้าง mesh...');

  if (!window.THREE || !scene || !scene.object3D || !surfacesEntity || !surfacesEntity.object3D) {
    showLog('Waiting for THREE/A-Frame...');
    setTimeout(renderSurfaces, 200);
    return;
  }

  let polyCount = 0;
  let totalTris = 0;
  let skipped = 0;

  surfaceData.features.forEach((feat, idx) => {
    const name = feat.properties?.name || `Feature ${idx}`;
    const color = getSurfaceColor(name);
    const geom = feat.geometry;

    let polygons = [];
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
      } else {
        skipped++;
      }
    });
  });

  showLog(`✓ Rendered: ${polyCount} polygons, ${totalTris} triangles`);
  if (skipped > 0) showLog(`Skipped (out of range): ${skipped}`);
  setStatus(`✓ ${polyCount} polygons, ${totalTris} tris`);
}

function createPolygonMesh(rings, color, name) {
  const outer = rings[0];
  if (!outer || outer.length < 3) return null;

  // Check range
  let inRange = false;
  let minDist = Infinity;
  for (const v of outer) {
    const d = horizDistFromAnchor(v[1], v[0]);
    if (d < minDist) minDist = d;
    if (d < renderRadius) inRange = true;
  }
  if (!inRange) {
    showLog(`✗ ${name}: ${minDist.toFixed(0)}m away (>${renderRadius}m)`);
    return null;
  }

  const flatCoords2D = [];
  const positions3D = [];
  const holeIndices = [];

  let vertIdx = 0;
  rings.forEach((ring, ringIdx) => {
    if (ringIdx > 0) holeIndices.push(vertIdx);
    const lastIdx = (ring.length > 1 &&
      ring[0][0] === ring[ring.length-1][0] &&
      ring[0][1] === ring[ring.length-1][1])
      ? ring.length - 1 : ring.length;

    for (let i = 0; i < lastIdx; i++) {
      const [lon, lat, alt] = ring[i];
      const enu = llToEnu(lat, lon, alt);
      flatCoords2D.push(enu.x, enu.z);
      positions3D.push(enu.x, enu.y, enu.z);
      vertIdx++;
    }
  });

  const triangles = earcut(flatCoords2D, holeIndices, 2);
  if (triangles.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions3D, 3));
  geometry.setIndex(triangles);
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    color: color,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
    depthWrite: false
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.name = name;
  mesh.userData.triCount = triangles.length / 3;

  // Wireframe
  const wireMat = new THREE.MeshBasicMaterial({
    color: color,
    wireframe: true,
    transparent: true,
    opacity: 0.7
  });
  const wireMesh = new THREE.Mesh(geometry, wireMat);
  mesh.add(wireMesh);

  // Outline of outer ring
  const outlinePts = [];
  for (let i = 0; i < outer.length; i++) {
    const [lon, lat, alt] = outer[i];
    const enu = llToEnu(lat, lon, alt);
    outlinePts.push(new THREE.Vector3(enu.x, enu.y, enu.z));
  }
  const lineGeom = new THREE.BufferGeometry().setFromPoints(outlinePts);
  const lineMat = new THREE.LineBasicMaterial({ color: color });
  const line = new THREE.Line(lineGeom, lineMat);
  mesh.add(line);

  showLog(`✓ ${name}: ${(triangles.length/3)} tris`);
  return mesh;
}

function setStatus(html) {
  const el = document.getElementById('status');
  if (el) el.innerHTML = html;
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
    let html = `
      <div class="row"><span class="label">Lat</span><span>${userPos.lat.toFixed(6)}</span></div>
      <div class="row"><span class="label">Lon</span><span>${userPos.lon.toFixed(6)}</span></div>
      <div class="row"><span class="label">Alt</span><span>${userPos.alt ? userPos.alt.toFixed(1) + ' m' : 'N/A'}</span></div>
      <div class="row"><span class="label">H-acc</span><span class="${accClass}">±${userPos.acc.toFixed(1)} m</span></div>
      <div class="row"><span class="label">Heading</span><span>${userHeading.toFixed(0)}°</span></div>
      <div class="row"><span class="label">Mode</span><span>${testMode ? 'TEST' : 'REAL'}</span></div>
    `;
    setStatus(html);
  }, 500);
}
