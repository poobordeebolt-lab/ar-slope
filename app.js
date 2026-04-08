// =============================================
// AR OLS Surface Viewer v3
// - Mini-map (top-down)
// - Debug markers (N/S/E/W cardinal directions)
// - Manual height adjustment
// - Auto-fit (pulls surfaces near eye level)
// =============================================

let userPos = null;
let userHeading = 0;
let surfaceData = null;
let renderRadius = 8000;
let testMode = false;
let autoFit = true;
let showDebugMarkers = true;
let surfaceOffsetY = -30; // additional Y offset to apply to all surfaces
let anchorPos = null;
let scene = null;
let surfacesEntity = null;
let debugEntity = null;
let surfaceMeshes = []; // for height adjustment
let allFeaturesEnu = []; // {name, color, points: [{x,y,z}], minDist}

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
    if (!file) {
      setFileStatus('ยังไม่ได้เลือกไฟล์');
      startBtn.disabled = true;
      return;
    }
    setFileStatus(`โหลด: ${file.name}...`, '#fbbf24');

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
          `✓ ${file.name}<br>${numFeatures} features, ${totalVerts} verts`,
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

function startAR() {
  if (!surfaceData) return;
  renderRadius = parseInt(document.getElementById('render-radius').value) || 8000;
  testMode = document.getElementById('test-mode').checked;
  autoFit = document.getElementById('auto-fit').checked;
  showDebugMarkers = document.getElementById('debug-markers').checked;
  surfaceOffsetY = parseInt(document.getElementById('surface-offset').value) || 0;

  showLog('=== Starting AR v3 ===');
  showLog(`Mode: ${testMode ? 'TEST' : 'REAL GEO'}`);
  showLog(`Radius: ${renderRadius} m, Offset Y: ${surfaceOffsetY} m`);
  showLog(`Auto-fit: ${autoFit}, Debug markers: ${showDebugMarkers}`);

  document.getElementById('file-input').style.display = 'none';
  document.getElementById('ui').style.display = 'block';
  document.getElementById('legend').style.display = 'flex';
  document.getElementById('scene').style.display = 'block';
  document.getElementById('minimap-container').style.display = 'block';
  document.getElementById('minimap-label').style.display = 'block';
  document.getElementById('floating-ctrl').style.display = 'flex';

  scene = document.querySelector('a-scene');
  surfacesEntity = document.getElementById('surfaces');
  debugEntity = document.getElementById('debug');

  startStatusLoop();
  startMinimapLoop();
  waitForGPSThenRender();
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
      showLog(`Acc: ±${userPos.acc.toFixed(0)}m, Alt: ${userPos.alt?.toFixed(0)}m`);
      decideAnchorAndRender();
      window._rendered = true;
      setTimeout(() => {
        const logEl = document.getElementById('log');
        if (logEl) logEl.style.display = 'none';
      }, 8000);
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
      showLog(`Test: shift ${shiftLat.toFixed(4)}, ${shiftLon.toFixed(4)}`);
      shiftAllCoords(surfaceData, shiftLat, shiftLon);
    }
  }
  anchorPos = { lat: userPos.lat, lon: userPos.lon };

  const anchor = document.getElementById('anchor');
  anchor.setAttribute('gps-entity-place',
    `latitude: ${anchorPos.lat}; longitude: ${anchorPos.lon}`);

  showLog(`Anchor set: ${anchorPos.lat.toFixed(5)}, ${anchorPos.lon.toFixed(5)}`);

  // Pre-compute features in ENU + auto-fit
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

function llToEnu(lat, lon, alt) {
  const R = 6378137;
  const dLat = (lat - anchorPos.lat) * Math.PI / 180;
  const dLon = (lon - anchorPos.lon) * Math.PI / 180;
  const refLatRad = anchorPos.lat * Math.PI / 180;
  const east  = dLon * R * Math.cos(refLatRad);
  const north = dLat * R;
  // Use surface absolute MSL altitude — ignore GPS altitude (too unreliable)
  // We'll subtract a "ground reference" later via surfaceOffsetY
  const up = (alt || 0);
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

    polygons.forEach((rings, polyIdx) => {
      const enuPoints = [];
      let minDist = Infinity;
      let minLat = Infinity, maxLat = -Infinity;
      let minLon = Infinity, maxLon = -Infinity;
      rings.forEach(ring => {
        ring.forEach(([lon, lat, alt]) => {
          const d = horizDistFromAnchor(lat, lon);
          if (d < minDist) minDist = d;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        });
      });
      allFeaturesEnu.push({
        name, color, rings, polyIdx, minDist,
        bbox: { minLat, maxLat, minLon, maxLon }
      });
    });
  });
  showLog(`Pre-computed ${allFeaturesEnu.length} polygons`);
}

