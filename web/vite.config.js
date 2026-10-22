import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';


// Every build gets a unique version from the clock + git commit. There is
// nothing to bump by hand: hashed filenames and the precache manifest change
// whenever content changes, and version.json tells running apps a new build exists.
const build = Math.floor(Date.now() / 1000);
let sha = 'dev';
try { sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
const iso = new Date(build * 1000).toISOString();
const version = `${iso.slice(0, 10).replaceAll('-', '.')}.${iso.slice(11, 19).replaceAll(':', '')}-${sha}`;

// MediaPipe's runtime for the book detector (bookai.js), served from this site.
const mediapipeWasm = {
  name: 'seferehov-mediapipe-wasm',
  generateBundle() {
    const dir = fileURLToPath(new URL('../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url));
    for (const f of readdirSync(dir)) this.emitFile({ type: 'asset', fileName: `mediapipe/${f}`, source: readFileSync(dir + f) });
  },
};

const versionFile = {
  name: 'seferehov-version',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version, build }) });
  },
};

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_BUILD__: String(build),
  },
  worker: { format: 'es' },
  server: {
    proxy: { '/api': 'http://127.0.0.1:3870', '/uploads': 'http://127.0.0.1:3870' },
  },
  preview: {
    proxy: { '/api': 'http://127.0.0.1:3870', '/uploads': 'http://127.0.0.1:3870' },
  },
  build: { target: 'es2022' },
  plugins: [
    versionFile,
    mediapipeWasm,
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      injectRegister: false,
      manifestFilename: 'manifest.webmanifest',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,wasm,png,webp,svg,ico}'],
        // The book detector's runtime and model are cached when first used, not installed with the app.
        globIgnores: ['icons/og-*', 'icons/icon-v2-512.png', 'icons/maskable-v2-512.png', 'mediapipe/**', 'models/**'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      manifest: {
        id: '/',
        name: 'סֵפֶרְחוֹב — ספריות רחוב',
        short_name: 'סֵפֶרְחוֹב',
        description: 'ספרים עוברים מיד ליד: מפה משותפת של ספריות רחוב והספרים שיש בהן, וספרים שקוראים מוכרים או מוסרים מהבית.',
        lang: 'he',
        dir: 'rtl',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#9a5b2e', // Android paints its button bar with it: white buttons need a dark bar
        theme_color: '#9a5b2e',
        categories: ['books', 'education', 'lifestyle'],
        icons: [
          { src: '/icons/icon-v2-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-v2-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-v2-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/maskable-v2-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
