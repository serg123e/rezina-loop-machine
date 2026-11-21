// Every sound vs the comparison page's numbers: the gestures of Android VoiceTest, rendered by synth.js.
// Prints one line per mode; exits 1 on a mismatch (more than 0.5 % off the page).
import { Voice, MODES, Mode, Kind, Frame, BLOCK, nextMode } from '../synth.js';

const n = BLOCK;
let failed = false;

function render(modeId, setFrame) {
  const v = new Voice(48000);
  const f = new Float32Array(Frame.SIZE);
  const tl = new Float32Array(n), tr = new Float32Array(n), dl = new Float32Array(n), dr = new Float32Array(n);
  let sum = 0, diff = 0, pl = 0, pr = 0;
  const blocks = 250;
  for (let b = 0; b < blocks; b++) {
    setFrame(f, b);
    tl.fill(0); tr.fill(0); dl.fill(0); dr.fill(0);
    v.render(tl, tr, dl, dr, n, f, 0, modeId, 100);
    for (let i = 0; i < n; i++) {
      const l = tl[i] + dl[i], r = tr[i] + dr[i];
      if (!Number.isFinite(l) || !Number.isFinite(r) || Math.abs(l) >= 1 || Math.abs(r) >= 1) throw new Error(`bad sample in ${MODES[modeId].name}`);
      sum += l * l + r * r;
      diff += (l - pl) ** 2 + (r - pr) ** 2;
      pl = l; pr = r;
    }
  }
  const count = 2 * blocks * n;
  return [Math.sqrt(sum / count), Math.sqrt(diff / count)];
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

function check(label, got, ref) {
  const ok = got.every((g, k) => Math.abs(g - ref[k]) < ref[k] * 0.005 + 1e-4);
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(18)} ${got.map((g) => g.toFixed(5)).join(' ')}${ok ? '' : `  page ${ref.join(' ')}`}`);
}

// level rms, level brightness, tilted rms, tilted brightness
const page = {
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
for (const m of MODES) check(m.name, [...measure(m, 0, 0), ...measure(m, 0.6, 0.9)], page[m.name]);

// free rms, free brightness, held rms, held brightness
const shaker = {
  DRUMS: [0.0482, 0.07284, 0.0451, 0.07150],
  HARD_DRUMS: [0.0668, 0.10298, 0.0610, 0.09977],
  LOFI_DRUMS: [0.0337, 0.02485, 0.0305, 0.02337],
};
for (const [name, ref] of Object.entries(shaker)) check(`shaker ${name}`, [...shaken(Mode[name], false), ...shaken(Mode[name], true)], ref);

const seen = new Set();
for (let id = Mode.BASS.id, i = 0; i < MODES.length; i++, id = nextMode(id)) seen.add(id);
check('sound button', [seen.size], [MODES.length]);

process.exit(failed ? 1 : 0);
