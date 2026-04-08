import * as THREE from 'three';

// Start continuous GPS. Callback receives {lon,lat,h,acc}.
export function startGps(onUpdate, onError) {
  if (!('geolocation' in navigator)) {
    onError?.(new Error('No Geolocation API'));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      onUpdate({
        lon: pos.coords.longitude,
        lat: pos.coords.latitude,
        h:   pos.coords.altitude ?? 0, // browser returns WGS84 ellipsoidal altitude on Android
        acc: pos.coords.accuracy ?? 99,
      });
    },
    (err) => onError?.(err),
    { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}

// Request orientation permission on iOS; no-op on Android.
export async function requestOrientationPermission() {
  const AnyDO = window.DeviceOrientationEvent;
  if (AnyDO && typeof AnyDO.requestPermission === 'function') {
    try { return (await AnyDO.requestPermission()) === 'granted'; }
    catch { return false; }
  }
  return true;
}

/*
 * Device orientation -> camera quaternion.
 * Android Chrome's 'deviceorientationabsolute' gives:
 *   alpha: compass heading, rotation around Z (up), 0..360, 0 = device top pointing North
 *   beta : rotation around X, -180..180 (tilt front-back)
 *   gamma: rotation around Y, -90..90   (tilt left-right)
 * Screen orientation must also be accounted for.
 *
 * Three.js camera default: looks along -Z, Y up, X right.
 * We mirror DeviceOrientationControls logic.
 */
const zee = new THREE.Vector3(0, 0, 1);
const q0  = new THREE.Quaternion();
const qScreen = new THREE.Quaternion();
const euler = new THREE.Euler();

export function orientationToQuaternion(quat, alphaDeg, betaDeg, gammaDeg, screenAngleDeg) {
  const alpha = THREE.MathUtils.degToRad(alphaDeg || 0);
  const beta  = THREE.MathUtils.degToRad(betaDeg  || 0);
  const gamma = THREE.MathUtils.degToRad(gammaDeg || 0);
  const orient = THREE.MathUtils.degToRad(screenAngleDeg || 0);

  // 'ZXY' for the device, then pre-multiply by world rotation, then apply screen.
  euler.set(beta, alpha, -gamma, 'YXZ');
  quat.setFromEuler(euler);
  // camera looks out the back of the phone: rotate so looking -Z in world == out-of-screen
  q0.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  quat.multiply(q0);
  // account for screen rotation (portrait/landscape)
  qScreen.setFromAxisAngle(zee, -orient);
  quat.multiply(qScreen);
}

// Start listening; returns an object with latest alpha/beta/gamma and a stop().
export function startOrientation() {
  const state = {
    alpha: 0, beta: 0, gamma: 0,
    absolute: false,
    headingOffset: 0, // manual calibration
  };
  const handler = (e) => {
    // Prefer webkitCompassHeading (iOS) if present
    if (typeof e.webkitCompassHeading === 'number') {
      state.alpha = 360 - e.webkitCompassHeading;
      state.absolute = true;
    } else {
      state.alpha = e.alpha ?? 0;
      state.absolute = e.absolute ?? false;
    }
    state.beta  = e.beta  ?? 0;
    state.gamma = e.gamma ?? 0;
  };
  // Prefer absolute on Android
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', handler, true);
    state._evt = 'deviceorientationabsolute';
  } else {
    window.addEventListener('deviceorientation', handler, true);
    state._evt = 'deviceorientation';
  }
  state.stop = () => window.removeEventListener(state._evt, handler, true);
  return state;
}

export function screenAngleDeg() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') {
    return screen.orientation.angle;
  }
  return window.orientation || 0;
}
