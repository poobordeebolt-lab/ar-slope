// =============================================
// AR Pre-Survey v10
//
// Purpose: ใช้โทรศัพท์ตรวจสอบว่าวัตถุจริง (ต้นไม้, เสาไฟ)
// เกิน OLS/OCS surfaces หรือไม่
//
// หลักการ:
//   - ข้อมูลทั้งหมด (OLS, OCS, DTM) อยู่ใน WGS84 ellipsoidal height
//   - ระดับพื้น = DTM(lat,lon) ← แม่นยำกว่า GPS altitude มาก
//   - ระดับตา = DTM + 1.6m
//   - GPS altitude ไม่ใช้ในการคำนวณ (แสดงเพื่อเปรียบเทียบเท่านั้น)
//   - Phone ใช้แค่: GPS(lat,lon) + IMU(orientation)
// =============================================

// --- Data ---
let userPos = null;
let userHeading = 0;
let olsData = null;           // OLS GeoJSON FeatureCollection
let ocsData = null;           // OCS GeoJSON FeatureCollection
let dtmHeader = null;
let dtmData = null;
let heightBlockData = null;

// --- Settings ---
let renderRadius = 8000;
let blockRadius = 2000;
let terrainRadius = 1000;
let testMode = false;
const EYE_HEIGHT = 1.6;      // ความสูงตาจากพื้น (m)

// --- Layer toggles ---
let showOLS = true;
let showOCS = true;
let showTerrain = true;
let showBlocks = true;
let showLabels = true;

// --- Computed state ---
let headingOffset = 0;
let manualGroundElip = 18;    // fallback ถ้า DTM ไม่มีข้อมูล
let userGroundElip = null;    // DTM value ณ ตำแหน่ง user (ellipsoidal)
let userEyeElip = null;       // userGroundElip + EYE_HEIGHT
let groundOffset = 0;
let anchorPos = null;

// --- Precomputed features ---
let allOlsFeatures = [];
let allOcsFeatures = [];
let allBlocksEnu = [];

// --- Three.js ---
let renderer, scene, camera, worldGroup;
let olsMeshes = [];
let ocsMeshes = [];
let blockMeshes = [];
let labelSprites = [];
let terrainMesh = null;

// --- Colors ---
const OLS_COLORS = {
  'inner horizontal': 0x3b82f6,
  'conical':          0x8b5cf6,
  'approach':         0x22c55e,
  'take-off':         0xf59e0b,
  'takeoff':          0xf59e0b,
  'transitional':     0xec4899,
  'default':          0x94a3b8
};

const OCS_COLORS = {
  'area 2a': 0x06b6d4,
  'area 2b': 0x0891b2,
  'area 2c': 0x0e7490,
  'area 2d': 0x155e75,
  'area 3':  0x164e63,
  'area 4':  0x083344,
  'default': 0x06b6d4
};

function getOlsColor(name) {
  if (!name) return OLS_COLORS.default;
  const lower = name.toLowerCase();
  for (const key in OLS_COLORS) {
    if (lower.includes(key)) return OLS_COLORS[key];
  }
  return OLS_COLORS.default;
}

function getOcsColor(name) {
  if (!name) return OCS_COLORS.default;
  const lower = name.toLowerCase();
  for (const key in OCS_COLORS) {
    if (lower.includes(key)) return OCS_COLORS[key];
  }
  return OCS_COLORS.default;
}

function getHeightBlockColor(maxHeight) {
  const t = Math.max(0, Math.min(1, (maxHeight + 50) / 200));
  let r, g, b;
  if (t < 0.5) { r = 1; g = t * 2; b = 0; }
  else { r = 1 - (t - 0.5) * 2; g = 1; b = 0; }
  return new THREE.Color(r, g, b);
}

// ============================================================
// Logging & Status
// ============================================================
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

function toggleLog() {
  const logEl = document.getElementById('log');
  if (logEl) logEl.style.display = logEl.style.display === 'none' ? 'block' : 'none';
}

function setStatus(html) {
  const el = document.getElementById('status');
  if (el) el.innerHTML = html;
}

// ============================================================
// File loading
// ============================================================
let dtmHeaderLoaded = false, dtmBinLoaded = false;

function checkReadyToStart() {
  const hasSurface = olsData || ocsData;
  document.getElementById('start-btn').disabled = !hasSurface;
}

