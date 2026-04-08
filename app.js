// =============================================
// AR OLS Surface Viewer v7
// + Height block grid (gradient color + labels)
// + Terrain mesh from DTM (1km radius)
// + HUD shows: surface + block max_height + terrain
// =============================================

let userPos = null;
let userHeading = 0;
let surfaceData = null;
let dtmHeader = null;
let dtmData = null;
let heightBlockData = null;
let renderRadius = 8000;
let blockRadius = 2000;
let terrainRadius = 1000;
let testMode = false;
let showDebugMarkers = true;
let showTerrain = true;
let showBlocks = true;
let showLabels = true;
let surfaceOffsetY = 0;
let headingOffset = 0;
let manualGroundMSL = 30;
let userGroundMSL = null;
let anchorPos = null;
let allFeaturesEnu = [];
let allBlocksEnu = [];

let renderer, scene, camera, worldGroup;
let surfaceMeshes = [];
let blockMeshes = [];
let labelSprites = [];
let terrainMesh = null;

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

// Gradient: red (low/negative) → yellow → green (high)
// Range: -80 to +145 in the file
function getHeightBlockColor(maxHeight) {
  // Normalize to 0..1 with -50 = red, 0 = orange, 50 = yellow, 100+ = green
  const t = Math.max(0, Math.min(1, (maxHeight + 50) / 200));
  // Linear gradient: red(0) → yellow(0.5) → green(1)
  let r, g, b;
  if (t < 0.5) {
    // red → yellow
    r = 1; g = t * 2; b = 0;
  } else {
    // yellow → green
    r = 1 - (t - 0.5) * 2; g = 1; b = 0;
  }
  return new THREE.Color(r, g, b);
}

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
  document.getElementById('start-btn').disabled = !surfaceData;
}

document.addEventListener('DOMContentLoaded', () => {
  // OLS
  document.getElementById('geojson-file').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = (evt) => {
      try {
        surfaceData = JSON.parse(evt.target.result);
        if (!surfaceData.features) throw new Error('not FeatureCollection');
        document.getElementById('ols-status').innerHTML =
          `<span style="color:#4ade80">✓ ${file.name} (${surfaceData.features.length} features)</span>`;
        document.getElementById('ols-label').classList.add('has-file');
        document.getElementById('ols-label').textContent = `✓ ${file.name}`;
        checkReadyToStart();
      } catch (err) {
        document.getElementById('ols-status').innerHTML = `<span style="color:#f87171">✗ ${err.message}</span>`;
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
      } catch (err) {
        document.getElementById('dtm-status').innerHTML = `<span style="color:#f87171">✗ ${err.message}</span>`;
      }
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
        document.getElementById('dtm-bin-label').textContent = `✓ ${file.name} (${(evt.target.result.byteLength/1e6).toFixed(1)}MB)`;
        updateDtmStatus();
      } catch (err) {
        document.getElementById('dtm-status').innerHTML = `<span style="color:#f87171">✗ ${err.message}</span>`;
      }
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
        // Verify max_height_allowance exists
        const sample = heightBlockData.features[0];
        if (!sample.properties || sample.properties.max_height_allowance === undefined) {
          throw new Error('missing max_height_allowance property');
        }
        document.getElementById('hblock-status').innerHTML =
          `<span style="color:#4ade80">✓ ${file.name} (${heightBlockData.features.length} blocks)</span>`;
        document.getElementById('hblock-label').classList.add('has-file');
        document.getElementById('hblock-label').textContent = `✓ ${file.name}`;
      } catch (err) {
        document.getElementById('hblock-status').innerHTML = `<span style="color:#f87171">✗ ${err.message}</span>`;
      }
    };
    r.readAsText(file);
  });
});

function updateDtmStatus() {
  const status = document.getElementById('dtm-status');
  if (dtmHeaderLoaded && dtmBinLoaded) {
    if (dtmData.length !== dtmHeader.width * dtmHeader.height) {
      status.innerHTML = `<span style="color:#f87171">✗ size mismatch</span>`;
      return;
    }
    status.innerHTML = `<span style="color:#4ade80">✓ DTM ${dtmHeader.width}×${dtmHeader.height}</span>`;
  } else {
    status.innerHTML = '<span style="color:#fbbf24">รออีกไฟล์...</span>';
  }
}

// ============================================================
// DTM sampling
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