function computeAutoFit() {
  // Find min absolute altitude of all rendered (in-range) surfaces
  // Then set surfaceOffsetY so that lowest surface ends up at ~5m above eye level
  let minAlt = Infinity;
  allFeaturesEnu.forEach(p => {
    if (p.minDist > renderRadius) return;
    p.rings.forEach(ring => {
      ring.forEach(([lon, lat, alt]) => {
        if (alt < minAlt) minAlt = alt;
      });
    });
  });
  if (minAlt === Infinity) {
    showLog('Auto-fit: no in-range surfaces');
    return;
  }
  // Target: lowest point at ~5 m above eye → user eye at Y=0
  // surface render Y = alt + surfaceOffsetY, want = 5
  // → surfaceOffsetY = 5 - alt
  surfaceOffsetY = 5 - minAlt;
  showLog(`Auto-fit: minAlt=${minAlt.toFixed(1)}, offset=${surfaceOffsetY.toFixed(1)}`);
  document.getElementById('surface-offset').value = Math.round(surfaceOffsetY);
}

function renderSurfaces() {
  if (!window.THREE || !scene || !surfacesEntity || !surfacesEntity.object3D) {
    setTimeout(renderSurfaces, 200);
    return;
  }
  // Clear previous
  while (surfacesEntity.object3D.children.length > 0) {
    surfacesEntity.object3D.remove(surfacesEntity.object3D.children[0]);
  }
  surfaceMeshes = [];

  let polyCount = 0;
  let totalTris = 0;
  let skipped = 0;

  allFeaturesEnu.forEach(p => {
    if (p.minDist > renderRadius) {
      skipped++;
      showLog(`✗ ${p.name}: ${p.minDist.toFixed(0)}m`);
      return;
    }
    const mesh = createPolygonMesh(p.rings, p.color, p.name);
    if (mesh) {
      surfacesEntity.object3D.add(mesh);
      surfaceMeshes.push(mesh);
      polyCount++;
      totalTris += mesh.userData.triCount || 0;
    }
  });

  showLog(`✓ Rendered: ${polyCount} polys, ${totalTris} tris, skipped ${skipped}`);
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
      // Apply surfaceOffsetY here
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
    color: color, transparent: true, opacity: 0.45,
    side: THREE.DoubleSide, depthWrite: false
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData = { name, triCount: tris.length / 3, originalPos: pos3D.slice() };

  // Wireframe
  const wireMat = new THREE.MeshBasicMaterial({
    color: color, wireframe: true, transparent: true, opacity: 0.85
  });
  mesh.add(new THREE.Mesh(geom, wireMat));

  // Outline
  const outPts = [];
  outer.forEach(([lon, lat, alt]) => {
    const enu = llToEnu(lat, lon, alt);
    outPts.push(new THREE.Vector3(enu.x, enu.y + surfaceOffsetY, enu.z));
  });
  const lineGeom = new THREE.BufferGeometry().setFromPoints(outPts);
  const lineMat = new THREE.LineBasicMaterial({ color: color, linewidth: 4 });
  mesh.add(new THREE.Line(lineGeom, lineMat));

  showLog(`✓ ${name}: ${tris.length/3} tris`);
  return mesh;
}

// ----- Debug markers: cardinal direction pillars -----
function renderDebugMarkers() {
  if (!debugEntity || !debugEntity.object3D) return;
  while (debugEntity.object3D.children.length > 0) {
    debugEntity.object3D.remove(debugEntity.object3D.children[0]);
  }

  // Place big colored pillars at N/S/E/W, 50m away, 20m tall
  const dist = 50;
  const markers = [
    { name: 'N', x: 0, z: -dist, color: 0xff0000 },  // North = -Z
    { name: 'E', x: dist, z: 0, color: 0x00ff00 },   // East = +X
    { name: 'S', x: 0, z: dist, color: 0xffff00 },   // South = +Z
    { name: 'W', x: -dist, z: 0, color: 0x00ffff },  // West = -X
  ];

  markers.forEach(m => {
    // Pillar
    const geom = new THREE.CylinderGeometry(2, 2, 30, 8);
    const mat = new THREE.MeshBasicMaterial({ color: m.color });
    const pillar = new THREE.Mesh(geom, mat);
    pillar.position.set(m.x, 5, m.z);
    debugEntity.object3D.add(pillar);

    // Top cap with bigger sphere
    const sphereGeom = new THREE.SphereGeometry(5, 12, 12);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: m.color, transparent: true, opacity: 0.7
    });
    const sphere = new THREE.Mesh(sphereGeom, sphereMat);
    sphere.position.set(m.x, 25, m.z);
    debugEntity.object3D.add(sphere);
  });

  // Add a center pillar at user position (at "ground")
  const center = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 3, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  center.position.set(0, 1.5, 0);
  debugEntity.object3D.add(center);

  showLog('Debug markers: N(red) E(green) S(yellow) W(cyan) at 50m');
}

