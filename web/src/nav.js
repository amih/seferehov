import { scrollPos } from './frame.js';
// The app's history: a stack of screens with the map at the bottom (Ami, 22 Nov 2026; until
// then it held only the map and one screen, so back from a book skipped its library).
//
// Each history entry's state carries the trail of screens under it, the map first:
//   { depth, trail: [..., url], scroll }
// Rules:
// - A link to another screen adds a step, so the phone's back button returns to the screen it
//   came from: map → library → book → back → library → back → map → back leaves the app.
// - Going to a screen already in the trail (the map, "← back to the library", the library after
//   its edit is saved) goes back down to it instead of piling up a copy: no loops of
//   library → book → library → book to press back through.
// - replace: a redirect (sign-in, a merged library), the book pager (next/previous book) and a
//   search being typed take the current step's place.
// - Back returns to where the screen was scrolled to.
const MAX_TRAIL = 50; // urls kept for lookup; depth still counts every step

const urlOf = (loc) => loc.pathname + loc.search + loc.hash;

// The state for an entry whose state predates the trail (or has none).
export function stateFor(state, here) {
  if (state?.trail) return state;
  if (new URL(here, 'https://x').pathname === '/') return { ...state, depth: 0, trail: [here] };
  if (state?.overMap) return { ...state, depth: 1, trail: ['/', here] }; // older versions
  return null;
}

// What navigate() does, without touching the browser (unit-tested).
//   { go: -n }               back down to a screen already in the trail
//   { push: state, url }     a new step
//   { replace: state, url }  in place of the current step
export function plan(state, here, to, { replace = false } = {}) {
  const s = stateFor(state, here) ?? { depth: 0, trail: [here] };
  const toPath = new URL(to, 'https://x').pathname;
  const top = s.trail.length - 1;
  if (to !== here) {
    // The map is always the bottom step.
    if (toPath === '/' && s.depth > 0) return { go: -s.depth };
    if (toPath === '/' && s.depth === 0) replace = true;
    const k = s.trail.lastIndexOf(to, top - 1);
    if (k >= 0 && s.depth - (top - k) >= 0) return { go: k - top };
  }
  const { scroll, layer, ...rest } = s;
  if (replace || to === here) return { replace: { ...rest, trail: [...s.trail.slice(0, -1), to] }, url: to };
  return { push: { ...rest, depth: s.depth + 1, trail: [...s.trail, to].slice(-MAX_TRAIL) }, url: to };
}

export function navigate(to, { replace = false } = {}) {
  // A picture viewer open over the screen goes with it. Its history step is reused: the new
  // screen takes its place, or a step back counts it.
  const layer = dropLayer();
  const here = urlOf(location);
  const p = plan(history.state, here, to, { replace });
  // Remember where this screen was scrolled to, for coming back to it.
  if (!p.replace && !layer) history.replaceState({ ...(stateFor(history.state, here) ?? { depth: 0, trail: [here] }), scroll: scrollPos() }, '');
  if (p.go) { history.go(p.go - (layer ? 1 : 0)); return; } // popstate renders the screen
  history[p.push && !layer ? 'pushState' : 'replaceState'](p.push ?? p.replace, '', p.url);
  window.dispatchEvent(new Event('seferehov:navigate'));
}

// Changes the address of the current step without drawing (the screen has done it itself).
export function replaceUrl(url) {
  history.replaceState(plan(history.state, urlOf(location), url, { replace: true }).replace ?? history.state, '', url);
}

// Opened straight on an inner page (a shared link, a search result): put the map under it.
// Entries from older versions get a trail.
export function mapUnderneath() {
  const here = urlOf(location);
  const s = stateFor(history.state, here);
  if (s) { if (s !== history.state) history.replaceState(s, ''); return; }
  history.replaceState({ depth: 0, trail: ['/'] }, '', '/');
  history.pushState({ depth: 1, trail: ['/', here] }, '', here);
}

// Where to scroll after a back/forward step has drawn its screen (null: the top).
export const savedScroll = () => history.state?.scroll ?? null;

// A full-screen layer (the picture viewer) takes one history step, so back closes it.
// Returns close(): call it to close the layer from a button.
export function backCloses(onClose) {
  history.pushState({ ...history.state, layer: true }, '', location.href);
  layerClose = onClose;
  return () => { if (layerClose === onClose) history.back(); };
}
let layerClose = null;
// popstate: true when it only closed a layer (the screen stays as it is).
export function closeLayer() {
  if (!layerClose) return false;
  const f = layerClose;
  layerClose = null;
  f();
  return true;
}
// Leaving the screen while a layer is open: close it. True when one was open.
function dropLayer() {
  if (!layerClose || !history.state?.layer) { layerClose = null; return false; }
  const f = layerClose;
  layerClose = null;
  f();
  return true;
}
