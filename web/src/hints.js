// What the phone can tell about where the reader is, for the one camera on the map
// (docs/ONE_CAMERA_PLAN.md): the server guesses home / a known library / a new library from it
// (server/src/situation.js). No new permission prompts: the camera and the location the app
// already asks for, the kind of network, the camera's exposure and the clock. No microphone.
//
// Privacy: the places the reader confirmed as home are kept on this phone only. Near one of
// them, the phone sends "near home" and no coordinates at all.
const HOME_KEY = 'seferehov:homePoints';
const SESSION_KEY = 'seferehov:sessionPoints';
export const HOME_M = 150;

// Metres between two points (equirectangular: fine at these distances).
export function metres(a, b) {
  const k = Math.PI / 180, x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k), y = (b.lat - a.lat) * k;
  return Math.hypot(x, y) * 6371000;
}

// true = within HOME_M (or the fix's accuracy, up to 300 m) of a home point; false = home points
// known and none near; null = no home points yet, or no fix.
export function nearHome(points, pos) {
  if (!points?.length || !pos) return null;
  const r = Math.max(HOME_M, Math.min(pos.acc ?? 0, 300));
  return points.some((p) => metres(p, pos) <= r);
}

const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } };
export const homePoints = () => read(HOME_KEY, []);

// The fix of each recent session, on the phone, so that an answer "home" can teach it.
export function rememberSession(id, pos) {
  if (!id || !pos) return;
  const all = read(SESSION_KEY, {});
  all[id] = { lat: +pos.lat.toFixed(5), lon: +pos.lon.toFixed(5), at: Date.now() };
  write(SESSION_KEY, Object.fromEntries(Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 30)));
}
// The reader said (or accepted) that this session was at home: its place becomes a home point.
export function learnHome(id) {
  const p = read(SESSION_KEY, {})[id];
  if (!p) return;
  const pts = homePoints();
  if (pts.some((x) => metres(x, p) < 50)) return;
  write(HOME_KEY, [...pts, { lat: p.lat, lon: p.lon }].slice(-5));
}

// Collects while the camera is open. track: the camera's video track (exposure, colour of the light).
export function startHints(track = null) {
  let fix = null, watch = null;
  if (navigator.geolocation) {
    watch = navigator.geolocation.watchPosition((p) => {
      const c = p.coords;
      if (!fix || c.accuracy <= fix.acc || Date.now() - fix.at > 60000) fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, at: Date.now() };
    }, () => {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }
  const exps = [], cts = [];
  function sample() {
    const s = track?.getSettings?.() ?? {};
    // Chrome gives the exposure time in units of 100 µs (Image Capture).
    if (Number.isFinite(s.exposureTime) && s.exposureTime > 0) exps.push(s.exposureTime / 10000);
    if (Number.isFinite(s.colorTemperature) && s.colorTemperature > 0) cts.push(s.colorTemperature);
  }
  const timer = setInterval(sample, 2000);
  sample();
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null);
  return {
    get fix() { return fix; },
    snapshot() {
      const now = new Date();
      const near = nearHome(homePoints(), fix);
      const h = { nearHome: near, net: navigator.connection?.type ?? null, exp: median(exps), ct: median(cts), hour: now.getHours(), dow: now.getDay() };
      if (fix && near !== true) Object.assign(h, { lat: +fix.lat.toFixed(5), lon: +fix.lon.toFixed(5), acc: Math.round(fix.acc) });
      return Object.fromEntries(Object.entries(h).filter(([, v]) => v != null));
    },
    stop() { clearInterval(timer); if (watch != null) navigator.geolocation.clearWatch(watch); },
  };
}