// ============================================================
// Start AR
// ============================================================
async function startAR() {
  if (!surfaceData) return;
  renderRadius = parseInt(document.getElementById('render-radius').value) || 8000;
  blockRadius = parseInt(document.getElementById('block-radius').value) || 2000;
  terrainRadius = parseInt(document.getElementById('terrain-radius').value) || 1000;
  testMode = document.getElementById('test-mode').checked;
  showDebugMarkers = document.getElementById('debug-markers').checked;
  showTerrain = document.getElementById('show-terrain').checked;
  showBlocks = document.getElementById('show-blocks').checked;
  showLabels = document.getElementById('show-labels').checked;
  manualGroundMSL = parseFloat(document.getElementById('manual-ground').value) || 30;

  showLog('=== AR v7 ===');
  showLog(`DTM: ${dtmData ? '✓' : '✗'}, Blocks: ${heightBlockData ? '✓' : '✗'}`);

  document.getElementById('file-input').style.display = 'none';
  document.getElementById('ui').style.display = 'block';
  document.getElementById('legend').style.display = 'flex';
  document.getElementById('minimap-container').style.display = 'block';
  document.getElementById('floating-ctrl').style.display = 'flex';
  document.getElementById('crosshair').style.display = 'block';
  document.getElementById('aim-info').style.display = 'block';

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
  if (worldGroup) worldGroup.rotation.y = headingOffset * Math.PI / 180;
  renderer.render(scene, camera);
}

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
// GPS & render orchestration
// ============================================================
function waitForGPSThenRender() {
  showLog('Waiting for GPS...');
  setStatus('รอ GPS fix...');
  navigator.geolocation.watchPosition((pos) => {
    userPos = {
      lat: pos.coords.latitude, lon: pos.coords.longitude,
      alt: pos.coords.altitude, acc: pos.coords.accuracy,
      altAcc: pos.coords.altitudeAccuracy
    };
    if (!window._rendered) {
      showLog(`GPS: ${userPos.lat.toFixed(5)}, ${userPos.lon.toFixed(5)} ±${userPos.acc.toFixed(0)}m`);
      decideAnchorAndRender();
      window._rendered = true;
      setTimeout(() => {
        const logEl = document.getElementById('log');
        if (logEl) logEl.style.display = 'none';
      }, 12000);
    }
  }, (err) => showLog('GPS error: ' + err.message, true),
  { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function decideAnchorAndRender() {
  if (testMode) {
    const c = computeFeaturesCentroid(surfaceData);
    if (c) {
      const dLat = userPos.lat - c.lat, dLon = userPos.lon - c.lon;
      shiftAllCoords(surfaceData, dLat, dLon);
      if (heightBlockData) shiftAllCoords(heightBlockData, dLat, dLon);
      showLog('Test: shifted to user');
    }
  }
  anchorPos = { lat: userPos.lat, lon: userPos.lon };

  const dtmGround = sampleDTM(anchorPos.lat, anchorPos.lon);
  if (dtmGround !== null) {
    userGroundMSL = dtmGround;
    showLog(`✓ DTM ground: ${userGroundMSL.toFixed(1)}m`);
  } else {
    userGroundMSL = manualGroundMSL;
    showLog(`Manual ground: ${userGroundMSL}m`);
  }
  showLog(`Eye MSL: ${(userGroundMSL+1.6).toFixed(1)}m`);

  precomputeFeatures();
  if (heightBlockData) precomputeBlocks();
  renderSurfaces();
  if (showBlocks && heightBlockData) renderHeightBlocks();
  if (showTerrain && dtmData) renderTerrain();
  if (showDebugMarkers) renderDebugMarkers();
}

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

// World position relative to camera (camera at 0,0,0; eye at MSL = ground+1.6)
function llToCamRel(lat, lon, alt) {
  const R = 6378137;
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLat = anchorPos.lat * Math.PI / 180;
  const east = dLon * R * Math.cos(refLat);
  const north = dLat * R;
  const eyeMSL = userGroundMSL + 1.6;
  return { x: east, y: (alt || 0) - eyeMSL + surfaceOffsetY, z: -north };
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
// OLS surfaces
// ============================================================
function precomputeFeatures() {
  allFeaturesEnu = [];
  surfaceData.features.forEach((feat, idx) => {
    const name = feat.properties?.name || `Feature ${idx}`;
    const color = getSurfaceColor(name);
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
      allFeaturesEnu.push({ name, color, rings, minDist });
    });
  });
  showLog(`OLS: ${allFeaturesEnu.length} polys`);
}

function renderSurfaces() {
  surfaceMeshes.forEach(m => worldGroup.remove(m));
  surfaceMeshes = [];
  let n = 0;
  allFeaturesEnu.forEach(p => {
    if (p.minDist > renderRadius) return;
    const mesh = createPolygonMesh(p.rings, p.color, p.name, 0.4);
    if (mesh) { worldGroup.add(mesh); surfaceMeshes.push(mesh); n++; }
  });
  showLog(`Rendered OLS: ${n}`);
}

function createPolygonMesh(rings, color, name, opacity) {
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
      const c = llToCamRel(lat, lon, alt);
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
  mesh.name = name;
  mesh.userData = { name, kind: 'surface' };
  mesh.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    color: color, wireframe: true, transparent: true, opacity: 0.75
  })));
  const outPts = [];
  outer.forEach(([lon, lat, alt]) => {
    const c = llToCamRel(lat, lon, alt);
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
  heightBlockData.features.forEach((feat, idx) => {
    if (feat.geometry.type !== 'Polygon') return;
    const ring = feat.geometry.coordinates[0];
    if (!ring || ring.length < 3) return;

    // Compute centroid + min dist
    let sumLat = 0, sumLon = 0, n = 0;
    let minDist = Infinity;
    ring.forEach(([lon, lat]) => {
      sumLon += lon; sumLat += lat; n++;
      const d = horizDist(lat, lon);
      if (d < minDist) minDist = d;
    });
    const cLat = sumLat / n, cLon = sumLon / n;

    const maxH = parseFloat(feat.properties.max_height_allowance);
    if (isNaN(maxH)) return;

    allBlocksEnu.push({
      ring, minDist, centroidLat: cLat, centroidLon: cLon,
      maxHeight: maxH,
      name: feat.properties.Name || 'Block',
      designator: feat.properties.designator || ''
    });
  });
  showLog(`Blocks: ${allBlocksEnu.length} total`);
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
      if (showLabels) {
        const sprite = createLabelSprite(b);
        if (sprite) { worldGroup.add(sprite); labelSprites.push(sprite); }
      }
    }
  });
  showLog(`Rendered blocks: ${n} (labels: ${labelSprites.length})`);
}