document.addEventListener('DOMContentLoaded', () => {
  // OLS file
  document.getElementById('ols-file').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = (evt) => {
      try {
        olsData = JSON.parse(evt.target.result);
        if (!olsData.features) throw new Error('not FeatureCollection');
        document.getElementById('ols-status').innerHTML = `<span style="color:#4ade80">✓ ${olsData.features.length} features</span>`;
        document.getElementById('ols-label').classList.add('has-file');
        document.getElementById('ols-label').textContent = `✓ ${file.name}`;
        checkReadyToStart();
      } catch (err) {
        document.getElementById('ols-status').innerHTML = `<span style="color:#f87171">✗ ${err.message}</span>`;
      }
    };
    r.readAsText(file);
  });

  // OCS file
  document.getElementById('ocs-file').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = (evt) => {
      try {
        ocsData = JSON.parse(evt.target.result);
        if (!ocsData.features) throw new Error('not FeatureCollection');
        document.getElementById('ocs-status').innerHTML = `<span style="color:#4ade80">✓ ${ocsData.features.length} features</span>`;
        document.getElementById('ocs-label').classList.add('has-file');
        document.getElementById('ocs-label').textContent = `✓ ${file.name}`;
        checkReadyToStart();
      } catch (err) {
        document.getElementById('ocs-status').innerHTML = `<span style="color:#f87171">✗ ${err.message}</span>`;
      }
    };
    r.readAsText(file);
  });

  // DTM header
  document.getElementById('dtm-header-file').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = (evt) => {
      try {
        dtmHeader = JSON.parse(evt.target.result);
        if (!dtmHeader.bbox || !dtmHeader.width) throw new Error('invalid header');
        dtmHeaderLoaded = true;
        document.getElementById('dtm-header-label').classList.add('has-file');
        document.getElementById('dtm-header-label').textContent = `✓ ${file.name}`;
        updateDtmStatus();
      } catch (err) { document.getElementById('dtm-status').innerHTML = `<span style="color:#f87171">✗ ${err.message}</span>`; }
    };
    r.readAsText(file);
  });

  // DTM binary
  document.getElementById('dtm-bin-file').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = (evt) => {
      try {
        dtmData = new Int16Array(evt.target.result);
        dtmBinLoaded = true;
        document.getElementById('dtm-bin-label').classList.add('has-file');
        document.getElementById('dtm-bin-label').textContent = `✓ ${(evt.target.result.byteLength/1e6).toFixed(1)}MB`;
        updateDtmStatus();
      } catch (err) { document.getElementById('dtm-status').innerHTML = `<span style="color:#f87171">✗ ${err.message}</span>`; }
    };
    r.readAsArrayBuffer(file);
  });

  // Height blocks
  document.getElementById('hblock-file').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = (evt) => {
      try {
        heightBlockData = JSON.parse(evt.target.result);
        if (!heightBlockData.features) throw new Error('not FeatureCollection');
        document.getElementById('hblock-status').innerHTML = `<span style="color:#4ade80">✓ ${heightBlockData.features.length} blocks</span>`;
        document.getElementById('hblock-label').classList.add('has-file');
        document.getElementById('hblock-label').textContent = `✓ ${file.name}`;
      } catch (err) { document.getElementById('hblock-status').innerHTML = `<span style="color:#f87171">✗ ${err.message}</span>`; }
    };
    r.readAsText(file);
  });
});

function updateDtmStatus() {
  const status = document.getElementById('dtm-status');
  if (dtmHeaderLoaded && dtmBinLoaded) {
    if (dtmData.length !== dtmHeader.width * dtmHeader.height) {
      status.innerHTML = `<span style="color:#f87171">✗ size mismatch: ${dtmData.length} ≠ ${dtmHeader.width * dtmHeader.height}</span>`;
      return;
    }
    status.innerHTML = `<span style="color:#4ade80">✓ ${dtmHeader.width}×${dtmHeader.height} (ellipsoidal)</span>`;
  } else {
    status.innerHTML = '<span style="color:#fbbf24">รออีกไฟล์...</span>';
  }
}

// ============================================================
// DTM sampling — bilinear interpolation
// ============================================================
function sampleDTM(lat, lon) {
  if (!dtmHeader || !dtmData) return null;
  const { bbox, width, height, nodata } = dtmHeader;
  if (lat < bbox.south || lat > bbox.north || lon < bbox.west || lon > bbox.east) return null;
  const fx = (lon - bbox.west) / (bbox.east - bbox.west) * (width - 1);
  const fy = (bbox.north - lat) / (bbox.north - bbox.south) * (height - 1);
  const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, width - 1);
  const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, height - 1);
  const dx = fx - x0, dy = fy - y0;
  function get(x, y) {
    const v = dtmData[y * width + x];
    return v === nodata ? null : v;
  }
  const v00 = get(x0, y0), v10 = get(x1, y0), v01 = get(x0, y1), v11 = get(x1, y1);
  const valids = [v00, v10, v01, v11].filter(v => v !== null);
  if (valids.length === 0) return null;
  if (valids.length < 4) return valids.reduce((a,b)=>a+b, 0) / valids.length;
  const v0 = v00 * (1 - dx) + v10 * dx;
  const v1 = v01 * (1 - dx) + v11 * dx;
  return v0 * (1 - dy) + v1 * dy;
}

// 3×3 grid average for robust ground estimation
function sampleDTMArea(lat, lon, radiusM = 30) {
  if (!dtmHeader || !dtmData) return null;
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  const samples = [];
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const v = sampleDTM(lat + i * dLat, lon + j * dLon);
      if (v !== null) samples.push(v);
    }
  }
  if (samples.length === 0) return null;
  const sum = samples.reduce((a,b)=>a+b, 0);
  return {
    mean: sum / samples.length,
    min: Math.min(...samples),
    max: Math.max(...samples),
    n: samples.length
  };
}

