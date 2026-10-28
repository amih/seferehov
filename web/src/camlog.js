// One camera session's numbers, sent to /api/camera-log when it ends (or the page is
// left), so the camera's limits can be set from how readers really hold their phones.
// No pictures: speeds (as a histogram), time spent in each state, and each photo's
// sharpness, speed and how it was taken. Sessions shorter than 2 seconds are not sent.
const SPEEDS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 6, 10]; // px/tick bucket tops; the last bucket = more / lost

export function cameraLog(kind, info) {
  const started = Date.now();
  const s = { ...info, version: __APP_VERSION__, speed: new Array(SPEEDS.length + 1).fill(0), lost: 0, ticks: 0, alignMs: 0,
    states: {}, photos: [], batches: 0 };
  let state = null, stateAt = started, sent = false;
  const flushState = (now) => { if (state) s.states[state] = (s.states[state] ?? 0) + (now - stateAt); stateAt = now; };
  const onHide = () => end('hidden');
  addEventListener('pagehide', onHide);

  function end(how) {
    if (sent) return;
    sent = true;
    removeEventListener('pagehide', onHide);
    const now = Date.now();
    flushState(now);
    s.ms = now - started;
    s.ended = how;
    s.alignMs = s.ticks ? +(s.alignMs / s.ticks).toFixed(1) : 0;
    if (s.ms < 2000) return;
    const body = JSON.stringify({ kind, stats: s });
    try {
      if (navigator.sendBeacon?.('/api/camera-log', new Blob([body], { type: 'application/json' }))) return;
    } catch {}
    fetch('/api/camera-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  }

  return {
    tick(v, edge, ms) {
      s.ticks++; s.alignMs += ms;
      if (edge) s.lost++;
      const i = SPEEDS.findIndex((top) => v < top);
      s.speed[i < 0 ? SPEEDS.length : i]++;
    },
    state(name) { if (name !== state) { flushState(Date.now()); state = name; } },
    photo(how, sharp, speed) {
      if (s.photos.length < 200) s.photos.push({ at: Date.now() - started, how, sharp: Math.round(sharp), speed: +speed.toFixed(2) });
    },
    batch() { s.batches++; },
    end,
  };
}