function createBlockMesh(block) {
  const ring = block.ring;
  // Sample ground at centroid for Z
  let groundMSL = sampleDTM(block.centroidLat, block.centroidLon);
  if (groundMSL === null) groundMSL = userGroundMSL;
  // Place block slightly above ground (1m) so it doesn't z-fight with terrain
  const blockMSL = groundMSL + 1;

  const flat2D = [], pos3D = [];
  const lastIdx = (ring.length > 1 &&
    ring[0][0] === ring[ring.length-1][0] &&
    ring[0][1] === ring[ring.length-1][1]) ? ring.length - 1 : ring.length;
  for (let i = 0; i < lastIdx; i++) {
    const [lon, lat] = ring[i];
    const c = llToCamRel(lat, lon, blockMSL);
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
    color: color, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthWrite: false
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData = {
    kind: 'block',
    name: `${block.name} ${block.designator}`,
    maxHeight: block.maxHeight,
    groundMSL: groundMSL
  };

  // Outline
  const outPts = [];
  for (let i = 0; i < lastIdx; i++) {
    const [lon, lat] = ring[i];
    const c = llToCamRel(lat, lon, blockMSL);
    outPts.push(new THREE.Vector3(c.x, c.y, c.z));
  }
  outPts.push(outPts[0]);
  mesh.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(outPts),
    new THREE.LineBasicMaterial({ color: color })
  ));

  return mesh;
}

// Create text label as sprite using canvas
function createLabelSprite(block) {
  let groundMSL = sampleDTM(block.centroidLat, block.centroidLon);
  if (groundMSL === null) groundMSL = userGroundMSL;
  const c = llToCamRel(block.centroidLat, block.centroidLon, groundMSL + 2);

  // Create canvas texture
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
  // Scale based on distance — labels should be ~5m wide regardless of distance
  const dist = Math.sqrt(c.x*c.x + c.y*c.y + c.z*c.z);
  const scale = Math.max(5, dist * 0.04);
  sprite.scale.set(scale, scale * 0.5, 1);
  sprite.userData = { kind: 'label' };
  return sprite;
}

