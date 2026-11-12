// A canvas to a JPEG off the page's thread (a worker with an OffscreenCanvas), so the
// live camera keeps checking the phone's steadiness while a 4K photo is encoded (a reader's
// phone took ~9 s per photo, and the checks stalled to one per 1.4 s). Browsers without
// it, or any failure: the canvas's own toBlob.
let worker = null, broken = false, n = 0;
const waiting = new Map();

function getWorker() {
  if (worker || broken) return worker;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') { broken = true; return null; }
  try {
    worker = new Worker(new URL('./encode.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => { const w = waiting.get(data.id); waiting.delete(data.id); data.blob ? w?.ok(data.blob) : w?.fail(new Error(data.error)); };
    worker.onerror = () => { broken = true; worker = null; for (const w of waiting.values()) w.fail(new Error('worker')); waiting.clear(); };
  } catch { broken = true; worker = null; }
  return worker;
}

const viaCanvas = (canvas, quality) => new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));

export async function encodeJpeg(canvas, quality = 0.9) {
  const w = getWorker();
  if (!w) return viaCanvas(canvas, quality);
  try {
    const bitmap = await createImageBitmap(canvas);
    const id = ++n;
    return await new Promise((ok, fail) => { waiting.set(id, { ok, fail }); w.postMessage({ id, bitmap, quality }, [bitmap]); });
  } catch {
    broken = true;
    return viaCanvas(canvas, quality);
  }
}
