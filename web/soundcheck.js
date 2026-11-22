// Every sound vs the comparison page's numbers: the gestures of Android VoiceTest, rendered by synth.js.
// Shared by `npm test` (test/soundcheck.mjs) and the page (?test=sound), which runs it on a phone to
// find a browser that computes the synth wrong.
import { Voice, MODES, Mode, Kind, Frame, BLOCK, nextMode } from './synth.js';
import { Engine } from './worklet.js';

const n = BLOCK;

function render(modeId, setFrame) {
  const v = new Voice(48000);
  const f = new Float32Array(Frame.SIZE);
  const tl = new Float32Array(n), tr = new Float32Array(n), dl = new Float32Array(n), dr = new Float32Array(n);
  let sum = 0, diff = 0, pl = 0, pr = 0, bad = 0;
  const blocks = 250;
  for (let b = 0; b < blocks; b++) {
    setFrame(f, b);
    tl.fill(0); tr.fill(0); dl.fill(0); dr.fill(0);
    v.render(tl, tr, dl, dr, n, f, 0, modeId, 100);
    for (let i = 0; i < n; i++) {
      const l = tl[i] + dl[i], r = tr[i] + dr[i];
      if (!Number.isFinite(l) || !Number.isFinite(r) || Math.abs(l) >= 1 || Math.abs(r) >= 1) bad++;
      sum += l * l + r * r;
      diff += (l - pl) ** 2 + (r - pr) ** 2;
      pl = l; pr = r;
    }
  }
  const count = 2 * blocks * n;
  return [Math.sqrt(sum / count), Math.sqrt(diff / count), bad];
}

function measure(m, tiltX, tiltY) {
  // the page's snare is at tune 0.5 of its 0.3–0.7 zone; 0.495 is the same spot in the app's 0.33–0.66
  const hits = { 0: 0.1, 60: 0.495, 120: 0.9 };
  const freq = m.kind === Kind.BASS ? 55 : m.kind === Kind.LEAD ? 329.63 : 60;
  return render(m.id, (f, b) => {
    f[Frame.GATE] = m.drums ? 0 : 1;
    f[Frame.TENSION] = m.tension(freq);
    f[Frame.BEND] = 0.3;
    f[Frame.TILT_X] = tiltX;
    f[Frame.TILT_Y] = tiltY;
    f[Frame.EVENT] = Frame.EV_NONE;
    if (m.drums && hits[b] !== undefined) {
      f[Frame.EVENT] = Frame.EV_HIT;
      f[Frame.EV_A] = hits[b];
      f[Frame.EV_B] = 1;
    }
  });
}

function shaken(m, held) {
  return render(m.id, (f) => {
    f[Frame.GATE] = held ? 1 : 0;
    f[Frame.TENSION] = held ? 0.8 : 0;
    f[Frame.BEND] = held ? 0.6 : 0.3;
    f[Frame.SHAKE] = 0.8;
  });
}

/** Sample-to-sample jumps over 0.25 in 2 s of a held Growl note through the whole engine (master included). */
function engineJumps() {
  const e = new Engine(48000, () => {});
  e.command({ t: 'metronome', on: false });
  e.command({ t: 'live', tension: 0.3, bend: 0.2, gate: true, aim: 0, shape: new Float32Array(1 + 2 * Frame.MAX_PTS) });
  const L = new Float32Array(128), R = new Float32Array(128);
  let jumps = 0, pl = 0, pr = 0;
  for (let k = 0; k < 2 * 48000 / 128; k++) {
    e.render(L, R);
    for (let i = 0; i < 128; i++) {
      if (Math.abs(L[i] - pl) > 0.25 || Math.abs(R[i] - pr) > 0.25) jumps++;
      pl = L[i]; pr = R[i];
    }
  }
  return jumps;
}

// level rms, level brightness, tilted rms, tilted brightness
const PAGE = {
  BASS: [0.2757, 0.00735, 0.2755, 0.01176],
  ACID_BASS: [0.1961, 0.00938, 0.1983, 0.01261],
  FM_BASS: [0.2084, 0.00247, 0.2007, 0.00284],
  LEAD: [0.1098, 0.01423, 0.1162, 0.01759],
  WIDE_LEAD: [0.1227, 0.01447, 0.1248, 0.02156],
  VOICE_LEAD: [0.1209, 0.01296, 0.1496, 0.00901],
  DRUMS: [0.2349, 0.02597, 0.2345, 0.02694],
  HARD_DRUMS: [0.2210, 0.03539, 0.2213, 0.03745],
  LOFI_DRUMS: [0.2457, 0.01031, 0.1842, 0.01487],
};
// free rms, free brightness, held rms, held brightness
const SHAKER = {
  DRUMS: [0.0482, 0.07284, 0.0451, 0.07150],
  HARD_DRUMS: [0.0668, 0.10298, 0.0610, 0.09977],
  LOFI_DRUMS: [0.0337, 0.02485, 0.0305, 0.02337],
};
/** Jumps in engineJumps() as Node computes them. */
const ENGINE_JUMPS = 0;

const row = (label, got, ref, bad = 0) => ({
  label, got, ref, ok: bad === 0 && got.every((g, k) => Math.abs(g - ref[k]) < ref[k] * 0.005 + 1e-4),
});

/** All checks, one row each: { label, got, ref, ok }. */
export function soundcheck() {
  const rows = [];
  for (const m of MODES) {
    const a = measure(m, 0, 0), b = measure(m, 0.6, 0.9);
    rows.push(row(m.name, [a[0], a[1], b[0], b[1]], PAGE[m.name], a[2] + b[2]));
  }
  for (const [name, ref] of Object.entries(SHAKER)) {
    const a = shaken(Mode[name], false), b = shaken(Mode[name], true);
    rows.push(row(`shaker ${name}`, [a[0], a[1], b[0], b[1]], ref, a[2] + b[2]));
  }
  const seen = new Set();
  for (let id = Mode.BASS.id, i = 0; i < MODES.length; i++, id = nextMode(id)) seen.add(id);
  rows.push(row('sound button', [seen.size], [MODES.length]));
  const j = engineJumps();
  rows.push({ label: 'engine jumps', got: [j], ref: [ENGINE_JUMPS], ok: j === ENGINE_JUMPS });
  return rows;
}

/** One row as text. */
export const format = (r) =>
  `${r.ok ? 'ok  ' : 'FAIL'} ${r.label.padEnd(18)} ${r.got.map((g) => (Number.isInteger(g) ? String(g) : g.toFixed(5))).join(' ')}` +
  (r.ok ? '' : `  want ${r.ref.join(' ')}`);
