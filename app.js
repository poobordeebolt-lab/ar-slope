// =============================================
// AR OLS Surface Viewer v6
// + DTM ground sampling for accurate elevation
// + HUD: crosshair, aim info
// + Compass calibration buttons
// + No auto-fit — uses real MSL throughout
// =============================================

let userPos = null;
let userHeading = 0;
let surfaceData = null;
let dtmHeader = null;
let dtmData = null; // Int16Array
let renderRadius = 8000;
let testMode = false;
let showDebugMarkers = true;
let surfaceOffsetY = 0;        // manual Y offset (use ⬆⬇)
let headingOffset = 0;          // manual heading correction (use ⟲⟳)
let manualGroundMSL = 30;
let userGroundMSL = null;       // sampled from DTM or manual
let anchorPos = null;
let allFeaturesEnu = [];

// Three.js
let renderer, scene, camera, worldGroup;
let surfaceMeshes = [];

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
let dtmHeaderLoaded = false;
let dtmBinLoaded = false;

function checkReadyToStart() {
  document.getElementById('start-btn').disabled = !surfaceData;
}

document.addEventListener('DOMContentLoaded', () => {
  // OLS file
  document.getElementById('geojson-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        surfaceData = JSON.parse(evt.target.result);
        if (!surfaceData.features) throw new Error('ไม่ใช่ FeatureCollection');
        let nv = 0;
        function cv(c) { if (typeof c[0]==='number') return 1; return c.reduce((s,x)=>s+cv(x),0); }
        surfaceData.features.forEach(f => nv += cv(f.geometry.coordinates));
        document.getElementById('ols-status').innerHTML =
          `<span style="color:#4ade80">✓ ${file.name}<br>${surfaceData.features.length} features, ${nv} verts</span>`;
        document.getElementById('ols-label').classList.add('has-file');
        document.getElementById('ols-label').textContent = `✓ OLS: ${file.name}`;
        checkReadyToStart();
      } catch (err) {
        document.getElementById('ols-status').innerHTML =
          `<span style="color:#f87171">✗ ${err.message}</span>`;
      }
    };
    reader.readAsText(file);
  });

  // DTM header
  document.getElementById('dtm-header-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        dtmHeader = JSON.parse(evt.target.result);
        if (!dtmHeader.bbox || !dtmHeader.width || !dtmHeader.height) {
          throw new Error('header ไม่ครบ');
        }
        dtmHeaderLoaded = true;
        document.getElementById('dtm-header-label').classList.add('has-file');
        document.getElementById('dtm-header-label').textContent = `✓ ${file.name}`;
        updateDtmStatus();
      } catch (err) {
        document.getElementById('dtm-status').innerHTML =
          `<span style="color:#f87171">✗ header: ${err.message}</span>`;
      }
    };
    reader.readAsText(file);
  });

  // DTM binary
  document.getElementById('dtm-bin-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const buf = evt.target.result;
        dtmData = new Int16Array(buf);
        dtmBinLoaded = true;
        document.getElementById('dtm-bin-label').classList.add('has-file');
        document.getElementById('dtm-bin-label').textContent = `✓ ${file.name} (${(buf.byteLength/1e6).toFixed(1)} MB)`;
        updateDtmStatus();
      } catch (err) {
        document.getElementById('dtm-status').innerHTML =
          `<span style="color:#f87171">✗ binary: ${err.message}</span>`;
      }
    };
    reader.readAsArrayBuffer(file);
  });
});

function updateDtmStatus() {
  const status = document.getElementById('dtm-status');
  if (dtmHeaderLoaded && dtmBinLoaded) {
    const expectedSize = dtmHeader.width * dtmHeader.height;
    if (dtmData.length !== expectedSize) {
      status.innerHTML = `<span style="color:#f87171">✗ ขนาดไม่ตรง: ${dtmData.length} vs ${expectedSize}</span>`;
      return;
    }
    status.innerHTML =
      `<span style="color:#4ade80">✓ DTM พร้อม<br>` +
      `${dtmHeader.width}×${dtmHeader.height} cells<br>` +
      `bbox: ${dtmHeader.bbox.south.toFixed(3)},${dtmHeader.bbox.west.toFixed(3)} → ${dtmHeader.bbox.north.toFixed(3)},${dtmHeader.bbox.east.toFixed(3)}` +
      `</span>`;
  } else if (dtmHeaderLoaded) {
    status.innerHTML = '<span style="color:#fbbf24">รอไฟล์ binary...</span>';
  } else {
    status.innerHTML = '<span style="color:#fbbf24">รอ header...</span>';
  }
}

