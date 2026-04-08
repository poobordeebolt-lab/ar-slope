import * as THREE from 'three';
import { makeEnuTransform } from './geodesy.js';
import { flattenFeatures, buildMeshes, queryHeights } from './surfaces.js';
import {
  startGps, requestOrientationPermission, startOrientation,
  orientationToQuaternion, screenAngleDeg
} from './sensors.js';

// --------- DOM refs
const elStatus = document.getElementById('status');
const elFps    = document.getElementById('fps');
const elLat    = document.getElementById('lat');
const elLon    = document.getElementById('lon');
const elHEll   = document.getElementById('hEll');
const elAcc    = document.getElementById('acc');
const elHdg    = document.getElementById('hdg');
const elPtc    = document.getElementById('ptc');
const elRll    = document.getElementById('rll');
const elSurf   = document.getElementById('surfBelow');
const btnStart = document.getElementById('btnStart');
const btnCal   = document.getElementById('btnCal');
const chkOLS   = document.getElementById('chkOLS');
const chkOCS   = document.getElementById('chkOCS');
const rangeSel = document.getElementById('rangeSel');
const opa      = document.getElementById('opa');
const video    = document.getElementById('cam');
const canvas   = document.getElementById('three');

// --------- Three.js setup
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 50000);
camera.position.set(0, 1.6, 0); // user eye height

// Ground plane reference grid (subtle)
const grid = new THREE.GridHelper(200, 40, 0x444444, 0x222222);
grid.material.transparent = true;
grid.material.opacity = 0.25;
scene.add(grid);

// Axis marker at origin (user position) for debugging heading
const axes = new THREE.AxesHelper(3);
scene.add(axes);

let surfaceGroup = null;
let surfaceQueries = [];
let ocsData = null, olsData = null;
let originGeo = null; // [lon, lat, h] used as scene origin
let toEnu = null;

// --------- Data load
async function loadData() {
  const [ocs, ols] = await Promise.all([
    fetch('data/vtss_ocs.geojson').then(r => r.json()),
    fetch('data/vtss_ols.geojson').then(r => r.json()),
  ]);
  ocsData = flattenFeatures(ocs, 'OCS');
  olsData = flattenFeatures(ols, 'OLS');
}

function rebuildSurfaces(userLon, userLat, userH) {
  if (surfaceGroup) {
    scene.remove(surfaceGroup);
    surfaceGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  originGeo = [userLon, userLat, userH];
  toEnu = makeEnuTransform(userLon, userLat, userH);
  const feats = [
    ...(chkOLS.checked ? olsData : []),
    ...(chkOCS.checked ? ocsData : []),
  ];
  const rangeM = parseFloat(rangeSel.value);
  const { group, surfaceQueries: sq } = buildMeshes(feats, toEnu, [userLon, userLat], rangeM);
  // apply current opacity
  const op = parseFloat(opa.value);
  group.traverse(o => {
    if (o.material && 'opacity' in o.material) o.material.opacity = op;
  });
  surfaceGroup = group;
  surfaceQueries = sq;
  scene.add(group);
  elStatus.textContent = `Loaded ${group.children.length/2 | 0} surfaces within ${rangeM} m`;
}

// --------- Camera stream
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

// --------- Sensor state
let gpsState = null;
let oriState = null;
let headingCalibration = 0;
let firstRebuildDone = false;

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  elStatus.textContent = 'กำลังขอสิทธิ์กล้อง/เซ็นเซอร์…';
  try {
    await requestOrientationPermission();
    await startCamera();
    oriState = startOrientation();
    startGps((p) => {
      gpsState = p;
      if (!firstRebuildDone) {
        rebuildSurfaces(p.lon, p.lat, p.h);
        firstRebuildDone = true;
      }
    }, (err) => {
      elStatus.textContent = 'GPS error: ' + err.message;
    });
    elStatus.textContent = 'พร้อม — รอ GPS fix…';
  } catch (e) {
    elStatus.textContent = 'ERR: ' + e.message;
    btnStart.disabled = false;
  }
});

btnCal.addEventListener('click', () => {
  // User aims phone at known true north (or a known bearing) and taps to zero.
  // Simpler: zero out current alpha so that crosshair = north.
  if (!oriState) return;
  headingCalibration = -(oriState.alpha || 0);
  elStatus.textContent = `Calibrated: offset ${headingCalibration.toFixed(1)}°`;
});

for (const el of [chkOLS, chkOCS, rangeSel]) {
  el.addEventListener('change', () => {
    if (gpsState) rebuildSurfaces(gpsState.lon, gpsState.lat, gpsState.h);
  });
}
opa.addEventListener('input', () => {
  if (!surfaceGroup) return;
  const op = parseFloat(opa.value);
  surfaceGroup.traverse(o => {
    if (o.material && 'opacity' in o.material) o.material.opacity = op;
  });
});

// --------- Resize
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);
onResize();

// --------- Frame loop
let frames = 0, lastFpsT = performance.now();
function tick() {
  requestAnimationFrame(tick);

  // Update camera orientation
  if (oriState) {
    const alphaAdj = (oriState.alpha || 0) + headingCalibration;
    orientationToQuaternion(
      camera.quaternion,
      alphaAdj, oriState.beta, oriState.gamma,
      screenAngleDeg()
    );
    elHdg.textContent = ((alphaAdj % 360 + 360) % 360).toFixed(0);
    elPtc.textContent = (oriState.beta || 0).toFixed(0);
    elRll.textContent = (oriState.gamma || 0).toFixed(0);
  }

  // Update camera position (re-anchor in ENU if drift > threshold)
  if (gpsState && toEnu && originGeo) {
    elLat.textContent = gpsState.lat.toFixed(6);
    elLon.textContent = gpsState.lon.toFixed(6);
    elHEll.textContent = gpsState.h.toFixed(1);
    elAcc.textContent = gpsState.acc.toFixed(0);

    const [e, n, u] = toEnu(gpsState.lon, gpsState.lat, gpsState.h);
    camera.position.set(e, u + 1.6, -n);

    // Auto-rebuild if drifted > 200 m
    const drift = Math.hypot(e, n);
    if (drift > 200) {
      rebuildSurfaces(gpsState.lon, gpsState.lat, gpsState.h);
    }

    // Report surface ceiling above current (lon,lat)
    const hits = queryHeights(gpsState.lon, gpsState.lat, surfaceQueries);
    if (hits.length === 0) {
      elSurf.textContent = 'ไม่มี surface คลุมจุดนี้';
      elSurf.className = '';
    } else {
      // lowest surface above user wins (most restrictive)
      hits.sort((a,b) => a.h - b.h);
      const low = hits[0];
      const clearance = low.h - gpsState.h;
      const sign = clearance >= 0 ? '+' : '';
      elSurf.textContent = `${low.name} @ ${low.h.toFixed(1)} m (Δ ${sign}${clearance.toFixed(1)} m)`;
      elSurf.className = clearance >= 0 ? 'ok' : 'penetrate';
    }
  }

  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - lastFpsT > 1000) {
    elFps.textContent = `${frames} fps`;
    frames = 0; lastFpsT = now;
  }
}

loadData().then(() => {
  elStatus.textContent = `Data loaded — OCS: ${ocsData.length}, OLS: ${olsData.length}. กด เริ่มกล้อง + GPS`;
  tick();
}).catch(e => {
  elStatus.textContent = 'Data load error: ' + e.message;
});
