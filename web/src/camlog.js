// One camera session's numbers, sent to /api/camera-log when it ends (or the page is
// left), so the cameras can be tuned from how readers really use them, on the phones
// they really have. No pictures: the phone, its system, browser and camera (device()),
// how long the camera took to open and show a first picture, speeds (as a histogram),
// time spent in each state, each photo (how it was taken, how long it took, sharpness,
// size, time to encode), each book (front → back, barcode found how and when) and the
// outbox ids of what was sent, so the upload times (server/src/receipts.js) and the
// scans can be matched to the session later. Sessions shorter than 2 seconds are not sent.
const SPEEDS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 6, 10]; // px/tick bucket tops; the last bucket = more / lost
const MAX_PHOTOS = 300, MAX_EVENTS = 300;

const sessionId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

// The phone, once per page: model and system version (Android Chrome gives them through
// userAgentData; iPhones only through the user agent string, kept by the server), the
// browser, screen, cores, memory, network, storage, graphics chip (the book detector
// runs on it) and whether the app is installed.
let devicePromise = null;
export function device() {
  devicePromise ??= (async () => {
    const n = navigator, d = {};
    try {
      if (n.userAgentData) {
        d.uaData = await n.userAgentData.getHighEntropyValues(['model', 'platform', 'platformVersion', 'architecture', 'bitness', 'fullVersionList', 'formFactors', 'wow64'])
          .catch(() => ({ platform: n.userAgentData.platform, mobile: n.userAgentData.mobile }));
        d.uaData.mobile ??= n.userAgentData.mobile;
      }
    } catch {}
    d.ua = n.userAgent;
    d.platform = n.platform;
    d.lang = n.language;
    d.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    d.cores = n.hardwareConcurrency ?? null;
    d.memGB = n.deviceMemory ?? null;
    d.touch = n.maxTouchPoints ?? 0;
    d.screen = { w: screen.width, h: screen.height, dpr: devicePixelRatio, view: `${innerWidth}x${innerHeight}`, orient: screen.orientation?.type ?? null, depth: screen.colorDepth };
    d.installed = matchMedia('(display-mode: standalone)').matches || n.standalone === true;
    const c = n.connection;
    if (c) d.net = { type: c.type ?? null, eff: c.effectiveType ?? null, down: c.downlink ?? null, rtt: c.rtt ?? null, save: !!c.saveData };
    d.online = n.onLine;
    try { const e = await n.storage?.estimate?.(); if (e) d.storageMB = { used: Math.round(e.usage / 1e6), quota: Math.round(e.quota / 1e6) }; } catch {}
    try { d.persisted = await n.storage?.persisted?.(); } catch {}
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      if (ext) d.gpu = { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) };
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {}
    d.webgpu = 'gpu' in n;
    d.has = { imageCapture: 'ImageCapture' in window, barcodeDetector: 'BarcodeDetector' in window, offscreen: 'OffscreenCanvas' in window,
      bgSync: 'SyncManager' in window, locks: !!n.locks, vibrate: 'vibrate' in n, wakeLock: 'wakeLock' in n };
    return d;
  })();
  return devicePromise;
}

// The camera actually given (the size asked for is not always the size got), what it can
// do, and, where the browser can take real photos, the photo sizes it offers.
async function cameraInfo(track) {
  if (!track) return null;
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
  const r = { label: track.label?.slice(0, 80) };
  try { r.settings = pick(track.getSettings?.(), ['width', 'height', 'frameRate', 'aspectRatio', 'facingMode', 'resizeMode', 'focusMode', 'focusDistance', 'exposureMode', 'exposureCompensation', 'exposureTime', 'iso', 'whiteBalanceMode', 'colorTemperature', 'zoom', 'torch', 'brightness', 'sharpness']); } catch {}
  try { r.caps = pick(track.getCapabilities?.(), ['width', 'height', 'frameRate', 'facingMode', 'resizeMode', 'focusMode', 'focusDistance', 'exposureMode', 'exposureTime', 'iso', 'whiteBalanceMode', 'zoom', 'torch']); } catch {}
  if ('ImageCapture' in window) {
    try {
      const p = await new ImageCapture(track).getPhotoCapabilities();
      r.photo = { w: p.imageWidth?.max, h: p.imageHeight?.max, redEye: p.redEyeReduction, flash: p.fillLightMode };
    } catch {}
  }
  return r;
}

// kind: shelf | covers | stack | barcode. info: anything fixed for the session (screen, limits).
export function cameraLog(kind, info = {}) {
  const started = Date.now();
  const id = sessionId();
  const s = { ...info, sid: id, version: __APP_VERSION__, build: __APP_BUILD__, speed: new Array(SPEEDS.length + 1).fill(0), lost: 0, ticks: 0, alignMs: 0,
    states: {}, photos: [], books: [], events: [], counts: {}, uploads: [], batches: 0 };
  let state = null, stateAt = started, sent = false, dev = null, cam = null;
  device().then((d) => { dev = d; }).catch(() => {});
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
    if (s.ms < 2000 && !s.openError) return; // a camera that would not open counts, however short
    const body = JSON.stringify({ kind, sid: id, stats: s, device: dev, camera: cam });
    try {
      if (navigator.sendBeacon?.('/api/camera-log', new Blob([body], { type: 'application/json' }))) return;
    } catch {}
    fetch('/api/camera-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  }

  const at = () => Date.now() - started;
  return {
    id,
    at,
    // The camera is open: how long getUserMedia took, the track got, and the first frame.
    opened(track, video, askedAt) {
      s.openMs = Date.now() - askedAt;
      s.cam = video ? `${video.videoWidth}x${video.videoHeight}` : s.cam;
      cameraInfo(track).then((c) => { cam = c; }).catch(() => {});
      if (video?.requestVideoFrameCallback) video.requestVideoFrameCallback(() => { s.firstFrameMs ??= Date.now() - askedAt; });
    },
    failed(err) { s.openError = String(err?.name ?? err).slice(0, 60); },
    tick(v, edge, ms) {
      s.ticks++; s.alignMs += ms;
      if (edge) s.lost++;
      const i = SPEEDS.findIndex((top) => v < top);
      s.speed[i < 0 ? SPEEDS.length : i]++;
    },
    state(name) { if (name !== state) { flushState(Date.now()); state = name; } },
    // how the photo was taken, its sharpness and the speed/shake then; extra: side, wait
    // (ms from ready to photo), encode ms, bytes, w×h, … Returns the photo's record, to
    // which the encode time and size are added once known.
    photo(how, sharp, speed, extra = {}) {
      const p = { at: at(), how, sharp: Math.round(sharp ?? 0), speed: speed == null ? null : +speed.toFixed(2), ...extra };
      if (s.photos.length < MAX_PHOTOS) s.photos.push(p);
      return p;
    },
    book(b) { if (s.books.length < MAX_PHOTOS) s.books.push({ at: at(), ...b }); },
    event(name, data = {}) { if (s.events.length < MAX_EVENTS) s.events.push({ at: at(), e: name, ...data }); },
    count(k, by = 1) { s.counts[k] = (s.counts[k] ?? 0) + by; },
    upload(outboxId, what) { if (outboxId && s.uploads.length < MAX_PHOTOS) s.uploads.push({ id: outboxId, what, at: at() }); },
    batch() { s.batches++; },
    end,
  };
}