// ============================================================
// Terrain mesh from DTM
// ============================================================
function renderTerrain() {
  if (!dtmData) { showLog('No DTM for terrain'); return; }
  if (terrainMesh) {
    worldGroup.remove(terrainMesh);
    terrainMesh.geometry.dispose();
    terrainMesh = null;
  }

  const { bbox, width, height, resolution_deg } = dtmHeader;
  // Convert terrainRadius (meters) to degrees roughly
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(anchorPos.lat * Math.PI / 180);
  const dLat = terrainRadius / mPerDegLat;
  const dLon = terrainRadius / mPerDegLon;

  const minLat = Math.max(bbox.south, anchorPos.lat - dLat);
  const maxLat = Math.min(bbox.north, anchorPos.lat + dLat);
  const minLon = Math.max(bbox.west, anchorPos.lon - dLon);
  const maxLon = Math.min(bbox.east, anchorPos.lon + dLon);

  const resLat = resolution_deg.lat;
  const resLon = resolution_deg.lon;

  // Compute pixel range in DTM
  const px0 = Math.max(0, Math.floor((minLon - bbox.west) / (bbox.east - bbox.west) * (width - 1)));
  const px1 = Math.min(width - 1, Math.ceil((maxLon - bbox.west) / (bbox.east - bbox.west) * (width - 1)));
  const py0 = Math.max(0, Math.floor((bbox.north - maxLat) / (bbox.north - bbox.south) * (height - 1)));
  const py1 = Math.min(height - 1, Math.ceil((bbox.north - minLat) / (bbox.north - bbox.south) * (height - 1)));

  const cols = px1 - px0 + 1;
  const rows = py1 - py0 + 1;
  showLog(`Terrain: ${cols}x${rows} cells`);

  if (cols < 2 || rows < 2) { showLog('Terrain area too small'); return; }
  if (cols * rows > 50000) {
    showLog(`Terrain too large (${cols*rows}), reduce radius`, true);
    return;
  }

  const positions = [];
  const indices = [];
  const colors = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = px0 + col;
      const y = py0 + row;
      // DTM lat/lon for this cell
      const lon = bbox.west + (x / (width - 1)) * (bbox.east - bbox.west);
      const lat = bbox.north - (y / (height - 1)) * (bbox.north - bbox.south);
      let alt = dtmData[y * width + x];
      if (alt === dtmHeader.nodata) alt = userGroundMSL;
      const c = llToCamRel(lat, lon, alt);
      positions.push(c.x, c.y, c.z);

      // Color terrain by elevation: blue (low) → green → brown (high)
      const eleNorm = Math.max(0, Math.min(1, (alt - 0) / 200));
      const tcol = new THREE.Color();
      tcol.setHSL(0.3 - eleNorm * 0.2, 0.5, 0.4 + eleNorm * 0.2);
      colors.push(tcol.r, tcol.g, tcol.b);
    }
  }

  // Build triangle indices
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
    vertexColors: true, transparent: true, opacity: 0.5,
    side: THREE.DoubleSide, wireframe: false
  });
  terrainMesh = new THREE.Mesh(geom, mat);
  terrainMesh.userData = { kind: 'terrain' };
  worldGroup.add(terrainMesh);

  // Wireframe overlay
  const wireMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, wireframe: true, transparent: true, opacity: 0.15
  });
  terrainMesh.add(new THREE.Mesh(geom, wireMat));

  showLog(`✓ Terrain rendered`);
}

// ============================================================
// Debug markers
// ============================================================
function renderDebugMarkers() {
  const dist = 30;
  const ms = [
    { x: 0, z: -dist, color: 0xff0000 },
    { x: dist, z: 0, color: 0x00ff00 },
    { x: 0, z: dist, color: 0xffff00 },
    { x: -dist, z: 0, color: 0x00ffff },
  ];
  ms.forEach(m => {
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(2, 2, 20, 8),
      new THREE.MeshBasicMaterial({ color: m.color })
    );
    pillar.position.set(m.x, 0, m.z);
    worldGroup.add(pillar);
  });
}

// ============================================================
// Controls
// ============================================================
function adjustHeight(d) {
  surfaceOffsetY += d;
  showLog(`Surf Y: ${surfaceOffsetY}`);
  // Apply only to OLS (not blocks/terrain which are tied to ground)
  surfaceMeshes.forEach(mesh => {
    const arr = mesh.geometry.attributes.position.array;
    for (let i = 1; i < arr.length; i += 3) arr[i] += d;
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.children.forEach(child => {
      if (child.type === 'Line') {
        const ca = child.geometry.attributes.position.array;
        for (let i = 1; i < ca.length; i += 3) ca[i] += d;
        child.geometry.attributes.position.needsUpdate = true;
      }
    });
  });
}

function adjustHeading(d) {
  headingOffset = (headingOffset + d) % 360;
  showLog(`Heading offset: ${headingOffset}°`);
}