// ============================================================
// DTM sampling
// ============================================================
function sampleDTM(lat, lon) {
  if (!dtmHeader || !dtmData) return null;
  const { bbox, width, height, nodata } = dtmHeader;

  if (lat < bbox.south || lat > bbox.north || lon < bbox.west || lon > bbox.east) {
    return null;
  }

  // Convert lat/lon to fractional pixel index
  // Note: DTM is row-major with row 0 = NORTH (highest lat)
  const fx = (lon - bbox.west) / (bbox.east - bbox.west) * (width - 1);
  const fy = (bbox.north - lat) / (bbox.north - bbox.south) * (height - 1);

  const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, width - 1);
  const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, height - 1);
  const dx = fx - x0, dy = fy - y0;

  function get(x, y) {
    const v = dtmData[y * width + x];
    return v === nodata ? null : v;
  }

  const v00 = get(x0, y0);
  const v10 = get(x1, y0);
  const v01 = get(x0, y1);
  const v11 = get(x1, y1);

  // If any nodata, return mean of valid neighbors
  const valids = [v00, v10, v01, v11].filter(v => v !== null);
  if (valids.length === 0) return null;
  if (valids.length < 4) return valids.reduce((a,b)=>a+b, 0) / valids.length;

  // Bilinear interpolation
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
  testMode = document.getElementById('test-mode').checked;
  showDebugMarkers = document.getElementById('debug-markers').checked;
  manualGroundMSL = parseFloat(document.getElementById('manual-ground').value) || 30;

  showLog('=== AR v6 ===');
  showLog(`Mode: ${testMode ? 'TEST' : 'REAL'}, Radius: ${renderRadius}m`);
  showLog(`DTM: ${dtmData ? 'loaded' : 'NOT loaded (using manual ground)'}`);

  document.getElementById('file-input').style.display = 'none';
  document.getElementById('ui').style.display = 'block';
  document.getElementById('legend').style.display = 'flex';
  document.getElementById('minimap-container').style.display = 'block';
  document.getElementById('floating-ctrl').style.display = 'flex';
  document.getElementById('crosshair').style.display = 'block';
  document.getElementById('aim-info').style.display = 'block';

  // iOS sensor permission
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      await DeviceOrientationEvent.requestPermission();
    } catch (e) {}
  }

  // Camera
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
  // Camera at origin (0,0,0). We'll position the world relative to this.
  // Camera Y = 0 means "user's eye level".
  camera.position.set(0, 0, 0);

  worldGroup = new THREE.Group();
  scene.add(worldGroup);
  scene.add(new THREE.AmbientLight(0xffffff, 1.0));

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  showLog('Three.js initialized');
}