// ============================================================
// Start AR
// ============================================================
async function startAR() {
  if (!olsData && !ocsData) return;
  renderRadius = parseInt(document.getElementById('render-radius').value) || 8000;
  blockRadius = parseInt(document.getElementById('block-radius').value) || 2000;
  terrainRadius = parseInt(document.getElementById('terrain-radius').value) || 1000;
  testMode = document.getElementById('test-mode').checked;
  manualGroundElip = parseFloat(document.getElementById('manual-ground').value) || 18;

  showLog('=== AR Pre-Survey v10 ===');
  showLog('หลักการ: DTM = ground truth, GPS alt = ไม่ใช้');
  showLog(`Layers: OLS=${!!olsData} OCS=${!!ocsData} DTM=${!!dtmData} Blocks=${!!heightBlockData}`);

  document.getElementById('file-input').style.display = 'none';
  document.getElementById('ui').style.display = 'block';
  document.getElementById('legend').style.display = 'flex';
  document.getElementById('minimap-container').style.display = 'block';
  document.getElementById('control-panel').style.display = 'flex';
  document.getElementById('crosshair').style.display = 'block';
  document.getElementById('aim-info').style.display = 'block';

  // Hide toggle buttons for layers that aren't loaded
  if (!olsData) document.getElementById('btn-ols').style.display = 'none';
  if (!ocsData) document.getElementById('btn-ocs').style.display = 'none';
  if (!heightBlockData) {
    document.getElementById('btn-blk').style.display = 'none';
    document.getElementById('btn-lbl').style.display = 'none';
  }

  setupSliders();

  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { await DeviceOrientationEvent.requestPermission(); } catch (e) {}
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    document.getElementById('cam-video').srcObject = stream;
    await document.getElementById('cam-video').play();
  } catch (err) {
    showLog('Camera error: ' + err.message, true);
    return;
  }

  initThree();
  startSensors();
  startStatusLoop();
  startMinimapLoop();
  startAimInfoLoop();
  waitForGPSThenRender();
  animate();
}

function setupSliders() {
  const groundSlider = document.getElementById('ground-slider');
  const groundVal = document.getElementById('ground-val');
  groundSlider.addEventListener('input', (e) => {
    groundOffset = parseFloat(e.target.value);
    groundVal.textContent = groundOffset.toFixed(1);
  });
  const headingSlider = document.getElementById('heading-slider');
  const headingVal = document.getElementById('heading-val');
  headingSlider.addEventListener('input', (e) => {
    headingOffset = parseFloat(e.target.value);
    headingVal.textContent = headingOffset.toFixed(0);
  });
}

function adjustHeadingSlider(delta) {
  headingOffset = Math.max(-180, Math.min(180, headingOffset + delta));
  document.getElementById('heading-slider').value = headingOffset;
  document.getElementById('heading-val').textContent = headingOffset.toFixed(0);
}

// ============================================================
// Three.js setup
// ============================================================
function initThree() {
  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('three-canvas'),
    alpha: true, antialias: true, logarithmicDepthBuffer: true
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100000);
  camera.position.set(0, 0, 0);
  worldGroup = new THREE.Group();
  scene.add(worldGroup);
  scene.add(new THREE.AmbientLight(0xffffff, 1.0));
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function animate() {
  requestAnimationFrame(animate);
  if (deviceOrientation) updateCameraFromOrientation();
  if (worldGroup) {
    worldGroup.rotation.y = headingOffset * Math.PI / 180;
    worldGroup.position.y = -groundOffset;
  }
  renderer.render(scene, camera);
}

// ============================================================
// Device orientation (IMU)
// ============================================================
let deviceOrientation = null;
function startSensors() {
  function handle(event) {
    deviceOrientation = {
      alpha: event.alpha, beta: event.beta, gamma: event.gamma,
      absolute: event.absolute,
      webkitCompassHeading: event.webkitCompassHeading
    };
    if (event.webkitCompassHeading != null) userHeading = event.webkitCompassHeading;
    else if (event.alpha != null) userHeading = (360 - event.alpha) % 360;
  }
  window.addEventListener('deviceorientationabsolute', handle, true);
  window.addEventListener('deviceorientation', handle, true);
}

function updateCameraFromOrientation() {
  if (!deviceOrientation) return;
  const alpha = (deviceOrientation.alpha || 0) * Math.PI / 180;
  const beta = (deviceOrientation.beta || 0) * Math.PI / 180;
  const gamma = (deviceOrientation.gamma || 0) * Math.PI / 180;
  const orient = (window.orientation || 0) * Math.PI / 180;
  const euler = new THREE.Euler();
  const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  euler.set(beta, alpha, -gamma, 'YXZ');
  camera.quaternion.setFromEuler(euler);
  camera.quaternion.multiply(q1);
  const q0 = new THREE.Quaternion();
  q0.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -orient);
  camera.quaternion.multiply(q0);
}

