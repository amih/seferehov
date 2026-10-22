// The book detector (bookai.js) off the main thread, so the camera never waits for it.
import { FilesetResolver, ImageEmbedder } from '@mediapipe/tasks-vision';
import head from './bookhead.json';

// MediaPipe loads its runtime with importScripts, which module workers do not have (it
// throws): this one does the same, a synchronous fetch run in the worker's global scope.
self.importScripts = (...urls) => {
  for (const url of urls) {
    const x = new XMLHttpRequest();
    x.open('GET', url, false);
    x.send();
    if (x.status !== 200) throw new Error(`${url}: ${x.status}`);
    (0, eval)(x.responseText);
  }
};

let embedder = null;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const vision = await FilesetResolver.forVisionTasks('/mediapipe');
      embedder = await ImageEmbedder.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/mobilenet_v3_small.tflite', delegate: 'CPU' },
        l2Normalize: true, quantize: false, runningMode: 'IMAGE',
      });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message ?? err) });
    }
  } else if (data.type === 'score' && embedder) {
    const t0 = performance.now();
    const e = embedder.embed(data.image).embeddings[0].floatEmbedding;
    data.image.close();
    let z = head.bias;
    for (let i = 0; i < head.weights.length; i++) z += head.weights[i] * e[i];
    self.postMessage({ type: 'score', id: data.id, p: 1 / (1 + Math.exp(-z)), ms: Math.round(performance.now() - t0) });
  }
};