function animate() {
  requestAnimationFrame(animate);
  if (deviceOrientation) updateCameraFromOrientation();
  // Apply heading offset by rotating world group around Y
  if (worldGroup) {
    worldGroup.rotation.y = headingOffset * Math.PI / 180;
  }
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
    if (event.webkitCompassHeading != null) {
      userHeading = event.webkitCompassHeading;
    } else if (event.alpha != null) {
      userHeading = (360 - event.alpha) % 360;
    }
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
// GPS + render
// ============================================================
function waitForGPSThenRender() {
  showLog('Waiting for GPS...');
  setStatus('รอ GPS fix...');
  if (!navigator.geolocation) { showLog('GPS not supported!', true); return; }

  navigator.geolocation.watchPosition((pos) => {
    userPos = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      alt: pos.coords.altitude,
      acc: pos.coords.accuracy,
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
  }, (err) => {
    showLog('GPS error: ' + err.message, true);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function decideAnchorAndRender() {
  if (testMode) {
    const c = computeFeaturesCentroid(surfaceData);
    if (c) {
      shiftAllCoords(surfaceData, userPos.lat - c.lat, userPos.lon - c.lon);
      showLog('Test: shifted to user');
    }
  }
  anchorPos = { lat: userPos.lat, lon: userPos.lon };

  // Sample DTM at user position to get accurate ground MSL
  const dtmGround = sampleDTM(anchorPos.lat, anchorPos.lon);
  if (dtmGround !== null) {
    userGroundMSL = dtmGround;
    showLog(`✓ DTM ground at user: ${userGroundMSL.toFixed(1)} m MSL`);
  } else {
    userGroundMSL = manualGroundMSL;
    showLog(`Using manual ground: ${userGroundMSL} m MSL`);
  }
  // Eye level = ground + 1.6 m (human height)
  const eyeMSL = userGroundMSL + 1.6;
  showLog(`Eye MSL: ${eyeMSL.toFixed(1)} m`);

  precomputeFeatures();
  renderSurfaces();
  if (showDebugMarkers) renderDebugMarkers();
  printSurfaceSummary();
}

function printSurfaceSummary() {
  // Print info about each surface relative to user
  showLog('\n=== Surface info from your position ===');
  const eyeMSL = userGroundMSL + 1.6;
  allFeaturesEnu.forEach(p => {
    if (p.minDist > renderRadius) return;
    // Min/max altitude in this surface
    let minA = Infinity, maxA = -Infinity;
    p.rings.forEach(ring => ring.forEach(([lon, lat, alt]) => {
      if (alt < minA) minA = alt;
      if (alt > maxA) maxA = alt;
    }));
    const heightAboveEye = minA - eyeMSL;
    const angleDeg = Math.atan(heightAboveEye / p.minDist) * 180 / Math.PI;
    showLog(`${p.name}:`);
    showLog(`  MSL: ${minA.toFixed(0)}-${maxA.toFixed(0)}m`);
    showLog(`  Dist: ${p.minDist.toFixed(0)}m, Angle: ${angleDeg.toFixed(1)}°`);
  });
}

function computeFeaturesCentroid(geojson) {
  let sumLat = 0, sumLon = 0, n = 0;
  function w(c) { if (typeof c[0]==='number'){sumLon+=c[0];sumLat+=c[1];n++;} else c.forEach(w); }
  geojson.features.forEach(f => w(f.geometry.coordinates));
  return n === 0 ? null : { lat: sumLat/n, lon: sumLon/n };
}
function shiftAllCoords(geojson, dLat, dLon) {
  function w(c) { if (typeof c[0]==='number'){c[0]+=dLon;c[1]+=dLat;} else c.forEach(w); }
  geojson.features.forEach(f => w(f.geometry.coordinates));
}

// ENU coordinates with camera at origin
// Camera eye is at MSL = userGroundMSL + 1.6
// Surface alt MSL is converted to Y relative to eye:
//   Y = surface_alt_msl - eye_msl
function llToCamRelative(lat, lon, alt) {
  const R = 6378137;
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLat = anchorPos.lat * Math.PI / 180;
  const east = dLon * R * Math.cos(refLat);
  const north = dLat * R;
  const eyeMSL = userGroundMSL + 1.6;
  const y = (alt || 0) - eyeMSL + surfaceOffsetY;
  return { x: east, y: y, z: -north };
}

function horizDistFromAnchor(lat, lon) {
  const R = 6378137;
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLat = anchorPos.lat * Math.PI / 180;
  const east = dLon * R * Math.cos(refLat);
  const north = dLat * R;
  return Math.sqrt(east*east + north*north);
}

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
        const d = horizDistFromAnchor(lat, lon);
        if (d < minDist) minDist = d;
      }));
      allFeaturesEnu.push({ name, color, rings, minDist });
    });
  });
  showLog(`Pre-computed ${allFeaturesEnu.length} polys`);
}

function renderSurfaces() {
  surfaceMeshes.forEach(m => worldGroup.remove(m));
  surfaceMeshes = [];
  let polyCount = 0, totalTris = 0, skipped = 0;
  allFeaturesEnu.forEach(p => {
    if (p.minDist > renderRadius) { skipped++; return; }
    const mesh = createPolygonMesh(p.rings, p.color, p.name);
    if (mesh) {
      worldGroup.add(mesh);
      surfaceMeshes.push(mesh);
      polyCount++;
      totalTris += mesh.userData.triCount || 0;
    }
  });
  showLog(`✓ Rendered ${polyCount} polys, ${totalTris} tris`);
}