// ----- Adjust height -----
function adjustHeight(delta) {
  surfaceOffsetY += delta;
  document.getElementById('surface-offset').value = Math.round(surfaceOffsetY);
  showLog(`Surface offset → ${surfaceOffsetY} m`);
  // Re-apply to all meshes
  surfaceMeshes.forEach(mesh => {
    const original = mesh.userData.originalPos;
    if (!original) return;
    const newPos = new Float32Array(original.length);
    for (let i = 0; i < original.length; i += 3) {
      newPos[i] = original[i];
      newPos[i+1] = original[i+1] + delta;
      newPos[i+2] = original[i+2];
    }
    mesh.userData.originalPos = Array.from(newPos);
    mesh.geometry.attributes.position.array.set(newPos);
    mesh.geometry.attributes.position.needsUpdate = true;
    // Update children too (wireframe shares geometry; line doesn't)
    mesh.children.forEach(child => {
      if (child.geometry && child !== mesh && child.type === 'Line') {
        const arr = child.geometry.attributes.position.array;
        for (let i = 1; i < arr.length; i += 3) arr[i] += delta;
        child.geometry.attributes.position.needsUpdate = true;
      }
    });
  });
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

function startStatusLoop() {
  setInterval(() => {
    if (!userPos) return;
    const accClass = userPos.acc < 5 ? 'good' : userPos.acc < 15 ? 'warn' : 'bad';
    let html = `
      <div class="row"><span class="label">Pos</span><span>${userPos.lat.toFixed(5)}, ${userPos.lon.toFixed(5)}</span></div>
      <div class="row"><span class="label">Acc</span><span class="${accClass}">±${userPos.acc.toFixed(0)}m</span></div>
      <div class="row"><span class="label">Alt</span><span>${userPos.alt ? userPos.alt.toFixed(0) + 'm' : 'N/A'}</span></div>
      <div class="row"><span class="label">Hdg</span><span>${userHeading.toFixed(0)}°</span></div>
      <div class="row"><span class="label">Surf-Y</span><span>${surfaceOffsetY.toFixed(0)}m</span></div>
    `;
    setStatus(html);
  }, 500);
}

// ----- Mini-map (top-down 2D view) -----
function startMinimapLoop() {
  const canvas = document.getElementById('minimap');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  function draw() {
    if (!anchorPos || allFeaturesEnu.length === 0) {
      requestAnimationFrame(draw);
      return;
    }

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, W, H);

    // Compute scale: fit renderRadius into canvas (with margin)
    const cx = W / 2, cy = H / 2;
    const margin = 10;
    const scale = (Math.min(W, H) / 2 - margin) / renderRadius;

    // Draw range rings (1km, 2km, ...)
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.3)';
    ctx.lineWidth = 1;
    for (let r = 1000; r <= renderRadius; r += 1000) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Draw cardinal directions
    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, 12);
    ctx.fillText('S', cx, H - 4);
    ctx.fillText('E', W - 8, cy + 4);
    ctx.fillText('W', 8, cy + 4);

    // Compute camera heading rotation
    const headingRad = userHeading * Math.PI / 180;

    // Draw each feature outline
    allFeaturesEnu.forEach(p => {
      const colorHex = '#' + p.color.toString(16).padStart(6, '0');
      ctx.strokeStyle = colorHex;
      ctx.fillStyle = colorHex + '40'; // semi-transparent
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const ring = p.rings[0];
      ring.forEach(([lon, lat, alt], i) => {
        const enu = llToEnu(lat, lon, alt);
        // Rotate around center by -heading so that "up" on map = where camera points
        const rx = enu.x * Math.cos(-headingRad) - (-enu.z) * Math.sin(-headingRad);
        const ry = enu.x * Math.sin(-headingRad) + (-enu.z) * Math.cos(-headingRad);
        const px = cx + rx * scale;
        const py = cy - ry * scale;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });

    // Draw user position (center)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();

    // Draw heading arrow (pointing up = where camera points)
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - 12);
    ctx.stroke();
    // arrow head
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy - 8);
    ctx.lineTo(cx, cy - 12);
    ctx.lineTo(cx + 4, cy - 8);
    ctx.stroke();

    requestAnimationFrame(draw);
  }
  draw();
}
