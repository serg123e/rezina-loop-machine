// Grid: pulls drum hits and note starts toward the loop's sixteenths. Works on a copy: a track keeps its
// raw frames (what was played) and plays `out`, so the grid can be switched off without loss.
// Used by worklet.js after every take, on load, on a sound change and when the grid is switched.
import { Frame } from './synth.js';

/** How far toward the grid line: 1 = exactly on it. 0.7 keeps a little of the player's feel. */
export const STRENGTH = 0.7;
/** Sixteenths. */
export const DIVISION = 4;

/** Block `p` moved STRENGTH of the way to the nearest line of a grid of `step` blocks (may be ≥ len). */
const toward = (p, step) => Math.round(p + STRENGTH * (Math.round(p / step) * step - p));

/**
 * Drums: every hit moves to its block on the grid (the hit's own bend goes with it). Two hits that land
 * on one block keep their order: the later one takes the next free block.
 */
export function quantizeHits(raw, out, len, step) {
  const S = Frame.SIZE;
  out.set(raw.subarray(0, len * S));
  for (let b = 0; b < len; b++) out[b * S + Frame.EVENT] = Frame.EV_NONE;
  const taken = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    const o = b * S;
    if (raw[o + Frame.EVENT] !== Frame.EV_HIT) continue;
    let q = toward(b, step) % len;
    for (let k = 0; taken[q] && k < len; k++) q = (q + 1) % len;
    taken[q] = 1;
    const d = q * S;
    out[d + Frame.EVENT] = Frame.EV_HIT;
    out[d + Frame.EV_A] = raw[o + Frame.EV_A];
    out[d + Frame.EV_B] = raw[o + Frame.EV_B];
    out[d + Frame.EV_X] = raw[o + Frame.EV_X];
    out[d + Frame.EV_Y] = raw[o + Frame.EV_Y];
    out[d + Frame.BEND] = raw[o + Frame.BEND];
  }
}

/**
 * Bass and lead: each note (a run of frames with the gate on) moves whole, so its slides, bends and
 * vibrato stay as played; only its start is pulled toward the grid. Notes never touch: one gate-off frame
 * stays between them, or the next note would not retrigger the filter. A note that cannot move that far
 * moves less. Frames a note leaves keep their tilt and shake, with the gate off.
 */
export function quantizeNotes(raw, out, len, step) {
  const S = Frame.SIZE;
  out.set(raw.subarray(0, len * S));
  const gate = (b) => raw[(b % len) * S + Frame.GATE] > 0.5;
  // count from `z`, the middle of the longest pause: no note wraps around it, and notes near the
  // loop's end can still move across it
  let on0 = -1;
  for (let b = 0; b < len; b++) if (gate(b)) { on0 = b; break; }
  if (on0 < 0) return; // no notes
  let best = 0, bestStart = 0, run = 0, runStart = 0;
  for (let k = 1; k <= len; k++) {
    const b = (on0 + k) % len;
    if (gate(b)) { run = 0; continue; }
    if (run++ === 0) runStart = b;
    if (run > best) { best = run; bestStart = runStart; }
  }
  if (best === 0) return; // held through the whole loop: nothing to move
  const z = (bestStart + Math.floor(best / 2)) % len;
  const notes = []; // [start, end) counted from z
  for (let u = 1; u < len;) {
    if (!gate(z + u)) { u++; continue; }
    let e = u;
    while (e < len && gate(z + e)) e++;
    notes.push([u, e]);
    u = e;
  }
  for (const [s, e] of notes) {
    for (let u = s; u < e; u++) {
      const o = ((z + u) % len) * S;
      out[o + Frame.GATE] = 0;
      out[o + Frame.COUNT] = 0;
    }
  }
  let prevEnd = 0;
  notes.forEach(([s, e], i) => {
    const n = e - s;
    const at = (z + s) % len;
    let t = s + (toward(at, step) - at);
    const lo = prevEnd + 1;
    const hi = (i + 1 < notes.length ? notes[i + 1][0] - 1 : len) - n;
    t = Math.min(Math.max(t, lo), hi); // s itself always fits between lo and hi
    for (let k = 0; k < n; k++) {
      const from = ((z + s + k) % len) * S;
      out.set(raw.subarray(from, from + S), ((z + t + k) % len) * S);
    }
    prevEnd = t + n;
  });
}