function createPolygonMesh(rings, color, name) {
  const outer = rings[0];
  if (!outer || outer.length < 3) return null;
  const flat2D = [];
  const pos3D = [];
  const holeIdx = [];
  let vIdx = 0;
  rings.forEach((ring, ri) => {
    if (ri > 0) holeIdx.push(vIdx);
    const lastIdx = (ring.length > 1 &&
      ring[0][0] === ring[ring.length-1][0] &&
      ring[0][1] === ring[ring.length-1][1]) ? ring.length - 1 : ring.length;
    for (let i = 0; i < lastIdx; i++) {
      const [lon, lat, alt] = ring[i];
      const c = llToCamRelative(lat, lon, alt);
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
    color: color, transparent: true, opacity: 0.4,
    side: THREE.DoubleSide, depthWrite: false
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = name;
  mesh.userData = { name, triCount: tris.length / 3 };
  // Wireframe child
  mesh.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    color: color, wireframe: true, transparent: true, opacity: 0.85
  })));
  // Outline
  const outPts = [];
  outer.forEach(([lon, lat, alt]) => {
    const c = llToCamRelative(lat, lon, alt);
    outPts.push(new THREE.Vector3(c.x, c.y, c.z));
  });
  mesh.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(outPts),
    new THREE.LineBasicMaterial({ color: color })
  ));
  return mesh;
}

function renderDebugMarkers() {
  const dist = 30;
  const markers = [
    { x: 0, z: -dist, color: 0xff0000 },
    { x: dist, z: 0, color: 0x00ff00 },
    { x: 0, z: dist, color: 0xffff00 },
    { x: -dist, z: 0, color: 0x00ffff },
  ];
  markers.forEach(m => {
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(2, 2, 20, 8),
      new THREE.MeshBasicMaterial({ color: m.color })
    );
    pillar.position.set(m.x, 0, m.z); // centered at eye level
    worldGroup.add(pillar);
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(5, 12, 12),
      new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: 0.7 })
    );
    sphere.position.set(m.x, 12, m.z);
    worldGroup.add(sphere);
  });

  // TEST BOX always in front of camera (in scene, not worldGroup)
  const testBox = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xff00ff })
  );
  testBox.position.set(0, 0, -5);
  scene.add(testBox);
}

function adjustHeight(delta) {
  surfaceOffsetY += delta;
  showLog(`Surface Y offset: ${surfaceOffsetY}`);
  surfaceMeshes.forEach(mesh => {
    const arr = mesh.geometry.attributes.position.array;
    for (let i = 1; i < arr.length; i += 3) arr[i] += delta;
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.children.forEach(child => {
      if (child.type === 'Line') {
        const ca = child.geometry.attributes.position.array;
        for (let i = 1; i < ca.length; i += 3) ca[i] += delta;
        child.geometry.attributes.position.needsUpdate = true;
      }
    });
  });
}

function adjustHeading(delta) {
  headingOffset = (headingOffset + delta) % 360;
  showLog(`Heading offset: ${headingOffset}°`);
}

// ============================================================
// Status loops
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
      <div class="row"><span class="label">Eye MSL</span><span>${userGroundMSL ? (userGroundMSL+1.6).toFixed(1) + 'm' : '-'}</span></div>
      <div class="row"><span class="label">Surf-Y</span><span>${surfaceOffsetY}m</span></div>
      <div class="row"><span class="label">Meshes</span><span>${surfaceMeshes.length}</span></div>
    `;
    setStatus(html);
  }, 500);
}

// Update aim info under crosshair
function startAimInfoLoop() {
  const aimEl = document.getElementById('aim-info');
  setInterval(() => {
    if (!camera || !surfaceMeshes.length) {
      aimEl.textContent = '';
      return;
    }
    // Raycast from camera forward
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    raycaster.far = 50000;
    // Cast against all surface meshes (collect their geometries)
    const targets = [];
    surfaceMeshes.forEach(m => {
      targets.push(m);
      m.children.forEach(c => { if (c.type === 'Mesh') targets.push(c); });
    });
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length > 0) {
      const h = hits[0];
      const dist = h.distance;
      const surfMSL = h.point.y + (userGroundMSL + 1.6);
      const heightAboveEye = h.point.y;
      aimEl.textContent =
        `${h.object.parent?.name || h.object.name || '?'}\n` +
        `${dist.toFixed(0)}m | MSL ${surfMSL.toFixed(0)}m | ${heightAboveEye>=0?'+':''}${heightAboveEye.toFixed(0)}m above eye`;
    } else {
      aimEl.textContent = '— ไม่ได้เล็ง surface —';
    }
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
    if (!anchorPos || allFeaturesEnu.length === 0) {
      requestAnimationFrame(draw); return;
    }
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
    allFeaturesEnu.forEach(p => {
      const colorHex = '#' + p.color.toString(16).padStart(6, '0');
      ctx.strokeStyle = colorHex;
      ctx.fillStyle = colorHex + '40';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const ring = p.rings[0];
      ring.forEach(([lon, lat, alt], i) => {
        const c = llToCamRelative(lat, lon, alt);
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
