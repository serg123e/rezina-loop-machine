// Builds web/sessions/demo.rez, opened by the web app's ?session=demo link: the "Всё вместе" phrase of
// docs/sound-lab.html, from the page's own gesture script, sampled once per 192-sample block like the apps
// record it. Bass → track 1 (Growl), drums → 2 (808), lead → 3 (Pluck). Run after changing the page's phrase:
//   node tools/make-demo-session.mjs
// It prints what it wrote, after playing it twice through the web engine (bad = NaN samples, must be 0).
import { readFileSync, writeFileSync } from 'node:fs';
import { encode, decode } from '../web/sessions.js';
import { Frame, Mode, MODES, BLOCK } from '../web/synth.js';
import { Engine } from '../web/worklet.js';

const repo = new URL('..', import.meta.url);
const html = readFileSync(new URL('docs/sound-lab.html', repo), 'utf8');
const script = html.slice(html.indexOf('// ---- The gesture script'), html.indexOf('/** Renders two passes'));
const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const { BASS, LEAD, DRUM_HITS, DRUM_CTRL } = new Function('TAU', 'clamp', script + '\nreturn { BASS, LEAD, DRUM_HITS, DRUM_CTRL };')(TAU, clamp);

const SR = 48000, BPM = 100, BEATS = 16;
const blocks = Math.round(BEATS * 60 / BPM * SR / BLOCK); // 2400
const beatOf = (b) => b * BLOCK / SR / (60 / BPM);

// screen for the band shapes and hit flashes: a 1080 × 2400 phone, as in BandView
const W = 1080, H = 2400, PEG = { x: W / 2, y: H * 0.94 }, DIAG = Math.hypot(W, H);
const radius = (t) => DIAG * (0.05 + 0.8 * t);
function pointAt(t, angle) {
  const r = radius(t);
  return [(PEG.x + r * Math.sin(angle)) / W, (PEG.y - r * Math.cos(angle)) / H];
}
function setShape(f, o, pts) {
  f[o + Frame.COUNT] = pts.length;
  pts.forEach(([x, y], i) => { f[o + Frame.PTS + 2 * i] = x; f[o + Frame.PTS + 2 * i + 1] = y; });
}

function melodicTrack(ctrl) {
  const f = new Float32Array(blocks * Frame.SIZE), c = {};
  for (let b = 0; b < blocks; b++) {
    const o = b * Frame.SIZE;
    ctrl(beatOf(b), c);
    f[o + Frame.TENSION] = c.t;
    f[o + Frame.BEND] = c.bend;
    f[o + Frame.GATE] = c.gate ? 1 : 0;
    f[o + Frame.TILT_X] = c.tiltX;
    f[o + Frame.TILT_Y] = c.tiltY;
    f[o + Frame.SHAKE] = c.shake;
    if (c.gate) setShape(f, o, [[0.5, 0.94], pointAt(c.t, c.tiltX * Math.PI / 4)]); // tilt drawn as where the band points
  }
  return f;
}

/** The page's drum zones are 0.3/0.7, the apps' 0.33/0.66: keep each hit at the same spot of its zone. */
function appTune(t) {
  if (t < 0.3) return t;
  if (t < 0.7) return 0.33 + (t - 0.3) / 0.4 * 0.33;
  return t;
}

function drumTrack() {
  const f = new Float32Array(blocks * Frame.SIZE), c = {}, queue = [];
  let hi = 0;
  for (let b = 0; b < blocks; b++) {
    const o = b * Frame.SIZE, tb = beatOf(b), tb1 = beatOf(b + 1);
    DRUM_CTRL(tb, c);
    while (hi < DRUM_HITS.length && DRUM_HITS[hi][0] < tb1) queue.push(DRUM_HITS[hi++]);
    f[o + Frame.TENSION] = c.t;
    f[o + Frame.BEND] = c.bend;
    f[o + Frame.GATE] = c.held ? 1 : 0; // drums: fingers on the band shape the shaker
    f[o + Frame.SHAKE] = c.shake;
    if (c.held) setShape(f, o, [[0.5, 0.94], pointAt(c.t, 0.2)]);
    const h = queue.shift(); // one hit per block, as the apps record them
    if (h) {
      const tune = appTune(h[1]);
      f[o + Frame.EVENT] = Frame.EV_HIT;
      f[o + Frame.EV_A] = tune;
      f[o + Frame.EV_B] = h[2];
      f[o + Frame.BEND] = h[3]; // the hit's own bend: the apps take it from the frame
      // where the flash is drawn: the page's hats sit farther out than a finger reaches on screen
      const [x, y] = pointAt(Math.min(tune, 0.72), tune < 0.33 ? 0 : tune < 0.66 ? -0.25 : 0.15);
      f[o + Frame.EV_X] = x;
      f[o + Frame.EV_Y] = y;
    }
  }
  return f;
}

const session = {
  sampleRate: SR, loopLen: blocks, loopBeats: BEATS, bpm: BPM,
  tracks: [
    { mode: Mode.BASS.id, muted: false, frames: melodicTrack(BASS) },
    { mode: Mode.DRUMS.id, muted: false, frames: drumTrack() },
    { mode: Mode.LEAD.id, muted: false, frames: melodicTrack(LEAD) },
    { mode: Mode.LEAD.id, muted: false, frames: null },
  ],
};
const bytes = await encode(session);
const out = new URL('web/sessions/demo.rez', repo);
writeFileSync(out, bytes);

// check: decode it and play two loops through the engine
const back = await decode(bytes);
const e = new Engine(SR, () => {});
e.command({ t: 'metronome', on: false });
e.command({ t: 'load', session: back });
const L = new Float32Array(128), R = new Float32Array(128);
let peak = 0, sum = 0, n = 0, bad = 0;
const hits = back.tracks[1].frames.filter((v, i) => i % Frame.SIZE === Frame.EVENT && v === Frame.EV_HIT).length;
for (let k = 0; k < 2 * blocks * BLOCK / 128; k++) {
  e.render(L, R);
  for (let i = 0; i < 128; i++) { if (!Number.isFinite(L[i])) bad++; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); sum += L[i] * L[i]; n++; }
}
console.log(`${out.pathname}: ${bytes.length} bytes, ${blocks} blocks = ${(blocks * BLOCK / SR).toFixed(1)} s, ${hits}/${DRUM_HITS.length} hits, ` +
  `modes ${back.tracks.map((t) => MODES[t.mode].short).join('/')}, rms ${Math.sqrt(sum / n).toFixed(3)}, peak ${peak.toFixed(3)}, bad ${bad}`);