// ============================================================
// GPS → decide ground from DTM → render
// ============================================================
function waitForGPSThenRender() {
  showLog('รอ GPS fix...');
  setStatus('รอ GPS fix...');
  navigator.geolocation.watchPosition((pos) => {
    userPos = {
      lat: pos.coords.latitude, lon: pos.coords.longitude,
      alt: pos.coords.altitude, acc: pos.coords.accuracy,
      altAcc: pos.coords.altitudeAccuracy
    };
    if (!window._rendered) {
      showLog(`GPS: ${userPos.lat.toFixed(6)}, ${userPos.lon.toFixed(6)} ±${userPos.acc.toFixed(0)}m`);
      if (userPos.alt != null) {
        showLog(`GPS alt (ellipsoidal, ไม่ใช้): ${userPos.alt.toFixed(1)}m ±${(userPos.altAcc||'?')}m`);
      }
      decideAnchorAndRender();
      window._rendered = true;
      setTimeout(() => { const l = document.getElementById('log'); if (l) l.style.display = 'none'; }, 15000);
    }
  }, (err) => showLog('GPS error: ' + err.message, true),
  { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function decideAnchorAndRender() {
  // Test mode: shift data to user's position
  if (testMode) {
    const allData = [olsData, ocsData].filter(Boolean);
    const c = computeFeaturesCentroid(allData[0]);
    if (c) {
      const dLat = userPos.lat - c.lat, dLon = userPos.lon - c.lon;
      allData.forEach(d => shiftAllCoords(d, dLat, dLon));
      if (heightBlockData) shiftAllCoords(heightBlockData, dLat, dLon);
      showLog('Test: shifted all data to user position');
    }
  }

  anchorPos = { lat: userPos.lat, lon: userPos.lon };

  // ★ หลักการสำคัญ: ใช้ DTM เป็น ground truth แทน GPS altitude
  const sampleResult = sampleDTMArea(anchorPos.lat, anchorPos.lon, 30);
  if (sampleResult !== null) {
    userGroundElip = sampleResult.mean;
    showLog(`✓ DTM ground (ellipsoidal): ${userGroundElip.toFixed(2)}m`);
    showLog(`  3×3 range: ${sampleResult.min.toFixed(1)}–${sampleResult.max.toFixed(1)}m (n=${sampleResult.n})`);
    if (userPos.alt != null) {
      const diff = userPos.alt - userGroundElip;
      showLog(`  GPS vs DTM ต่างกัน: ${diff.toFixed(1)}m (GPS ไม่แม่นยำ)`);
    }
  } else {
    userGroundElip = manualGroundElip;
    showLog(`⚠ DTM ไม่มีข้อมูลตรงนี้ → ใช้ fallback: ${userGroundElip}m`, true);
  }

  userEyeElip = userGroundElip + EYE_HEIGHT;
  showLog(`ระดับตา (ellipsoidal): ${userEyeElip.toFixed(2)}m`);

  // Precompute & render
  if (olsData) precomputeFeatures(olsData, allOlsFeatures, getOlsColor);
  if (ocsData) precomputeFeatures(ocsData, allOcsFeatures, getOcsColor);
  if (heightBlockData) precomputeBlocks();
  renderAll();
}

function renderAll() {
  if (olsData) renderSurfaceLayer(allOlsFeatures, olsMeshes, 'ols', 0.35);
  if (ocsData) renderSurfaceLayer(allOcsFeatures, ocsMeshes, 'ocs', 0.30);
  if (heightBlockData) renderHeightBlocks();
  if (dtmData) renderTerrain();
  applyVisibility();
  printSurfaceSummary();
}

function applyVisibility() {
  olsMeshes.forEach(m => m.visible = showOLS);
  ocsMeshes.forEach(m => m.visible = showOCS);
  blockMeshes.forEach(m => m.visible = showBlocks);
  labelSprites.forEach(s => s.visible = showBlocks && showLabels);
  if (terrainMesh) terrainMesh.visible = showTerrain;
}

function printSurfaceSummary() {
  showLog('\n=== Surface Summary ===');
  showLog(`ระดับตา: ${userEyeElip.toFixed(1)}m ellip (พื้น ${userGroundElip.toFixed(1)}m)`);

  function logFeatures(features, label) {
    features.forEach(p => {
      if (p.minDist > renderRadius) return;
      let minA = Infinity, maxA = -Infinity;
      p.rings.forEach(ring => ring.forEach(([lon, lat, alt]) => {
        if (alt < minA) minA = alt;
        if (alt > maxA) maxA = alt;
      }));
      const clearance = minA - userGroundElip;
      const angle = Math.atan((minA - userEyeElip) / Math.max(p.minDist, 1)) * 180 / Math.PI;
      showLog(`[${label}] ${p.name.substring(0, 20)}: ${minA.toFixed(0)}–${maxA.toFixed(0)}m, ${p.minDist.toFixed(0)}m, clearance ${clearance.toFixed(0)}m`);
    });
  }
  logFeatures(allOlsFeatures, 'OLS');
  logFeatures(allOcsFeatures, 'OCS');
}

// ============================================================
// Coordinate helpers
// ============================================================
function computeFeaturesCentroid(geojson) {
  let sumLat=0, sumLon=0, n=0;
  function w(c){ if(typeof c[0]==='number'){sumLon+=c[0];sumLat+=c[1];n++;} else c.forEach(w); }
  geojson.features.forEach(f => w(f.geometry.coordinates));
  return n===0 ? null : { lat: sumLat/n, lon: sumLon/n };
}
function shiftAllCoords(geojson, dLat, dLon) {
  function w(c){ if(typeof c[0]==='number'){c[0]+=dLon;c[1]+=dLat;} else c.forEach(w); }
  geojson.features.forEach(f => w(f.geometry.coordinates));
}

// Convert lat/lon/ellipsoidal_alt to camera-relative position
// Y axis = up, relative to user's eye level
function llToCamRel(lat, lon, elipAlt) {
  const R = 6378137;
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLat = anchorPos.lat * Math.PI / 180;
  const east = dLon * R * Math.cos(refLat);
  const north = dLat * R;
  return { x: east, y: elipAlt - userEyeElip, z: -north };
}

function horizDist(lat, lon) {
  const R = 6378137;
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLat = anchorPos.lat * Math.PI / 180;
  const east = dLon * R * Math.cos(refLat);
  const north = dLat * R;
  return Math.sqrt(east*east + north*north);
}

// ============================================================
// Precompute & render surfaces (shared for OLS/OCS)
// ============================================================
function precomputeFeatures(geojsonData, targetArray, colorFn) {
  targetArray.length = 0;
  geojsonData.features.forEach((feat, idx) => {
    const name = feat.properties?.name || feat.properties?.Name || `Feature ${idx}`;
    const color = colorFn(name);
    let polygons = [];
    if (feat.geometry.type === 'Polygon') polygons = [feat.geometry.coordinates];
    else if (feat.geometry.type === 'MultiPolygon') polygons = feat.geometry.coordinates;
    else return;
    polygons.forEach((rings) => {
      let minDist = Infinity;
      rings.forEach(ring => ring.forEach(([lon, lat]) => {
        const d = horizDist(lat, lon);
        if (d < minDist) minDist = d;
      }));
      targetArray.push({ name, color, rings, minDist });
    });
  });
  showLog(`Precomputed: ${targetArray.length} polygons`);
}

function renderSurfaceLayer(features, meshArray, layerKind, opacity) {
  meshArray.forEach(m => worldGroup.remove(m));
  meshArray.length = 0;
  let n = 0;
  features.forEach(p => {
    if (p.minDist > renderRadius) return;
    const mesh = createPolygonMesh(p.rings, p.color, p.name, opacity, layerKind);
    if (mesh) { worldGroup.add(mesh); meshArray.push(mesh); n++; }
  });
  showLog(`${layerKind.toUpperCase()} rendered: ${n}`);
}

function createPolygonMesh(rings, color, name, opacity, kind) {
  const outer = rings[0];
  if (!outer || outer.length < 3) return null;
  const flat2D = [], pos3D = [], holeIdx = [];
  let vIdx = 0;
  rings.forEach((ring, ri) => {
    if (ri > 0) holeIdx.push(vIdx);
    const lastIdx = (ring.length > 1 &&
      ring[0][0] === ring[ring.length-1][0] &&
      ring[0][1] === ring[ring.length-1][1]) ? ring.length - 1 : ring.length;
    for (let i = 0; i < lastIdx; i++) {
      const [lon, lat, alt] = ring[i];
      const c = llToCamRel(lat, lon, alt || 0);
      flat2D.push(c.x, c.z);
      pos3D.push(c.x, c.y, c.z);
      vIdx++;
    }
  });
  const tris = earcut(flat2D, holeIdx, 2);
  if (tris.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos3D, 3));
  geom.setIndex(tris);
  geom.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: color, transparent: true, opacity: opacity,
    side: THREE.DoubleSide, depthWrite: false
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData = { name, kind };
  mesh.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    color: color, wireframe: true, transparent: true, opacity: 0.7
  })));
  const outPts = [];
  outer.forEach(([lon, lat, alt]) => {
    const c = llToCamRel(lat, lon, alt || 0);
    outPts.push(new THREE.Vector3(c.x, c.y, c.z));
  });
  mesh.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(outPts),
    new THREE.LineBasicMaterial({ color: color })
  ));
  return mesh;
}

