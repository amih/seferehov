// Short tunes for scanning: found, not in any catalogue, found but missing pictures.
// Phones allow sound only after a tap, so the first tap anywhere unlocks it.
// Muting (☰ menu) is kept on this device; a muted chime does not buzz either.
const MUTE = 'seferehov:mute';
let ctx = null;
export function muted() { try { return localStorage.getItem(MUTE) === '1'; } catch { return false; } }
export function setMuted(on) { try { if (on) localStorage.setItem(MUTE, '1'); else localStorage.removeItem(MUTE); } catch { /* no storage */ } }

const unlock = () => {
  try { ctx ??= new (window.AudioContext || window.webkitAudioContext)(); ctx.resume(); } catch { /* no sound */ }
};
document.addEventListener('pointerdown', unlock, { capture: true });

const TUNES = {
  found: [[880, 0, 0.09], [1318.5, 0.09, 0.14]],                        // bright up-step
  missing: [[523.3, 0, 0.12], [659.3, 0.12, 0.12], [784, 0.24, 0.12], [1046.5, 0.36, 0.22]], // arpeggio: "you found something new"
  partial: [[880, 0, 0.09], [1046.5, 0.1, 0.09], [880, 0.2, 0.12]],
};

export function chime(kind) {
  if (muted() || !ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime + 0.02;
  for (const [freq, at, len] of TUNES[kind] ?? []) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + at);
    o.stop(t0 + at + len + 0.02);
  }
  navigator.vibrate?.(kind === 'found' ? 30 : [40, 60, 40]);
}
