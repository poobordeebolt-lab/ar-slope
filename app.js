/**
 * AR Pre-Survey (Absolute Coordinate Principle)
 * 
 * New Architecture:
 * 1. World Space: X = East, Y = Absolute Ellipsoidal Elevation, Z = -North (South).
 * 2. Origin (0,0,0) is initialized at the user's first GPS coordinate, with Y=0 at ellipsoid surface.
 * 3. Meshes (OLS, OCS, Blocks, DTM) are generated ONCE in world space.
 *    Their vertices use their TRUE absolute ellipsoidal elevation (Y = alt).
 * 4. Camera continually updates based on GPS:
 *    camera.position.x = east_distance_from_origin
 *    camera.position.z = -north_distance_from_origin
 *    camera.position.y = DTM_at_current_location + EYE_HEIGHT
 * 5. Device Orientation uses robust quaternion math, ensuring surfaces align with the real world.
 */

// =============================================
// Globals
// =============================================
const EYE_HEIGHT = 1.6;

let scene, camera, renderer;
let dtmHeader = null, dtmData = null;
let geoData = { ols: null, ocs: null, hblocks: null };

// Origin for projection
let anchorPos = null; // {lat, lon}
let currentPos = null; // {lat, lon, acc}
let currentGroundElip = 0;

// Rendering state
let meshes = { ols: [], ocs: [], blocks: [], dtm: [] };
let visibility = { ols: true, ocs: true, blocks: true, dtm: true };
let testMode = false;
let headingOffset = 0;
let cameraFOV = 70;

