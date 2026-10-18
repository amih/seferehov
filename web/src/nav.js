// The history holds at most two screens: the map, and whatever is open over it. So the
// phone's back button always returns to the map, and from the map leaves the app.
export function navigate(to, { replace = false } = {}) {
  const toMap = to === '/';
  if (toMap && history.state?.overMap) { history.back(); return; } // popstate renders the map
  const push = location.pathname === '/' && !toMap && !replace;
  const overMap = !toMap && (push || !!history.state?.overMap);
  history[push ? 'pushState' : 'replaceState']({ overMap }, '', to);
  window.dispatchEvent(new Event('seferehov:navigate'));
}

// Opened straight on an inner page (a shared link, a search result): put the map under it.
export function mapUnderneath() {
  if (location.pathname === '/' || history.state?.overMap) return;
  const here = location.pathname + location.search + location.hash;
  history.replaceState(null, '', '/');
  history.pushState({ overMap: true }, '', here);
}

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
