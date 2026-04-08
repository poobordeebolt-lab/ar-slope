// =============================================
// AR OLS Surface Viewer v5
// VANILLA: Three.js + getUserMedia + DeviceOrientation
// No AR.js, no A-Frame — full control
// =============================================

let userPos = null;
let userHeading = 0;
let userPitch = 0;
let userRoll = 0;
let surfaceData = null;
let renderRadius = 8000;
let testMode = false;
let autoFit = true;
let showDebugMarkers = true;
let surfaceOffsetY = 0;
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

function setFileStatus(html, color = '#fbbf24') {
  const el = document.getElementById('file-status');
  if (el) { el.innerHTML = html; el.style.color = color; }
}

document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('geojson-file');
  const fileLabel = document.getElementById('file-label');
  const startBtn = document.getElementById('start-btn');

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) { setFileStatus('ยังไม่ได้เลือกไฟล์'); startBtn.disabled = true; return; }
    setFileStatus(`โหลด: ${file.name}...`, '#fbbf24');
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        surfaceData = JSON.parse(evt.target.result);
        if (!surfaceData.features || !Array.isArray(surfaceData.features)) {
          throw new Error('ไม่ใช่ FeatureCollection');
        }
        let totalVerts = 0;
        function countV(c) {
          if (typeof c[0] === 'number') return 1;
          return c.reduce((s, x) => s + countV(x), 0);
        }
        surfaceData.features.forEach(f => totalVerts += countV(f.geometry.coordinates));
        setFileStatus(
          `✓ ${file.name}<br>${surfaceData.features.length} features, ${totalVerts} verts`,
          '#4ade80'
        );
        fileLabel.classList.add('has-file');
        fileLabel.textContent = `✓ ${file.name}`;
        startBtn.disabled = false;
      } catch (err) {
        setFileStatus(`✗ ${err.message}`, '#f87171');
        startBtn.disabled = true;
      }
    };
    reader.readAsText(file);
  });
});

async function startAR() {
  if (!surfaceData) return;
  renderRadius = parseInt(document.getElementById('render-radius').value) || 8000;
  testMode = document.getElementById('test-mode').checked;
  autoFit = document.getElementById('auto-fit').checked;
  showDebugMarkers = document.getElementById('debug-markers').checked;
  surfaceOffsetY = parseInt(document.getElementById('surface-offset').value) || 0;

  showLog('=== AR v5 (vanilla Three.js) ===');
  showLog(`Mode: ${testMode ? 'TEST' : 'REAL'}, Radius: ${renderRadius}m`);

  document.getElementById('file-input').style.display = 'none';
  document.getElementById('ui').style.display = 'block';
  document.getElementById('legend').style.display = 'flex';
  document.getElementById('minimap-container').style.display = 'block';
  document.getElementById('floating-ctrl').style.display = 'flex';

  // Request iOS sensor permission
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      showLog(`iOS sensor: ${perm}`);
    } catch (e) {}
  }

  // Start camera
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const video = document.getElementById('cam-video');
    video.srcObject = stream;
    await video.play();
    showLog(`Camera: ${video.videoWidth}x${video.videoHeight}`);
  } catch (err) {
    showLog('Camera error: ' + err.message, true);
    alert('ไม่สามารถเปิดกล้อง: ' + err.message);
    return;
  }

  // Setup Three.js
  initThree();
  startSensors();
  startStatusLoop();
  startMinimapLoop();
  waitForGPSThenRender();
  animate();
}

function initThree() {
  const canvas = document.getElementById('three-canvas');
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    alpha: true,
    antialias: true,
    logarithmicDepthBuffer: true
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0); // transparent

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    100000
  );
  camera.position.set(0, 1.6, 0); // eye level

  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  const light = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(light);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  showLog('Three.js initialized');
}

function animate() {
  requestAnimationFrame(animate);

  // Update camera rotation from device orientation
  // Convert device orientation to Three.js camera rotation
  // Note: this is a simplified conversion that works well in landscape & portrait
  if (deviceOrientation) {
    updateCameraFromOrientation();
  }

  renderer.render(scene, camera);
}

let deviceOrientation = null;

function startSensors() {
  // Use deviceorientationabsolute if available (Android), fallback otherwise
  function handleOrientation(event) {
    deviceOrientation = {
      alpha: event.alpha, // compass (0-360)
      beta: event.beta,   // pitch (-180 to 180)
      gamma: event.gamma, // roll (-90 to 90)
      absolute: event.absolute,
      webkitCompassHeading: event.webkitCompassHeading
    };

    if (event.webkitCompassHeading != null) {
      userHeading = event.webkitCompassHeading;
    } else if (event.alpha != null) {
      userHeading = (360 - event.alpha) % 360;
    }
    if (event.beta != null) userPitch = event.beta;
    if (event.gamma != null) userRoll = event.gamma;
  }

  window.addEventListener('deviceorientationabsolute', handleOrientation, true);
  window.addEventListener('deviceorientation', handleOrientation, true);

  showLog('Sensors listening');
}