const logEl = document.getElementById('log');
function log(msg) {
  console.log(msg);
  const div = document.createElement('div');
  div.textContent = `> ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// =============================================
// Initialization & File UI
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  const checkStart = () => {
    const canStart = (geoData.ols || geoData.ocs) && dtmHeader && dtmData;
    document.getElementById('btn-start').disabled = !canStart;
  };

  const handleFile = (inputId, labelId, parser) => {
    document.getElementById(inputId).addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      const r = new FileReader();
      r.onload = (evt) => {
        try {
          parser(evt.target.result, file);
          document.getElementById(labelId).classList.add('loaded');
          document.getElementById(labelId).innerHTML = `✓ ${file.name}`;
          checkStart();
        } catch (err) { alert(err.message); }
      };
      if (inputId === 'file-dtm-b') r.readAsArrayBuffer(file);
      else r.readAsText(file);
    });
  };

  handleFile('file-ols', 'lbl-ols', (txt) => { geoData.ols = JSON.parse(txt); });
  handleFile('file-ocs', 'lbl-ocs', (txt) => { geoData.ocs = JSON.parse(txt); });
  handleFile('file-hblock', 'lbl-hblock', (txt) => { geoData.hblocks = JSON.parse(txt); });
  handleFile('file-dtm-h', 'lbl-dtm-h', (txt) => { dtmHeader = JSON.parse(txt); });
  handleFile('file-dtm-b', 'lbl-dtm-b', (buf) => { dtmData = new Int16Array(buf); });

  document.getElementById('btn-start').addEventListener('click', startApp);
});

async function startApp() {
  testMode = document.getElementById('chk-test').checked;
  document.getElementById('ui-setup').style.display = 'none';
  document.getElementById('ui-ar').style.display = 'block';

  log('Starting AR Camera...');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
    document.getElementById('video-bg').srcObject = stream;
  } catch (e) { log('Camera error: ' + e.message); }

  initThree();
  setupUIControls();
  
  log('Requesting IMU & GPS permissions...');
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { await DeviceOrientationEvent.requestPermission(); } catch (e) { log('IMU Permission error'); }
  }

  window.addEventListener('deviceorientationabsolute', handleOrientation, true);
  window.addEventListener('deviceorientation', handleOrientation, true);

  navigator.geolocation.watchPosition(
    handleGPS,
    (err) => { log('GPS Error: ' + err.message); },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
  );

  requestAnimationFrame(animate);
}

// =============================================
// Three.js Setup
// =============================================
function initThree() {
  const canvas = document.getElementById('ar-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, logarithmicDepthBuffer: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(cameraFOV, window.innerWidth / window.innerHeight, 0.1, 50000);
  // Initial camera position will be updated by GPS
  camera.position.set(0, 0, 0);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function setupUIControls() {
  document.getElementById('slide-fov').addEventListener('input', (e) => {
    cameraFOV = parseFloat(e.target.value);
    document.getElementById('val-fov').textContent = cameraFOV;
    if (camera) { camera.fov = cameraFOV; camera.updateProjectionMatrix(); }
  });
  document.getElementById('slide-heading').addEventListener('input', (e) => {
    headingOffset = parseFloat(e.target.value);
    document.getElementById('val-heading').textContent = headingOffset;
  });

  document.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const layer = e.target.dataset.layer;
      visibility[layer] = !visibility[layer];
      e.target.classList.toggle('active', visibility[layer]);
      meshes[layer].forEach(m => m.visible = visibility[layer]);
    });
  });
}

// =============================================
// Math & Geospatial Utils
// =============================================
// Equirectangular approximation for fast local distance (< 20km)
const R_EARTH = 6378137;
function latLonToWorld(lat, lon) {
  if (!anchorPos) return { x: 0, z: 0 };
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLat = anchorPos.lat * Math.PI / 180;
  const east = dLon * R_EARTH * Math.cos(refLat);
  const north = dLat * R_EARTH;
  return { x: east, z: -north }; // +X = East, -Z = North
}

function sampleDTM(lat, lon) {
  if (!dtmHeader || !dtmData) return 0;
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
  const v00 = get(x0,y0), v10 = get(x1,y0), v01 = get(x0,y1), v11 = get(x1,y1);
  const valids = [v00, v10, v01, v11].filter(v => v !== null);
  if (valids.length === 0) return null;
  if (valids.length < 4) return valids.reduce((a,b)=>a+b, 0) / valids.length;
  const v0 = v00 * (1 - dx) + v10 * dx;
  const v1 = v01 * (1 - dx) + v11 * dx;
  return v0 * (1 - dy) + v1 * dy;
}

// =============================================
// GPS Handling & Scene Construction
// =============================================
let initializedScene = false;

function handleGPS(pos) {
  currentPos = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
  
  if (!initializedScene) {
    anchorPos = { lat: currentPos.lat, lon: currentPos.lon };
    log(`Anchor set at ${anchorPos.lat.toFixed(5)}, ${anchorPos.lon.toFixed(5)}`);
    
    if (testMode) shiftDataToAnchor();
    
    buildScene();
    initializedScene = true;
  }

  // Update Camera Position continually
  let dtm = sampleDTM(currentPos.lat, currentPos.lon);
  if (dtm === null) {
    log('Warning: DTM nodata at current location. Using last known height.');
    dtm = currentGroundElip || 0; 
  } else {
    currentGroundElip = dtm;
  }

  const worldPt = latLonToWorld(currentPos.lat, currentPos.lon);
  camera.position.set(worldPt.x, dtm + EYE_HEIGHT, worldPt.z);

  document.getElementById('info-panel').innerHTML = `
    <div>Lat/Lon: ${currentPos.lat.toFixed(5)}, ${currentPos.lon.toFixed(5)} (±${currentPos.acc.toFixed(0)}m)</div>
    <div><span class="hl">DTM Ground (Ellip): ${dtm.toFixed(2)}m</span></div>
    <div>Camera Elev: ${(dtm + EYE_HEIGHT).toFixed(2)}m</div>
  `;
}

function shiftDataToAnchor() {
  function getCenter(geojson) {
    if (!geojson) return null;
    let sl=0, sn=0, c=0;
    function w(co){ if(typeof co[0]==='number'){sn+=co[0];sl+=co[1];c++;} else co.forEach(w); }
    geojson.features.forEach(f => w(f.geometry.coordinates));
    return c ? { lat: sl/c, lon: sn/c } : null;
  }
  const center = getCenter(geoData.ols) || getCenter(geoData.ocs);
  if (!center) return;
  const dLat = anchorPos.lat - center.lat;
  const dLon = anchorPos.lon - center.lon;
  
  function shiftCoords(geojson) {
    if(!geojson) return;
    function w(co){ if(typeof co[0]==='number'){co[0]+=dLon;co[1]+=dLat;} else co.forEach(w); }
    geojson.features.forEach(f => w(f.geometry.coordinates));
  }
  shiftCoords(geoData.ols);
  shiftCoords(geoData.ocs);
  shiftCoords(geoData.hblocks);
  log(`Test Mode: Shifted data by ${dLat.toFixed(4)}, ${dLon.toFixed(4)} to match GPS.`);
}

function buildScene() {
  if (geoData.ols) buildPolygons(geoData.ols, 'ols', 0x3b82f6, 0.4);
  if (geoData.ocs) buildPolygons(geoData.ocs, 'ocs', 0x06b6d4, 0.4);
  if (geoData.hblocks) buildBlocks(geoData.hblocks);
  buildDTMMesh();
}

function buildPolygons(geojson, layerName, baseColor, opacity) {
  let count = 0;
  geojson.features.forEach((feat) => {
    let polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : 
                feat.geometry.type === 'MultiPolygon' ? feat.geometry.coordinates : [];
    
    const name = feat.properties?.name || feat.properties?.Name || 'Surface';

    polys.forEach(rings => {
      const outer = rings[0];
      const flat2D = [], pos3D = [], holeIdx = [];
      let vIdx = 0;
      rings.forEach((ring, ri) => {
        if (ri > 0) holeIdx.push(vIdx);
        const end = (ring.length > 1 && ring[0][0]===ring[ring.length-1][0] && ring[0][1]===ring[ring.length-1][1]) ? ring.length-1 : ring.length;
        for(let i=0; i<end; i++) {
          const [lon, lat, alt] = ring[i];
          const pt = latLonToWorld(lat, lon);
          flat2D.push(pt.x, pt.z);
          // Key Principle: Y is absolute ellipsoidal height
          pos3D.push(pt.x, alt || 0, pt.z);
          vIdx++;
        }
      });
      const tris = earcut(flat2D, holeIdx, 2);
      if (tris.length === 0) return;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(pos3D, 3));
      geom.setIndex(tris);
      geom.computeVertexNormals();

      const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
      mesh.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: baseColor, wireframe: true, transparent: true, opacity: 0.8 })));
      mesh.userData = { name, kind: layerName };
      scene.add(mesh);
      meshes[layerName].push(mesh);
      count++;
    });
  });
  log(`Built ${count} ${layerName} polygons.`);
}

function buildBlocks(geojson) {
  geojson.features.forEach((feat) => {
    if (feat.geometry.type !== 'Polygon') return;
    const ring = feat.geometry.coordinates[0];
    const maxH = parseFloat(feat.properties.max_height_allowance);
    if (isNaN(maxH)) return;
    
    const flat2D = [], pos3D = [];
    const end = (ring.length > 1 && ring[0][0]===ring[ring.length-1][0] && ring[0][1]===ring[ring.length-1][1]) ? ring.length-1 : ring.length;
    for(let i=0; i<end; i++) {
      const [lon, lat] = ring[i];
      let tElip = sampleDTM(lat, lon) || currentGroundElip || 0;
      const surfElip = tElip + maxH;
      const pt = latLonToWorld(lat, lon);
      flat2D.push(pt.x, pt.z);
      pos3D.push(pt.x, surfElip, pt.z);
    }
    const tris = earcut(flat2D, null, 2);
    if(tris.length===0) return;
    
    // Green if high clearance, Red if low
    const color = maxH < 45 ? 0xef4444 : 0x10b981;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos3D, 3));
    geom.setIndex(tris);
    
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
    mesh.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.6 })));
    mesh.userData = { name: feat.properties.Name || 'Block', kind: 'block', allow: maxH };
    scene.add(mesh);
    meshes.blocks.push(mesh);
  });
}

function buildDTMMesh() {
  const R = 1000; // 1km radius for visual mesh
  const res = 50; // 50x50 grid
  const positions = [], indices = [];
  
  const startPt = latLonToWorld(anchorPos.lat, anchorPos.lon);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(anchorPos.lat * Math.PI/180);

  for (let i = 0; i <= res; i++) {
    for (let j = 0; j <= res; j++) {
      const dx = (j / res - 0.5) * R * 2;
      const dz = (i / res - 0.5) * R * 2;
      
      const ptX = startPt.x + dx;
      const ptZ = startPt.z + dz;
      
      const lat = anchorPos.lat - (dz / mPerDegLat); // -dz is +North, so -dz means increasing lat
      const lon = anchorPos.lon + (dx / mPerDegLon);
      
      const alt = sampleDTM(lat, lon) || currentGroundElip || 0;
      positions.push(ptX, alt, ptZ);
    }
  }

  for (let i = 0; i < res; i++) {
    for (let j = 0; j < res; j++) {
      const a = i * (res + 1) + j;
      const b = a + 1;
      const c = (i + 1) * (res + 1) + j;
      const d = c + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
  mesh.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0x94a3b8, wireframe: true, transparent: true, opacity: 0.15 })));
  mesh.userData = { kind: 'dtm' };
  scene.add(mesh);
  meshes.dtm.push(mesh);
}

// =============================================
// IMU & Raycasting
// =============================================
let deviceOrientation = null;

function handleOrientation(event) {
  deviceOrientation = event;
}

function updateCameraRotation() {
  if (!deviceOrientation) return;
  
  let alpha = deviceOrientation.alpha || 0;
  const beta = deviceOrientation.beta || 0;
  const gamma = deviceOrientation.gamma || 0;

  // iOS compass
  if (deviceOrientation.webkitCompassHeading !== undefined) {
    alpha = 360 - deviceOrientation.webkitCompassHeading;
  }

  const orient = (window.orientation || 0);

  const euler = new THREE.Euler();
  euler.set(
    beta * Math.PI / 180,
    (alpha + headingOffset) * Math.PI / 180,
    -gamma * Math.PI / 180,
    'YXZ'
  );
  
  const q = new THREE.Quaternion().setFromEuler(euler);
  const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  q.multiply(q1);
  const q0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), -orient * Math.PI/180);
  q.multiply(q0);
  
  camera.quaternion.copy(q);
}

function performRaycast() {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  
  let targets = [];
  if (visibility.ols) targets.push(...meshes.ols);
  if (visibility.ocs) targets.push(...meshes.ocs);
  if (visibility.blocks) targets.push(...meshes.blocks);
  if (visibility.dtm) targets.push(...meshes.dtm);

  const hits = raycaster.intersectObjects(targets, false);
  const infoEl = document.getElementById('target-info');
  
  if (hits.length > 0) {
    const h = hits[0];
    const ud = h.object.userData;
    let txt = '';
    const hY = h.point.y.toFixed(1);
    const d = h.distance.toFixed(0);
    const clearance = (h.point.y - currentGroundElip).toFixed(1);

    if (ud.kind === 'ols' || ud.kind === 'ocs') {
      txt = `[${ud.kind.toUpperCase()}] ${ud.name}\nDist: ${d}m\nAbsolute Elev: ${hY}m\nClearance (Above Ground): ${clearance}m`;
    } else if (ud.kind === 'block') {
      txt = `[BLOCK] ${ud.name}\nMax Allow: ${ud.allow}m\nAbsolute Top: ${hY}m`;
    } else if (ud.kind === 'dtm') {
      txt = `[DTM] Ground\nDist: ${d}m\nAbsolute Elev: ${hY}m`;
    }
    infoEl.textContent = txt;
  } else {
    infoEl.textContent = "— Not aiming at any surface —";
  }
}

function animate() {
  requestAnimationFrame(animate);
  updateCameraRotation();
  if (initializedScene) performRaycast();
  renderer.render(scene, camera);
}