// ============================================================
// Height blocks
// ============================================================
function precomputeBlocks() {
  allBlocksEnu = [];
  heightBlockData.features.forEach((feat) => {
    if (feat.geometry.type !== 'Polygon') return;
    const ring = feat.geometry.coordinates[0];
    if (!ring || ring.length < 3) return;
    let sumLat=0, sumLon=0, n=0;
    let minDist = Infinity;
    ring.forEach(([lon, lat]) => {
      sumLon += lon; sumLat += lat; n++;
      const d = horizDist(lat, lon);
      if (d < minDist) minDist = d;
    });
    const cLat = sumLat / n, cLon = sumLon / n;
    const maxH = parseFloat(feat.properties.max_height_allowance);
    if (isNaN(maxH)) return;
    // Block surface = DTM at center + allowed height
    let terrainElip = sampleDTM(cLat, cLon);
    if (terrainElip === null) terrainElip = userGroundElip;
    const surfaceElip = terrainElip + maxH;
    allBlocksEnu.push({
      ring, minDist, centroidLat: cLat, centroidLon: cLon,
      maxHeight: maxH, terrainElip, surfaceElip,
      name: feat.properties.Name || 'Block',
      designator: feat.properties.designator || ''
    });
  });
  showLog(`Blocks: ${allBlocksEnu.length}`);
}