// Convert device orientation to Three.js camera rotation
// Reference: https://developer.mozilla.org/en-US/docs/Web/API/Device_orientation_events
function updateCameraFromOrientation() {
  if (!deviceOrientation) return;
  const alpha = (deviceOrientation.alpha || 0) * Math.PI / 180; // Z (yaw)
  const beta = (deviceOrientation.beta || 0) * Math.PI / 180;   // X (pitch)
  const gamma = (deviceOrientation.gamma || 0) * Math.PI / 180; // Y (roll)
  const orient = (window.orientation || 0) * Math.PI / 180;     // screen rotation

  // Standard Web sensor → Three.js camera quaternion
  const euler = new THREE.Euler();
  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X

  euler.set(beta, alpha, -gamma, 'YXZ');
  camera.quaternion.setFromEuler(euler);
  camera.quaternion.multiply(q1); // camera looks out the back
  q0.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -orient);
  camera.quaternion.multiply(q0);
}

function waitForGPSThenRender() {
  setStatus('รอ GPS fix...');
  showLog('Waiting for GPS...');
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
      showLog(`GPS: ${userPos.lat.toFixed(5)}, ${userPos.lon.toFixed(5)}`);
      showLog(`Acc: ±${userPos.acc.toFixed(0)}m`);
      decideAnchorAndRender();
      window._rendered = true;
      setTimeout(() => {
        const logEl = document.getElementById('log');
        if (logEl) logEl.style.display = 'none';
      }, 10000);
    }
  }, (err) => {
    showLog('GPS error: ' + err.message, true);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function decideAnchorAndRender() {
  if (testMode) {
    const centroid = computeFeaturesCentroid(surfaceData);
    if (centroid) {
      const shiftLat = userPos.lat - centroid.lat;
      const shiftLon = userPos.lon - centroid.lon;
      shiftAllCoords(surfaceData, shiftLat, shiftLon);
      showLog(`Test: shifted to user`);
    }
  }
  anchorPos = { lat: userPos.lat, lon: userPos.lon };
  showLog(`Anchor: ${anchorPos.lat.toFixed(5)}, ${anchorPos.lon.toFixed(5)}`);

  precomputeFeatures();
  if (autoFit) computeAutoFit();
  renderSurfaces();
  if (showDebugMarkers) renderDebugMarkers();
}

function computeFeaturesCentroid(geojson) {
  let sumLat = 0, sumLon = 0, n = 0;
  function walk(c) {
    if (typeof c[0] === 'number') { sumLon += c[0]; sumLat += c[1]; n++; }
    else c.forEach(walk);
  }
  geojson.features.forEach(f => walk(f.geometry.coordinates));
  return n === 0 ? null : { lat: sumLat/n, lon: sumLon/n };
}

function shiftAllCoords(geojson, dLat, dLon) {
  function walk(c) {
    if (typeof c[0] === 'number') { c[0] += dLon; c[1] += dLat; }
    else c.forEach(walk);
  }
  geojson.features.forEach(f => walk(f.geometry.coordinates));
}

// In our world:
// X = East, Y = Up (altitude), Z = -North (forward of viewer when facing north)
// Camera orientation handled by updateCameraFromOrientation
function llToEnu(lat, lon, alt) {
  const R = 6378137;
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLatRad = anchorPos.lat * Math.PI / 180;
  const east  = dLon * R * Math.cos(refLatRad);
  const north = dLat * R;
  return { x: east, y: (alt || 0), z: -north };
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

function precomputeFeatures() {
  allFeaturesEnu = [];
  surfaceData.features.forEach((feat, idx) => {
    const name = feat.properties?.name || `Feature ${idx}`;
    const color = getSurfaceColor(name);
    const geom = feat.geometry;
    let polygons = [];
    if (geom.type === 'Polygon') polygons = [geom.coordinates];
    else if (geom.type === 'MultiPolygon') polygons = geom.coordinates;
    else return;

    polygons.forEach((rings) => {
      let minDist = Infinity;
      rings.forEach(ring => {
        ring.forEach(([lon, lat]) => {
          const d = horizDistFromAnchor(lat, lon);
          if (d < minDist) minDist = d;
        });
      });
      allFeaturesEnu.push({ name, color, rings, minDist });
    });
  });
  showLog(`Pre-computed ${allFeaturesEnu.length} polys`);
}

function computeAutoFit() {
  let minAlt = Infinity;
  allFeaturesEnu.forEach(p => {
    if (p.minDist > renderRadius) return;
    p.rings.forEach(ring => {
      ring.forEach(([lon, lat, alt]) => { if (alt < minAlt) minAlt = alt; });
    });
  });
  if (minAlt === Infinity) return;
  // Camera at Y=1.6, want lowest surface at Y~10 (visible above horizon)
  surfaceOffsetY = 10 - minAlt;
  showLog(`Auto-fit: minAlt=${minAlt.toFixed(0)}, offset=${surfaceOffsetY.toFixed(0)}`);
  document.getElementById('surface-offset').value = Math.round(surfaceOffsetY);
}

function renderSurfaces() {
  // Clear previous surface meshes
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
  showLog(`scene.children: ${scene.children.length}, world.children: ${worldGroup.children.length}`);
  setStatus(`${polyCount} polys, ${totalTris} tris`);
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
      const enu = llToEnu(lat, lon, alt);
      flat2D.push(enu.x, enu.z);
      pos3D.push(enu.x, enu.y + surfaceOffsetY, enu.z);
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

  // Wireframe overlay
  const wireMat = new THREE.MeshBasicMaterial({
    color: color, wireframe: true, transparent: true, opacity: 0.85
  });
  mesh.add(new THREE.Mesh(geom, wireMat));

  // Outline of outer ring
  const outPts = [];
  outer.forEach(([lon, lat, alt]) => {
    const enu = llToEnu(lat, lon, alt);
    outPts.push(new THREE.Vector3(enu.x, enu.y + surfaceOffsetY, enu.z));
  });
  const lineGeom = new THREE.BufferGeometry().setFromPoints(outPts);
  const lineMat = new THREE.LineBasicMaterial({ color: color });
  mesh.add(new THREE.Line(lineGeom, lineMat));

  return mesh;
}

function renderDebugMarkers() {
  // Big colored pillars at cardinal directions
  const dist = 30;
  const markers = [
    { name: 'N', x: 0, z: -dist, color: 0xff0000 },
    { name: 'E', x: dist, z: 0, color: 0x00ff00 },
    { name: 'S', x: 0, z: dist, color: 0xffff00 },
    { name: 'W', x: -dist, z: 0, color: 0x00ffff },
  ];

  markers.forEach(m => {
    const geom = new THREE.CylinderGeometry(2, 2, 20, 8);
    const mat = new THREE.MeshBasicMaterial({ color: m.color });
    const pillar = new THREE.Mesh(geom, mat);
    pillar.position.set(m.x, 10, m.z);
    worldGroup.add(pillar);

    // Big sphere on top
    const sg = new THREE.SphereGeometry(5, 12, 12);
    const sm = new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: 0.7 });
    const sphere = new THREE.Mesh(sg, sm);
    sphere.position.set(m.x, 25, m.z);
    worldGroup.add(sphere);
  });

  // CRITICAL TEST: a big red box right in front of camera at 5m
  const testGeom = new THREE.BoxGeometry(2, 2, 2);
  const testMat = new THREE.MeshBasicMaterial({ color: 0xff00ff });
  const testBox = new THREE.Mesh(testGeom, testMat);
  testBox.position.set(0, 1.6, -5); // 5m in front of camera at eye level
  scene.add(testBox); // Add directly to scene, not worldGroup
  showLog('TEST BOX added at (0, 1.6, -5) - should always be visible');

  showLog(`Debug: 4 pillars at ${dist}m around`);
}

