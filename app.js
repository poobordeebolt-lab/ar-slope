// =============================================
// AR Slope Surface Viewer
// Designed for VTPO obstacle pre-survey
// =============================================

let userPos = null;
let userHeading = 0;
let surfaceData = null;
let scene = null;

// ----- UI helpers -----
function setStatus(html) {
  document.getElementById('status').innerHTML = html;
}

function showAR() {
  document.getElementById('file-input').style.display = 'none';
  document.getElementById('ui').style.display = 'block';
  document.getElementById('legend').style.display = 'block';
  document.getElementById('scene').style.display = 'block';
  scene = document.querySelector('a-scene');
  startStatusLoop();
}

// ----- File loading -----
document.getElementById('geojson-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      surfaceData = JSON.parse(evt.target.result);
      console.log('Loaded GeoJSON:', surfaceData);
      showAR();
      waitForGPSThenRender();
    } catch (err) {
      alert('ไฟล์ไม่ถูกต้อง: ' + err.message);
    }
  };
  reader.readAsText(file);
});

function loadDemo() {
  // Demo: create a simple inclined surface around current location
  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const baseAlt = pos.coords.altitude || 50;

    // 100m x 100m grid, sloping up at 2% (typical OLS-like)
    const offset = 0.0009; // ~100 m
    surfaceData = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'Demo Slope Surface', slope_pct: 2 },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [lon - offset, lat - offset, baseAlt],
            [lon + offset, lat - offset, baseAlt],
            [lon + offset, lat + offset, baseAlt + 4],
            [lon - offset, lat + offset, baseAlt + 4],
            [lon - offset, lat - offset, baseAlt]
          ]]
        }
      }]
    };
    showAR();
    waitForGPSThenRender();
  }, (err) => {
    alert('ไม่สามารถอ่านตำแหน่งได้: ' + err.message);
  }, { enableHighAccuracy: true });
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
      renderSurface();
      window._rendered = true;
    }
  }, (err) => {
    setStatus('GPS error: ' + err.message);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

// ----- Compass -----
window.addEventListener('deviceorientationabsolute', (e) => {
  if (e.alpha != null) userHeading = 360 - e.alpha;
}, true);
window.addEventListener('deviceorientation', (e) => {
  if (e.webkitCompassHeading) userHeading = e.webkitCompassHeading;
  else if (e.alpha != null && !window._hasAbsolute) userHeading = 360 - e.alpha;
});

// ----- Render surface as A-Frame entities -----
function renderSurface() {
  if (!surfaceData || !scene) return;

  setStatus('กำลัง render surface...');

  surfaceData.features.forEach((feat, idx) => {
    const geom = feat.geometry;

    if (geom.type === 'Polygon') {
      renderPolygon(geom.coordinates[0], idx, feat.properties);
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach((poly, j) => {
        renderPolygon(poly[0], idx + '-' + j, feat.properties);
      });
    } else if (geom.type === 'Point') {
      renderPoint(geom.coordinates, idx, feat.properties);
    }
  });

  setStatus('Render เสร็จ ✓');
}

function renderPolygon(coords, id, props) {
  // Place vertices as small spheres + lines connecting them
  // For a real surface, you'd build a triangulated mesh
  coords.forEach((c, i) => {
    const [lon, lat, alt] = c;
    const entity = document.createElement('a-entity');
    entity.setAttribute('gps-entity-place', `latitude: ${lat}; longitude: ${lon}`);
    entity.setAttribute('geometry', 'primitive: sphere; radius: 1.5');
    entity.setAttribute('material', 'color: #3b82f6; opacity: 0.8; transparent: true');
    entity.setAttribute('position', `0 ${alt || 0} 0`);

    // Label
    const label = document.createElement('a-text');
    label.setAttribute('value', `V${i}\nZ=${(alt || 0).toFixed(1)}m`);
    label.setAttribute('align', 'center');
    label.setAttribute('color', 'white');
    label.setAttribute('scale', '8 8 8');
    label.setAttribute('position', '0 3 0');
    label.setAttribute('look-at', '[gps-camera]');
    entity.appendChild(label);

    scene.appendChild(entity);
  });

  // Center marker showing surface name
  const center = polygonCentroid(coords);
  const centerEnt = document.createElement('a-entity');
  centerEnt.setAttribute('gps-entity-place', `latitude: ${center[1]}; longitude: ${center[0]}`);
  centerEnt.setAttribute('geometry', 'primitive: box; width: 2; height: 0.2; depth: 2');
  centerEnt.setAttribute('material', 'color: #2563eb; opacity: 0.5; transparent: true');
  centerEnt.setAttribute('position', `0 ${center[2] || 0} 0`);

  const nameLabel = document.createElement('a-text');
  nameLabel.setAttribute('value', props.name || `Surface ${id}`);
  nameLabel.setAttribute('align', 'center');
  nameLabel.setAttribute('color', '#fbbf24');
  nameLabel.setAttribute('scale', '15 15 15');
  nameLabel.setAttribute('position', '0 5 0');
  nameLabel.setAttribute('look-at', '[gps-camera]');
  centerEnt.appendChild(nameLabel);

  scene.appendChild(centerEnt);
}

function renderPoint(coord, id, props) {
  const [lon, lat, alt] = coord;
  const entity = document.createElement('a-entity');
  entity.setAttribute('gps-entity-place', `latitude: ${lat}; longitude: ${lon}`);
  entity.setAttribute('geometry', 'primitive: cylinder; radius: 0.5; height: 5');
  entity.setAttribute('material', 'color: #22c55e');
  entity.setAttribute('position', `0 ${(alt || 0) + 2.5} 0`);
  scene.appendChild(entity);
}

function polygonCentroid(coords) {
  let x = 0, y = 0, z = 0;
  const n = coords.length - 1; // last = first
  for (let i = 0; i < n; i++) {
    x += coords[i][0];
    y += coords[i][1];
    z += coords[i][2] || 0;
  }
  return [x / n, y / n, z / n];
}

// ----- Live status loop -----
function startStatusLoop() {
  setInterval(() => {
    if (!userPos) return;

    const accClass = userPos.acc < 5 ? 'good' : userPos.acc < 15 ? 'warn' : 'bad';
    const altAccClass = !userPos.altAcc ? 'bad' : userPos.altAcc < 10 ? 'good' : userPos.altAcc < 20 ? 'warn' : 'bad';

    let html = `
      <div class="row"><span class="label">Lat</span><span>${userPos.lat.toFixed(6)}</span></div>
      <div class="row"><span class="label">Lon</span><span>${userPos.lon.toFixed(6)}</span></div>
      <div class="row"><span class="label">Alt</span><span>${userPos.alt ? userPos.alt.toFixed(1) + ' m' : 'N/A'}</span></div>
      <div class="row"><span class="label">H-acc</span><span class="${accClass}">±${userPos.acc.toFixed(1)} m</span></div>
      <div class="row"><span class="label">V-acc</span><span class="${altAccClass}">${userPos.altAcc ? '±' + userPos.altAcc.toFixed(1) + ' m' : 'N/A'}</span></div>
      <div class="row"><span class="label">Heading</span><span>${userHeading.toFixed(0)}°</span></div>
    `;

    // Compare to nearest surface point
    if (surfaceData && userPos.alt != null) {
      const result = checkSurfaceClearance(userPos);
      if (result) {
        const cls = result.clearance > 5 ? 'good' : result.clearance > 0 ? 'warn' : 'bad';
        const status = result.clearance > 0 ? '✓ ใต้ surface' : '⚠ เกิน surface';
        html += `
          <hr style="border-color:#444;margin:6px 0">
          <div class="row"><span class="label">Surface Z</span><span>${result.surfaceAlt.toFixed(1)} m</span></div>
          <div class="row"><span class="label">Clearance</span><span class="${cls}">${result.clearance.toFixed(1)} m</span></div>
          <div class="row"><span class="label">Status</span><span class="${cls}">${status}</span></div>
        `;
      }
    }

    setStatus(html);
  }, 500);
}

// ----- Surface clearance check (simple: nearest vertex) -----
function checkSurfaceClearance(pos) {
  if (!surfaceData) return null;
  let nearest = null;
  let minDist = Infinity;

  surfaceData.features.forEach(feat => {
    const coords = feat.geometry.type === 'Polygon'
      ? feat.geometry.coordinates[0]
      : null;
    if (!coords) return;
    coords.forEach(c => {
      const d = haversine(pos.lat, pos.lon, c[1], c[0]);
      if (d < minDist) {
        minDist = d;
        nearest = c;
      }
    });
  });

  if (!nearest) return null;
  const surfaceAlt = nearest[2] || 0;
  return {
    surfaceAlt,
    clearance: surfaceAlt - pos.alt,
    distance: minDist
  };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Request iOS permission for device orientation if needed
if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
  document.body.addEventListener('click', () => {
    DeviceOrientationEvent.requestPermission();
  }, { once: true });
}