function toggleLayer(name) {
  if (name === 'terrain') {
    showTerrain = !showTerrain;
    if (terrainMesh) terrainMesh.visible = showTerrain;
    showLog(`Terrain: ${showTerrain ? 'on' : 'off'}`);
  } else if (name === 'blocks') {
    showBlocks = !showBlocks;
    blockMeshes.forEach(m => m.visible = showBlocks);
    labelSprites.forEach(s => s.visible = showBlocks && showLabels);
    showLog(`Blocks: ${showBlocks ? 'on' : 'off'}`);
  } else if (name === 'labels') {
    showLabels = !showLabels;
    labelSprites.forEach(s => s.visible = showBlocks && showLabels);
    showLog(`Labels: ${showLabels ? 'on' : 'off'}`);
  }
}

// ============================================================
// Status loop
// ============================================================
function startStatusLoop() {
  setInterval(() => {
    if (!userPos) return;
    const accClass = userPos.acc < 5 ? 'good' : userPos.acc < 15 ? 'warn' : 'bad';
    let html = `
      <div class="row"><span class="label">Pos</span><span>${userPos.lat.toFixed(5)}, ${userPos.lon.toFixed(5)}</span></div>
      <div class="row"><span class="label">Acc</span><span class="${accClass}">±${userPos.acc.toFixed(0)}m</span></div>
      <div class="row"><span class="label">Hdg</span><span>${userHeading.toFixed(0)}° (off ${headingOffset}°)</span></div>
      <div class="row"><span class="label">Ground</span><span>${userGroundMSL ? userGroundMSL.toFixed(1) + 'm' : '-'}</span></div>
      <div class="row"><span class="label">OLS</span><span>${surfaceMeshes.length} | Blk: ${blockMeshes.length} | Ter: ${terrainMesh ? 'y' : 'n'}</span></div>
    `;
    setStatus(html);
  }, 500);
}

// ============================================================
// Aim info — raycast to find what crosshair is pointing at
// ============================================================
function startAimInfoLoop() {
  const aimEl = document.getElementById('aim-info');
  setInterval(() => {
    if (!camera || !worldGroup) return;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    raycaster.far = 50000;

    // Collect targets by kind
    const surfaceTargets = [];
    const blockTargets = [];
    const terrainTargets = [];
    surfaceMeshes.forEach(m => {
      surfaceTargets.push(m);
      m.children.forEach(c => { if (c.type === 'Mesh') surfaceTargets.push(c); });
    });
    blockMeshes.forEach(m => blockTargets.push(m));
    if (terrainMesh) {
      terrainTargets.push(terrainMesh);
      terrainMesh.children.forEach(c => { if (c.type === 'Mesh') terrainTargets.push(c); });
    }

    const eyeMSL = userGroundMSL + 1.6;
    let txt = '';

    // Surface
    const sHits = raycaster.intersectObjects(surfaceTargets, false);
    if (sHits.length > 0) {
      const h = sHits[0];
      const surfMSL = h.point.y + eyeMSL - surfaceOffsetY;
      const obj = h.object.parent?.userData?.kind === 'surface' ? h.object.parent : h.object;
      txt += `${obj.userData?.name || obj.name || 'Surface'}\n`;
      txt += `${h.distance.toFixed(0)}m | MSL ${surfMSL.toFixed(0)}m\n`;
    }

    // Block
    const bHits = raycaster.intersectObjects(blockTargets, false);
    if (bHits.length > 0) {
      const h = bHits[0];
      const ud = h.object.userData;
      txt += `─────────\n`;
      txt += `BLK ${ud.name || ''}\n`;
      txt += `Max H: ${ud.maxHeight}m\n`;
      txt += `Ground: ${ud.groundMSL ? ud.groundMSL.toFixed(0) : '?'}m MSL\n`;
    }

    // Terrain
    const tHits = raycaster.intersectObjects(terrainTargets, false);
    if (tHits.length > 0) {
      const h = tHits[0];
      const terMSL = h.point.y + eyeMSL;
      txt += `─────────\n`;
      txt += `Terrain ${terMSL.toFixed(0)}m MSL`;
    }

    aimEl.textContent = txt || '— ไม่ได้เล็งอะไร —';
  }, 200);
}

// ============================================================
// Mini-map
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

    ctx.strokeStyle = 'rgba(74, 222, 128, 0.3)';
    ctx.lineWidth = 1;
    for (let r = 1000; r <= renderRadius; r += 1000) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, 12);
    ctx.fillText('S', cx, H - 4);
    ctx.fillText('E', W - 8, cy + 4);
    ctx.fillText('W', 8, cy + 4);

    const headingRad = (userHeading - headingOffset) * Math.PI / 180;

    // OLS surfaces
    allFeaturesEnu.forEach(p => {
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

    // User
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
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