function renderHeightBlocks() {
  blockMeshes.forEach(m => worldGroup.remove(m));
  blockMeshes = [];
  labelSprites.forEach(s => worldGroup.remove(s));
  labelSprites = [];
  let n = 0;
  allBlocksEnu.forEach(b => {
    if (b.minDist > blockRadius) return;
    const mesh = createBlockMesh(b);
    if (mesh) {
      worldGroup.add(mesh);
      blockMeshes.push(mesh);
      n++;
      const sprite = createLabelSprite(b);
      if (sprite) { worldGroup.add(sprite); labelSprites.push(sprite); }
    }
  });
  showLog(`Blocks rendered: ${n}`);
}

function createBlockMesh(block) {
  const ring = block.ring;
  const flat2D = [], pos3D = [];
  const lastIdx = (ring.length > 1 &&
    ring[0][0] === ring[ring.length-1][0] &&
    ring[0][1] === ring[ring.length-1][1]) ? ring.length - 1 : ring.length;
  for (let i = 0; i < lastIdx; i++) {
    const [lon, lat] = ring[i];
    let vTerrain = sampleDTM(lat, lon);
    if (vTerrain === null) vTerrain = block.terrainElip;
    // Max allowed height = terrain + allowance (all ellipsoidal)
    const vSurfaceElip = vTerrain + block.maxHeight;
    const c = llToCamRel(lat, lon, vSurfaceElip);
    flat2D.push(c.x, c.z);
    pos3D.push(c.x, c.y, c.z);
  }
  const tris = earcut(flat2D, null, 2);
  if (tris.length === 0) return null;
  const color = getHeightBlockColor(block.maxHeight);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos3D, 3));
  geom.setIndex(tris);
  geom.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: color, transparent: true, opacity: 0.5,
    side: THREE.DoubleSide, depthWrite: false
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData = {
    kind: 'block',
    name: `${block.name} ${block.designator}`,
    maxHeight: block.maxHeight,
    terrainElip: block.terrainElip,
    surfaceElip: block.surfaceElip
  };
  const outPts = [];
  for (let i = 0; i < lastIdx; i++) {
    const [lon, lat] = ring[i];
    let vTerrain = sampleDTM(lat, lon);
    if (vTerrain === null) vTerrain = block.terrainElip;
    const c = llToCamRel(lat, lon, vTerrain + block.maxHeight);
    outPts.push(new THREE.Vector3(c.x, c.y, c.z));
  }
  outPts.push(outPts[0]);
  mesh.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(outPts),
    new THREE.LineBasicMaterial({ color: color })
  ));
  return mesh;
}

function createLabelSprite(block) {
  const c = llToCamRel(block.centroidLat, block.centroidLon, block.surfaceElip);
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, 128, 64);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(block.maxHeight)), 64, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({
    map: texture, transparent: true, depthWrite: false, depthTest: false
  });
  const sprite = new THREE.Sprite(mat);
  sprite.position.set(c.x, c.y, c.z);
  const dist = Math.sqrt(c.x*c.x + c.y*c.y + c.z*c.z);
  const scale = Math.max(5, dist * 0.04);
  sprite.scale.set(scale, scale * 0.5, 1);
  sprite.userData = { kind: 'label' };
  return sprite;
}

// ============================================================
// Terrain mesh
// ============================================================
function renderTerrain() {
  if (!dtmData) return;
  if (terrainMesh) {
    worldGroup.remove(terrainMesh);
    terrainMesh.geometry.dispose();
    terrainMesh = null;
  }
  const { bbox, width, height } = dtmHeader;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(anchorPos.lat * Math.PI / 180);
  const dLat = terrainRadius / mPerDegLat;
  const dLon = terrainRadius / mPerDegLon;
  const minLat = Math.max(bbox.south, anchorPos.lat - dLat);
  const maxLat = Math.min(bbox.north, anchorPos.lat + dLat);
  const minLon = Math.max(bbox.west, anchorPos.lon - dLon);
  const maxLon = Math.min(bbox.east, anchorPos.lon + dLon);
  const px0 = Math.max(0, Math.floor((minLon - bbox.west) / (bbox.east - bbox.west) * (width - 1)));
  const px1 = Math.min(width - 1, Math.ceil((maxLon - bbox.west) / (bbox.east - bbox.west) * (width - 1)));
  const py0 = Math.max(0, Math.floor((bbox.north - maxLat) / (bbox.north - bbox.south) * (height - 1)));
  const py1 = Math.min(height - 1, Math.ceil((bbox.north - minLat) / (bbox.north - bbox.south) * (height - 1)));
  const cols = px1 - px0 + 1;
  const rows = py1 - py0 + 1;
  showLog(`Terrain: ${cols}×${rows}`);
  if (cols < 2 || rows < 2) return;
  if (cols * rows > 50000) {
    showLog('Terrain too large', true);
    return;
  }
  const positions = [];
  const indices = [];
  const colors = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = px0 + col;
      const y = py0 + row;
      const lon = bbox.west + (x / (width - 1)) * (bbox.east - bbox.west);
      const lat = bbox.north - (y / (height - 1)) * (bbox.north - bbox.south);
      let alt = dtmData[y * width + x];
      if (alt === dtmHeader.nodata) alt = userGroundElip;
      const c = llToCamRel(lat, lon, alt);
      positions.push(c.x, c.y, c.z);
      const eleNorm = Math.max(0, Math.min(1, (alt - 0) / 200));
      const tcol = new THREE.Color();
      tcol.setHSL(0.3 - eleNorm * 0.2, 0.5, 0.4 + eleNorm * 0.2);
      colors.push(tcol.r, tcol.g, tcol.b);
    }
  }
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const a = row * cols + col;
      const b = row * cols + col + 1;
      const c = (row + 1) * cols + col;
      const d = (row + 1) * cols + col + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide
  });
  terrainMesh = new THREE.Mesh(geom, mat);
  terrainMesh.userData = { kind: 'terrain' };
  worldGroup.add(terrainMesh);
  const wireMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, wireframe: true, transparent: true, opacity: 0.18
  });
  terrainMesh.add(new THREE.Mesh(geom, wireMat));
  showLog('Terrain rendered');
}

