// Is there a book in front of the camera? A small image model on the phone (MediaPipe's
// MobileNet-V3 image embedder) turns the picture into 1024 numbers, and a layer trained
// for Seferehov (bookhead.json: covers photographed in the app, books in a row on a
// table, Open Library covers laid on floors and tables, against rooms, floors, tables,
// desks and screens) weighs them into the chance that a book fills the picture.
// Measured on a phone video of a row of books it had not seen: 92 frames of 92 found;
// photos of rooms and floors taken for a book: 1 in 127.
// It runs in a worker (bookai.worker.js), so the camera keeps going while it thinks.
// The model (4 MB) and MediaPipe's runtime (9 MB) come from this server, only when the
// many-books camera is opened, and stay cached on the phone (sw.js).

let ready = null;

// Starts loading. Resolves to a detector, or null if this phone cannot run it:
//   look(video): asks about the picture now, unless still busy with the last one;
//   latest: { p, at } — the last answer (0..1) and when its picture was taken.
export function loadBookModel() {
  ready ??= new Promise((resolve) => {
    let worker;
    try { worker = new Worker(new URL('./bookai.worker.js', import.meta.url), { type: 'module' }); } catch { resolve(null); return; }
    const detector = { latest: null, busy: false, ms: null };
    let id = 0, asked = 0;
    worker.onmessage = ({ data }) => {
      if (data.type === 'ready') resolve(detector);
      else if (data.type === 'error') { console.warn('book detector not available:', data.message); worker.terminate(); resolve(null); }
      else if (data.type === 'score' && data.id === id) { detector.latest = { p: data.p, at: asked }; detector.ms = data.ms; detector.busy = false; }
    };
    worker.onerror = (e) => { console.warn('book detector not available:', e.message); resolve(null); };
    detector.look = async (video) => {
      if (detector.busy || !video.videoWidth) return;
      detector.busy = true;
      const at = Date.now();
      try {
        const image = await createImageBitmap(video, { resizeWidth: 240, resizeHeight: Math.round((240 * video.videoHeight) / video.videoWidth) });
        asked = at;
        worker.postMessage({ type: 'score', id: ++id, image }, [image]);
      } catch { detector.busy = false; }
    };
    worker.postMessage({ type: 'init' });
  });
  return ready;
}
