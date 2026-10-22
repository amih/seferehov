import L from 'leaflet';
import 'maplibre-gl/dist/maplibre-gl.css';
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import '@maplibre/maplibre-gl-leaflet';
import { lang } from './i18n.js';

// Vector map from OpenFreeMap (free, no key), recoloured to look like Google Maps,
// with place names in the app's language. Falls back to plain OSM tiles without WebGL.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

setWorkerUrl(workerUrl);

const C = {
  land: '#f5f5f2',
  residential: '#f0efeb',
  park: '#c6ead0',
  wood: '#b9e2c3',
  water: '#9fcdf5',
  sand: '#f4ecd6',
  building: '#e9e8e4',
  buildingLine: '#d9d8d3',
  road: '#ffffff',
  roadCase: '#d6d5cf',
  highway: '#fcd772',
  highwayCase: '#e6b44a',
  text: '#5f6368',
  placeText: '#3c4043',
  waterText: '#4a7fb5',
  halo: '#ffffff',
};

// Checked once, and the test context is released at once: phones allow only a few live
// WebGL contexts, and the oldest (the map's) is lost beyond that.
let webgl;
const hasWebGL = () => {
  if (webgl !== undefined) return webgl;
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    webgl = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { webgl = false; }
  return webgl;
};

let baseStyle;
async function loadStyle() {
  baseStyle ??= fetch(STYLE_URL).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  return structuredClone(await baseStyle);
}

const nameExpr = (l) => (l === 'he'
  ? ['coalesce', ['get', 'name:he'], ['get', 'name']]
  : ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']]);

function googleize(style, l) {
  const hide = new Set(['natural_earth', 'building-3d', 'road_area_pattern', 'park_outline']);
  style.layers = style.layers.filter((x) => !hide.has(x.id));
  for (const layer of style.layers) {
    const id = layer.id;
    const sl = layer['source-layer'];
    const p = (layer.paint ??= {});
    if (layer.type === 'background') p['background-color'] = C.land;
    else if (sl === 'water' && layer.type === 'fill') p['fill-color'] = C.water;
    else if (sl === 'waterway' && layer.type === 'line') p['line-color'] = C.water;
    else if (sl === 'park' && layer.type === 'fill') p['fill-color'] = C.park;
    else if (id === 'landcover_wood') { p['fill-color'] = C.wood; p['fill-opacity'] = 0.8; }
    else if (id === 'landcover_grass' || id === 'landuse_pitch' || id === 'landuse_cemetery') { p['fill-color'] = C.park; p['fill-opacity'] = 0.8; }
    else if (id === 'landcover_sand') p['fill-color'] = C.sand;
    else if (id === 'landuse_residential') { p['fill-color'] = C.residential; p['fill-opacity'] = 1; }
    else if (id === 'landuse_hospital') p['fill-color'] = '#fbe3e1';
    else if (id === 'landuse_school') p['fill-color'] = '#f2ede1';
    else if (id === 'building') { p['fill-color'] = C.building; p['fill-outline-color'] = C.buildingLine; }
    else if (sl === 'transportation' && layer.type === 'line' && !/rail|path|pedestrian|ferry/.test(id)) {
      const major = /motorway|trunk/.test(id) && !/link/.test(id);
      if (/casing/.test(id)) p['line-color'] = major ? C.highwayCase : C.roadCase;
      else p['line-color'] = major ? C.highway : C.road;
    }
    if (layer.type === 'symbol' && layer.layout?.['text-field'] && JSON.stringify(layer.layout['text-field']).includes('"name')) {
      layer.layout['text-field'] = nameExpr(l);
      p['text-halo-color'] = C.halo;
      p['text-halo-width'] = 1.4;
      p['text-color'] = sl === 'place' ? C.placeText : /water/.test(id) ? C.waterText : C.text;
    }
  }
  return style;
}

// Returns a Leaflet layer to add to the map.
export async function basemap() {
  if (hasWebGL()) {
    try {
      const style = googleize(await loadStyle(), lang());
      return L.maplibreGL({ style, attributionControl: { customAttribution: ATTRIBUTION } });
    } catch { /* offline or style unavailable: fall through */ }
  }
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
}