// ============================================================
// SNAP terrain to feet
// ============================================================
function snapTerrainToFeet() {
  if (!dtmData || !anchorPos) {
    showLog('SNAP: ไม่มี DTM', true);
    return;
  }
  const dtmAt = sampleDTM(anchorPos.lat, anchorPos.lon);
  if (dtmAt === null) {
    showLog('SNAP: nodata ที่ตำแหน่ง user', true);
    return;
  }
  showLog(`SNAP: DTM ณ user = ${dtmAt.toFixed(2)}m`);
  showLog(`  ground ปัจจุบัน = ${userGroundElip.toFixed(2)}m`);
  const newOffset = userGroundElip - dtmAt;
  groundOffset = newOffset;
  document.getElementById('ground-slider').value = groundOffset;
  document.getElementById('ground-val').textContent = groundOffset.toFixed(1);
  showLog(`SNAP: groundOffset → ${groundOffset.toFixed(2)}`);
}

// ============================================================
// Layer toggles
// ============================================================
function toggleLayer(name) {
  const toggleMap = {
    ols:     { flag: 'showOLS',     meshes: () => olsMeshes,  btn: 'btn-ols' },
    ocs:     { flag: 'showOCS',     meshes: () => ocsMeshes,  btn: 'btn-ocs' },
    terrain: { flag: 'showTerrain', meshes: () => terrainMesh ? [terrainMesh] : [], btn: 'btn-ter' },
    blocks:  { flag: 'showBlocks',  meshes: () => blockMeshes, btn: 'btn-blk' },
    labels:  { flag: 'showLabels',  meshes: () => labelSprites, btn: 'btn-lbl' }
  };
  const t = toggleMap[name];
  if (!t) return;

  // Toggle the flag
  if (name === 'ols') { showOLS = !showOLS; }
  else if (name === 'ocs') { showOCS = !showOCS; }
  else if (name === 'terrain') { showTerrain = !showTerrain; }
  else if (name === 'blocks') { showBlocks = !showBlocks; }
  else if (name === 'labels') { showLabels = !showLabels; }

  // Apply visibility
  if (name === 'labels' || name === 'blocks') {
    blockMeshes.forEach(m => m.visible = showBlocks);
    labelSprites.forEach(s => s.visible = showBlocks && showLabels);
    document.getElementById('btn-blk').classList.toggle('off', !showBlocks);
    document.getElementById('btn-lbl').classList.toggle('off', !showLabels);
  } else {
    t.meshes().forEach(m => m.visible = window[t.flag]);
    document.getElementById(t.btn).classList.toggle('off', !window[t.flag]);
  }
}

// ============================================================
// Status loop — shows key info for pre-survey
// ============================================================
function startStatusLoop() {
  setInterval(() => {
    if (!userPos) return;
    const accClass = userPos.acc < 5 ? 'good' : userPos.acc < 15 ? 'warn' : 'bad';
    const gpsAltStr = userPos.alt != null ? `${userPos.alt.toFixed(1)}m` : '—';
    const dtmStr = userGroundElip != null ? `${userGroundElip.toFixed(1)}m` : '—';
    const eyeStr = userEyeElip != null ? `${userEyeElip.toFixed(1)}m` : '—';

    let html = `
      <div class="row"><span class="label">Pos</span><span>${userPos.lat.toFixed(6)}, ${userPos.lon.toFixed(6)}</span></div>
      <div class="row"><span class="label">GPS acc</span><span class="${accClass}">±${userPos.acc.toFixed(0)}m</span></div>
      <div class="row"><span class="label">Heading</span><span>${userHeading.toFixed(0)}° (off ${headingOffset.toFixed(0)}°)</span></div>
      <div class="row"><span class="label">DTM พื้น (ellip)</span><span class="good">${dtmStr}</span></div>
      <div class="row"><span class="label">GPS alt (ref)</span><span style="opacity:0.5">${gpsAltStr}</span></div>
      <div class="row"><span class="label">ระดับตา (ellip)</span><span>${eyeStr}</span></div>
      <div class="row"><span class="label">G offset</span><span>${groundOffset.toFixed(1)}m</span></div>
    `;
    setStatus(html);
  }, 500);
}