function adjustHeight(delta) {
  surfaceOffsetY += delta;
  document.getElementById('surface-offset').value = Math.round(surfaceOffsetY);
  showLog(`Surface Y: ${surfaceOffsetY}`);
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

function setStatus(html) {
  const el = document.getElementById('status');
  if (el) el.innerHTML = html;
}

function startStatusLoop() {
  setInterval(() => {
    if (!userPos) return;
    const accClass = userPos.acc < 5 ? 'good' : userPos.acc < 15 ? 'warn' : 'bad';
    let html = `
      <div class="row"><span class="label">Pos</span><span>${userPos.lat.toFixed(5)}, ${userPos.lon.toFixed(5)}</span></div>
      <div class="row"><span class="label">Acc</span><span class="${accClass}">±${userPos.acc.toFixed(0)}m</span></div>
      <div class="row"><span class="label">Hdg</span><span>${userHeading.toFixed(0)}°</span></div>
      <div class="row"><span class="label">Surf-Y</span><span>${surfaceOffsetY.toFixed(0)}m</span></div>
      <div class="row"><span class="label">Meshes</span><span>${surfaceMeshes.length}</span></div>
    `;
    setStatus(html);
  }, 500);
}

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

    const headingRad = userHeading * Math.PI / 180;
    allFeaturesEnu.forEach(p => {
      const colorHex = '#' + p.color.toString(16).padStart(6, '0');
      ctx.strokeStyle = colorHex;
      ctx.fillStyle = colorHex + '40';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const ring = p.rings[0];
      ring.forEach(([lon, lat, alt], i) => {
        const enu = llToEnu(lat, lon, alt);
        const rx = enu.x * Math.cos(-headingRad) - (-enu.z) * Math.sin(-headingRad);
        const ry = enu.x * Math.sin(-headingRad) + (-enu.z) * Math.cos(-headingRad);
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
