// Grid (quantize.js) and the latency shift of takes (worklet.js).
import { quantizeHits, quantizeNotes, STRENGTH } from '../quantize.js';
import { Frame, Mode, BLOCK } from '../synth.js';
import { Engine } from '../worklet.js';

let failed = false;
const expect = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const S = Frame.SIZE;
const len = 600; // one bar at 100 bpm; a sixteenth is 37.5 blocks
const step = 37.5;
const hitsAt = (f) => { const h = []; for (let b = 0; b < len; b++) if (f[b * S + Frame.EVENT] === Frame.EV_HIT) h.push(b); return h; };
const notesIn = (f) => {
  const n = [];
  for (let b = 0; b < len; b++) {
    const on = f[b * S + Frame.GATE] > 0.5, prev = f[((b - 1 + len) % len) * S + Frame.GATE] > 0.5;
    if (on && !prev) { let e = b; while (e < len && f[e * S + Frame.GATE] > 0.5) e++; n.push([b, e]); }
  }
  return n;
};

// drums: 40 → line 37.5 → 38.25 → 38; 70 → 75 → 73.5 → 74; 148 and 151 both near 150 → 149, 150 (order kept);
// 599 → 600 = 0
{
  const raw = new Float32Array(len * S), out = new Float32Array(len * S);
  for (const [b, tune] of [[40, 0.1], [70, 0.5], [148, 0.9], [151, 0.9], [599, 0.1]]) {
    raw[b * S + Frame.EVENT] = Frame.EV_HIT;
    raw[b * S + Frame.EV_A] = tune;
  }
  quantizeHits(raw, out, len, step);
  expect('hits pulled 70 % toward sixteenths', hitsAt(out), [0, 38, 74, 149, 150]);
  expect('a hit keeps its tune', out[74 * S + Frame.EV_A], Math.fround(0.5));
  expect('raw is untouched', hitsAt(raw), [40, 70, 148, 151, 599]);
}

// notes: 80 → line 75 → 76.5 → 77; 142 → 150 → 147.6 → 148 (after 137 + a gap); 300 is on a line
{
  const raw = new Float32Array(len * S), out = new Float32Array(len * S);
  const note = (s, e) => { for (let b = s; b < e; b++) { raw[b * S + Frame.GATE] = 1; raw[b * S + Frame.TENSION] = (b - s) / 100; } };
  note(80, 140); note(142, 180); note(300, 330);
  quantizeNotes(raw, out, len, step);
  expect('notes: starts pulled, lengths kept', notesIn(out), [[77, 137], [148, 186], [300, 330]]);
  expect('a note keeps its inner gesture', out[(77 + 10) * S + Frame.TENSION], Math.fround(0.1));
  expect('frames a note left have the gate off', out[137 * S + Frame.GATE] === 0 && out[139 * S + Frame.GATE] === 0, true);
}
{
  // legato: notes one frame apart cannot cross; the second is held back to keep the gap
  const raw = new Float32Array(len * S), out = new Float32Array(len * S);
  const note = (s, e) => { for (let b = s; b < e; b++) raw[b * S + Frame.GATE] = 1; };
  note(20, 77); note(78, 120); // the second wants 76, inside the first: it stops one frame after the first
  quantizeNotes(raw, out, len, step);
  const n = notesIn(out);
  expect('legato notes never touch', n.length === 2 && n[1][0] > n[0][1], true);
  expect('…and keep their lengths', n.map(([s, e]) => e - s), [57, 42]);
}
{
  // a note across the loop's end moves too
  const raw = new Float32Array(len * S), out = new Float32Array(len * S);
  for (const b of [595, 596, 597, 598, 599, 0, 1, 2]) raw[b * S + Frame.GATE] = 1;
  quantizeNotes(raw, out, len, step);
  const on = []; for (let b = 0; b < len; b++) if (out[b * S + Frame.GATE] > 0.5) on.push(b);
  expect('wrapping note: start 595 → 598.5 → 599, 8 frames long', on, [0, 1, 2, 3, 4, 5, 6, 599]);
}

// engine: a later take lands `comp` blocks earlier than it was played
{
  const e = new Engine(48000, () => {});
  e.command({ t: 'metronome', on: false });
  e.command({ t: 'grid', on: false });
  e.command({ t: 'latency', seconds: 0.04 }); // 10 blocks at 250 per second
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  const shape = new Float32Array(13);
  const run = (blocks) => { for (let i = 0; i < blocks; i++) e.render(L, R); };
  e.command({ t: 'live', tension: 0.5, bend: 0, gate: true, aim: 0, shape });
  e.command({ t: 'rec' }); run(500); e.command({ t: 'rec' }); // first take: 500 blocks, free
  expect('first take: the last comp blocks are silent', e.tracks[0].raw[495 * S + Frame.GATE], 0);
  expect('first take: the rest is kept', e.tracks[0].raw[489 * S + Frame.GATE], 1);
  e.command({ t: 'live', tension: 0, bend: 0, gate: false, aim: 0, shape });
  e.command({ t: 'select', i: 1 });
  e.command({ t: 'mode', i: 1, mode: Mode.DRUMS.id });
  run(100 - e.pos);           // playhead at block 100
  e.command({ t: 'rec' });
  run(50);                    // block 150
  e.command({ t: 'hit', tune: 0.1, vel: 1, x: 0, y: 0 });
  run(500);
  const at = []; for (let b = 0; b < 500; b++) if (e.tracks[1].raw[b * S + Frame.EVENT] === Frame.EV_HIT) at.push(b);
  expect('later take: a hit played at block 150 is stored at 140', at, [140]);
  e.command({ t: 'grid', on: true });
  const q = []; for (let b = 0; b < 500; b++) if (e.tracks[1].frames[b * S + Frame.EVENT] === Frame.EV_HIT) q.push(b);
  expect('grid on: played at the pulled block, raw unchanged', [q.length, q[0] !== 140, e.tracks[1].raw[140 * S + Frame.EVENT]], [1, true, Frame.EV_HIT]);
}
console.log(`(strength ${STRENGTH})`);
process.exit(failed ? 1 : 0);