// ============================================================
// Aim info — crosshair raycast with clearance data
// ============================================================
function startAimInfoLoop() {
  const aimEl = document.getElementById('aim-info');
  setInterval(() => {
    if (!camera || !worldGroup) return;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    raycaster.far = 50000;

    const olsTargets = [], ocsTargets = [], blockTargets = [], terrainTargets = [];
    olsMeshes.forEach(m => {
      if (!m.visible) return;
      olsTargets.push(m);
      m.children.forEach(c => { if (c.type === 'Mesh') olsTargets.push(c); });
    });
    ocsMeshes.forEach(m => {
      if (!m.visible) return;
      ocsTargets.push(m);
      m.children.forEach(c => { if (c.type === 'Mesh') ocsTargets.push(c); });
    });
    blockMeshes.forEach(m => { if (m.visible) blockTargets.push(m); });
    if (terrainMesh && terrainMesh.visible) {
      terrainTargets.push(terrainMesh);
      terrainMesh.children.forEach(c => { if (c.type === 'Mesh') terrainTargets.push(c); });
    }

    let lines = [];

    // OLS hit
    const olsHits = raycaster.intersectObjects(olsTargets, false);
    if (olsHits.length > 0) {
      const h = olsHits[0];
      const surfElip = h.point.y + groundOffset + userEyeElip;
      const clearanceFromGround = surfElip - userGroundElip;
      const obj = h.object.userData?.kind === 'ols' ? h.object : h.object.parent;
      const name = (obj?.userData?.name || 'OLS Surface').substring(0, 20);
      lines.push(`OLS: ${name}`);
      lines.push(`  ${h.distance.toFixed(0)}m  ${surfElip.toFixed(0)}m ellip`);
      lines.push(`  clearance: ${clearanceFromGround.toFixed(0)}m above ground`);
    }

    // OCS hit
    const ocsHits = raycaster.intersectObjects(ocsTargets, false);
    if (ocsHits.length > 0) {
      const h = ocsHits[0];
      const surfElip = h.point.y + groundOffset + userEyeElip;
      const clearanceFromGround = surfElip - userGroundElip;
      const obj = h.object.userData?.kind === 'ocs' ? h.object : h.object.parent;
      const name = (obj?.userData?.name || 'OCS Surface').substring(0, 20);
      lines.push(`─────────`);
      lines.push(`OCS: ${name}`);
      lines.push(`  ${h.distance.toFixed(0)}m  ${surfElip.toFixed(0)}m ellip`);
      lines.push(`  clearance: ${clearanceFromGround.toFixed(0)}m above ground`);
    }

    // Block hit
    const bHits = raycaster.intersectObjects(blockTargets, false);
    if (bHits.length > 0) {
      const h = bHits[0];
      const ud = h.object.userData;
      lines.push(`─────────`);
      lines.push(`BLK: ${ud.name}`);
      lines.push(`  allow: ${ud.maxHeight}m above DTM`);
      lines.push(`  top:   ${ud.surfaceElip.toFixed(0)}m ellip`);
      lines.push(`  DTM:   ${ud.terrainElip.toFixed(0)}m ellip`);
    }

    // Terrain hit
    const tHits = raycaster.intersectObjects(terrainTargets, false);
    if (tHits.length > 0) {
      const h = tHits[0];
      const terElip = h.point.y + groundOffset + userEyeElip;
      lines.push(`─────────`);
      lines.push(`DTM: ${terElip.toFixed(0)}m ellip  ${h.distance.toFixed(0)}m`);
    }

    aimEl.textContent = lines.length > 0 ? lines.join('\n') : '— ไม่ได้เล็ง surface —';
  }, 200);
}

// ============================================================
// Minimap
// ============================================================
function startMinimapLoop() {
  const canvas = document.getElementById('minimap');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  function draw() {
    if (!anchorPos) { requestAnimationFrame(draw); return; }
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, W, H);
    const cx = W/2, cy = H/2;
    const margin = 10;
    const scale = (Math.min(W, H)/2 - margin) / renderRadius;

    // Grid circles
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.3)';
    ctx.lineWidth = 1;
    for (let r = 1000; r <= renderRadius; r += 1000) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Compass
    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, 12);
    ctx.fillText('S', cx, H - 4);
    ctx.fillText('E', W - 8, cy + 4);
    ctx.fillText('W', 8, cy + 4);

    const headingRad = (userHeading - headingOffset) * Math.PI / 180;

    function drawFeatures(features) {
      features.forEach(p => {
        const colorHex = '#' + p.color.toString(16).padStart(6, '0');
        ctx.strokeStyle = colorHex;
        ctx.fillStyle = colorHex + '40';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const ring = p.rings[0];
        ring.forEach(([lon, lat, alt], i) => {
          const c = llToCamRel(lat, lon, alt || 0);
          const rx = c.x * Math.cos(-headingRad) - (-c.z) * Math.sin(-headingRad);
          const ry = c.x * Math.sin(-headingRad) + (-c.z) * Math.cos(-headingRad);
          const px = cx + rx * scale;
          const py = cy - ry * scale;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      });
    }

    drawFeatures(allOlsFeatures);
    drawFeatures(allOcsFeatures);

    // User dot
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();

    // North arrow
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy - 8);
    ctx.lineTo(cx, cy - 12);
    ctx.lineTo(cx + 4, cy - 8);
    ctx.stroke();

    requestAnimationFrame(draw);
  }
  draw();
}
