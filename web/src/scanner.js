import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

const FORMATS = ['ean_13', 'ean_8', 'upc_a'];
let detectorPromise;

// Native BarcodeDetector where available (Android Chrome); otherwise the
// ZXing WebAssembly ponyfill, served from our own origin so it works offline.
async function getDetector() {
  detectorPromise ??= (async () => {
    if ('BarcodeDetector' in window) {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (supported.includes('ean_13')) return new window.BarcodeDetector({ formats: FORMATS });
    }
    const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill');
    prepareZXingModule({ overrides: { locateFile: (p) => (p.endsWith('.wasm') ? wasmUrl : p) } });
    return new BarcodeDetector({ formats: FORMATS });
  })();
  return detectorPromise;
}

// A book's code: an ISBN (EAN-13, 978/979) or an Israeli Danacode, whose 12 digits are
// printed as a UPC-A barcode (some readers report it as EAN-13 with a leading 0).
const upcValid = (d) => [...d].reduce((a, c, i) => a + Number(c) * (i % 2 ? 1 : 3), 0) % 10 === 0;
const bookCode = (s) => {
  if (/^97[89]\d{10}$/.test(s)) return s;
  const d = /^0\d{12}$/.test(s) ? s.slice(1) : s;
  return /^\d{12}$/.test(d) && upcValid(d) && !/^0{11}/.test(d) ? d : null;
};

// Starts the camera in <video>, calls onIsbn(isbn) for every new book barcode.
// Returns stop().
export async function startScanner(video, onIsbn) {
  const detector = await getDetector();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  await video.play();

  let running = true;
  let last = '';
  let lastAt = 0;
  const tick = async () => {
    if (!running) return;
    if (video.readyState >= 2) {
      try {
        for (const code of await detector.detect(video)) {
          const v = bookCode(code.rawValue);
          if (v && (v !== last || Date.now() - lastAt > 4000)) {
            last = v;
            lastAt = Date.now();
            navigator.vibrate?.(60);
            onIsbn(v);
          }
        }
      } catch { /* frame not ready */ }
    }
    setTimeout(tick, 200);
  };
  tick();
  return () => { running = false; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
}

// One look at the live camera picture: the book code in it, or null.
export async function detectFrame(video) {
  const detector = await getDetector();
  try {
    return (await detector.detect(video)).map((c) => bookCode(c.rawValue)).find(Boolean) ?? null;
  } catch { return null; } // frame not ready
}

// For a still photo of a back cover.
export async function scanImage(blob) {
  const detector = await getDetector();
  const bmp = await createImageBitmap(blob);
  try {
    return (await detector.detect(bmp)).map((c) => bookCode(c.rawValue)).find(Boolean) ?? null;
  } finally { bmp.close(); }
}
