// The whole screen, the sensors and the start: port of Android BandView.kt and MainActivity.kt.
//
// Panel: tap a track — select it (tap the selected one — mute/unmute), hold — erase it; «Rec» records the
// selected track; «Sound» switches its instrument; «−» «+» — tempo before the first loop, «♩» — metronome;
// «Save» keeps the loop in the browser, «Open» lists saved ones (tap — load, hold — delete).
//
// Band: 1 finger — from the peg at the bottom to the finger; 2+ fingers — the two farthest apart are the
// ends, the rest bend it. Length → pitch, crookedness → timbre. In drum mode every new finger is a hit.
//
// The looper lives in the audio thread (worklet.js). This file only sends it messages and draws the
// `state` it posts back. Pixel constants are Android's on a 1080 px wide screen, scaled by px().
import { MODES, Frame, BLOCK, nextMode, KICK_UP_TO, SNARE_UP_TO } from './synth.js';
import * as Sessions from './sessions.js';

const HOLD_MS = 600;
const ITEM_H = 140;
/** Band length at zero stretch and per full stretch, in screen diagonals. */
const REST = 0.05;
const SPAN = 0.8;
const LABEL_X = 20;
/** Drum sound by stretch: up to this tension → this name. */
const DRUM_ZONES = [[KICK_UP_TO, 'kick'], [SNARE_UP_TO, 'tom / snare'], [1.01, 'hat']];
const TEMPO_STEP = 5;
const MIN_BPM = 40;
const MAX_BPM = 200;
const BURST_S = 0.3;
const GHOST_ALPHA = 0.6;
const BG = 'rgb(16,16,22)';
/** Track colours: ghost bands and the panel cells share them. */
const TRACK_COLORS = [[70, 210, 120], [255, 150, 50], [80, 150, 255], [200, 100, 255]];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, Menlo, "Roboto Mono", monospace';
/** ?debug=1: the browser's own audio latency under the readout. */
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';

const canvas = document.getElementById('band');
const ctx = canvas.getContext('2d');

// ---- engine proxy ----

let audio = null;
let node = null;
/** What the audio thread last told us; the defaults are its own until it starts. */
let st = {
  selected: 0, loopLen: 0, pos: 0, recCount: 0, metronome: true, bpm: 100, loopBeats: 0,
  barBlocks: 0, clickBlocks: 0, countingIn: -1,
  tracks: [0, 1, 2, 2].map((mode) => ({ mode, muted: false, hasContent: false, recording: false, level: 0 })),
};
/** Each track's loop as the audio thread last sent it (null when empty): ghosts and saving. */
const trackFrames = [null, null, null, null];
let blocksPerSecond = 48000 / BLOCK;
let stateSig = '';

const send = (m) => node && node.port.postMessage(m);

function onEngine(e) {
  const m = e.data;
  if (m.t === 'frames') {
    trackFrames[m.i] = m.frames;
    dirty = true;
  } else if (m.t === 'state') {
    st = m;
    const sig = [m.selected, m.loopLen, m.bpm, m.metronome, m.countingIn,
      ...m.tracks.map((t) => `${t.mode}${t.muted}${t.hasContent}${t.recording}`)].join('|');
    if (sig !== stateSig) dirty = true;
    stateSig = sig;
  }
}

// live gesture
let tension = 0;
let bend = 0;
let gate = false;
let aimNow = 0;
let tiltX = 0;
let tiltY = 0;
let shake = 0;

// ---- layout ----

let W = 0;
let H = 0;
let scale = 1;
const px = (v) => v * scale;
const rect = () => ({ x: 0, y: 0, w: 0, h: 0 });
const cells = [rect(), rect(), rect(), rect()];
const recButton = rect(), modeButton = rect(), saveButton = rect(), openButton = rect();
const slowerButton = rect(), tempoButton = rect(), fasterButton = rect(), progress = rect();
let panelBottom = 0;
const listTop = () => panelBottom + px(110);
const contains = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const setRect = (r, x, y, x2, y2) => Object.assign(r, { x, y, w: x2 - x, h: y2 - y });

const safeProbe = document.getElementById('safe');

function layout() {
  // a phone-shaped column: the whole window on a phone, centred on a desktop
  H = window.innerHeight;
  W = Math.min(window.innerWidth, Math.round(H * 0.6));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scale = W / 1080;

  const pad = px(16);
  // below the status bar / notch when installed full screen, as on iOS
  const top = Math.max(parseFloat(getComputedStyle(safeProbe).paddingTop) || 0, px(60));
  const cellH = H * 0.09;
  const cellW = (W - pad * (cells.length + 1)) / cells.length;
  cells.forEach((r, i) => {
    const x = pad + i * (cellW + pad);
    setRect(r, x, top, x + cellW, top + cellH);
  });
  setRect(progress, pad, top + cellH + px(14), W - pad, top + cellH + px(26));
  const by = progress.y + progress.h + px(14);
  const bh = H * 0.06;
  // REC | − | ♩ | + | Sound, widths in shares of the row
  const shares = [0.32, 0.1, 0.16, 0.1, 0.32];
  const buttons = [recButton, slowerButton, tempoButton, fasterButton, modeButton];
  const rowW = W - pad * (buttons.length + 1);
  let x = pad;
  buttons.forEach((r, i) => {
    setRect(r, x, by, x + rowW * shares[i], by + bh);
    x = r.x + r.w + pad;
  });
  const sy = recButton.y + recButton.h + pad;
  setRect(saveButton, pad, sy, W / 2 - pad / 2, sy + H * 0.045);
  setRect(openButton, W / 2 + pad / 2, sy, W - pad, sy + H * 0.045);
  panelBottom = saveButton.y + saveButton.h + px(16);
  dirty = true;
}

const peg = () => ({ x: W / 2, y: H * 0.94 });
const diagonal = () => Math.hypot(W, H);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ---- touches ----

/** Fingers on the band, in touch order: pointer id → point. */
const fingers = new Map();
let band = [];
/** Pointers that landed on the panel: id → where and when, resolved on lift (tap vs hold). */
const panelTouches = new Map();
/** Saved sessions on show over the band, or null when the list is closed. */
let browser = null;
/** Tune of the last drum hit, for the readout. */
let lastHit = 0;

function pointer(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!audio) return void start();
  if (audio.state !== 'running') audio.resume(); // iOS: after a call or the lock screen
  canvas.setPointerCapture(e.pointerId);
  const p = pointer(e);
  if (browser || p.y < panelBottom) {
    panelTouches.set(e.pointerId, { ...p, t: e.timeStamp });
    return;
  }
  fingers.set(e.pointerId, p);
  updateBand();
  if (MODES[st.tracks[st.selected].mode].drums) {
    // each finger hits by its own distance from the peg, as if it were alone:
    // the band's tension with several fingers is the distance between them
    aimNow = aim([peg(), p]);
    lastHit = tensionAt(p);
    sendLive();
    send({ t: 'hit', tune: lastHit, vel: 0.6 + 0.4 * shake, x: p.x / W, y: p.y / H });
  }
});

canvas.addEventListener('pointermove', (e) => {
  const f = fingers.get(e.pointerId);
  if (!f) return;
  Object.assign(f, pointer(e));
  updateBand();
});

function lift(e, cancelled) {
  const t = panelTouches.get(e.pointerId);
  if (t) {
    panelTouches.delete(e.pointerId);
    if (!cancelled) {
      const hold = e.timeStamp - t.t > HOLD_MS;
      if (browser) browserTap(t.x, t.y, hold);
      else panelTap(t.x, t.y, hold);
    }
  }
  if (fingers.delete(e.pointerId)) updateBand();
  dirty = true;
}
canvas.addEventListener('pointerup', (e) => lift(e, false));
canvas.addEventListener('pointercancel', (e) => lift(e, true));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function panelTap(x, y, hold) {
  const cell = cells.findIndex((r) => contains(r, x, y));
  if (cell >= 0 && hold) send({ t: 'clear', i: cell });
  else if (cell >= 0 && cell === st.selected) send({ t: 'mute', i: cell });
  else if (cell >= 0) send({ t: 'select', i: cell });
  else if (contains(recButton, x, y)) send({ t: 'rec' });
  else if (contains(slowerButton, x, y)) changeTempo(-TEMPO_STEP);
  else if (contains(fasterButton, x, y)) changeTempo(TEMPO_STEP);
  else if (contains(tempoButton, x, y)) send({ t: 'metronome', on: !st.metronome });
  else if (contains(modeButton, x, y)) send({ t: 'mode', i: st.selected, mode: nextMode(st.tracks[st.selected].mode) });
  else if (contains(saveButton, x, y)) save();
  else if (contains(openButton, x, y)) openBrowser();
}

function changeTempo(delta) {
  if (st.loopLen === 0 && st.barBlocks === 0) send({ t: 'bpm', bpm: clamp(st.bpm + delta, MIN_BPM, MAX_BPM) });
}

async function save() {
  if (st.loopLen === 0) return toast('Nothing to save');
  if (st.countingIn >= 0 || st.tracks.some((t) => t.recording)) return toast('Finish recording first');
  const session = {
    loopLen: st.loopLen, loopBeats: st.loopBeats, bpm: st.bpm,
    tracks: st.tracks.map((t, i) => ({ mode: t.mode, muted: t.muted, frames: t.hasContent ? trackFrames[i] : null })),
  };
  try {
    navigator.storage?.persist?.(); // ask the browser not to clear saved loops when space runs low
    toast(`Saved: ${await Sessions.save(session)}`);
  } catch {
    toast('Could not save');
  }
}

/** Opens the saved-sessions list over the band. */
async function openBrowser() {
  fingers.clear();
  updateBand();
  try {
    browser = await Sessions.list();
  } catch {
    toast('Could not open');
  }
  dirty = true;
}

function browserTap(x, y, hold) {
  const entries = browser;
  const i = Math.floor((y - listTop()) / px(ITEM_H));
  dirty = true;
  if (y < listTop() || i >= entries.length) {
    browser = null; // tap outside the list closes it
    return;
  }
  const entry = entries[i];
  if (hold) {
    browser = entries.filter((e) => e !== entry);
    Sessions.remove(entry.name).catch(() => toast('Could not delete'));
    return;
  }
  browser = null;
  send({ t: 'load', session: entry.session });
  toast(`Opened: ${entry.title}`);
}

let toastText = null;
let toastUntil = 0;
function toast(text) {
  toastText = text;
  toastUntil = performance.now() + 2000;
  dirty = true;
}

function sendLive() {
  const shape = new Float32Array(1 + 2 * Frame.MAX_PTS);
  const pts = band.slice(0, Frame.MAX_PTS);
  shape[0] = pts.length;
  pts.forEach((p, i) => {
    shape[1 + 2 * i] = p.x / W;
    shape[2 + 2 * i] = p.y / H;
  });
  send({ t: 'live', tension, bend, gate, aim: aimNow, shape });
}

/** Rebuilds the band from the fingers and pushes tension/bend to the engine. */
function updateBand() {
  band = shapeOf([...fingers.values()]);
  dirty = true;
  if (band.length < 2) {
    gate = false;
    return sendLive();
  }
  let pathLen = 0;
  for (let i = 1; i < band.length; i++) pathLen += dist(band[i - 1], band[i]);
  const endDist = dist(band[0], band[band.length - 1]);
  tension = clamp((pathLen - diagonal() * REST) / (diagonal() * SPAN), 0, 1);
  bend = pathLen > 1 ? clamp((pathLen - endDist) / pathLen * 4, 0, 1) : 0;
  aimNow = aim(band);
  gate = true;
  sendLive();
}

/** The tension one finger at `p` would give: its distance from the peg. */
const tensionAt = (p) => clamp((dist(peg(), p) - diagonal() * REST) / (diagonal() * SPAN), 0, 1);

/**
 * Where the band points, as extra tilt: the angle of its far end (from the peg) off straight up,
 * 45° left = -0.5 … 45° right = +0.5. Playing left of centre sounds like tilting the phone left.
 */
function aim(b) {
  const p = peg();
  const a = b[0], z = b[b.length - 1];
  const far = dist(p, a) > dist(p, z) ? a : z;
  return Math.atan2(far.x - p.x, p.y - far.y) / (Math.PI / 2);
}

/** Orders points into a band: farthest pair are the ends, the rest sorted along the line between them. */
function shapeOf(pts) {
  if (pts.length === 0) return [];
  if (pts.length === 1) return [peg(), pts[0]];
  let a = pts[0], b = pts[1];
  for (const p of pts) for (const q of pts) if (dist(p, q) > dist(a, b)) { a = p; b = q; }
  const dx = b.x - a.x, dy = b.y - a.y;
  const along = (p) => (p.x - a.x) * dx + (p.y - a.y) * dy;
  const middle = pts.filter((p) => p !== a && p !== b).sort((p, q) => along(p) - along(q));
  return [a, ...middle, b];
}

// ---- sensors (MainActivity.kt) ----

const G = 9.80665;
const gravity = [0, 0, G];
/** iOS Safari reports the opposite sign of the spec and of Android. */
const IOS_SIGNS = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const s = IOS_SIGNS ? -1 : 1;
  const v = [a.x * s, a.y * s, a.z * s];
  // the filter constants are Android's at 50 Hz; scale them to this browser's rate
  let iv = e.interval || 16;
  if (iv < 1) iv *= 1000; // old Safari: seconds
  const steps = clamp(iv, 5, 100) / 20;
  // low-pass splits the raw signal: what changes slowly is gravity (tilt), the rest is shaking
  const k = Math.pow(0.9, steps);
  let energy = 0;
  for (let i = 0; i < 3; i++) {
    gravity[i] = k * gravity[i] + (1 - k) * v[i];
    const lin = v[i] - gravity[i];
    energy += lin * lin;
  }
  // shake jumps up at once and fades over ~half a second, like a band that keeps quivering
  shake = clamp(Math.max(Math.sqrt(energy) / 12, shake * Math.pow(0.93, steps)), 0, 1);
  tiltX = clamp(-gravity[0] / G, -1, 1); // right edge down → brighter
  tiltY = clamp(Math.abs(gravity[1]) / G, 0, 1); // flat → 0, upright → 1
  send({ t: 'motion', tiltX, tiltY, shake });
}

// ---- start, pause ----

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not offered: fine */ }
}

/** First tap: audio and sensors may only start from a user gesture. */
async function start() {
  // iOS asks for the motion sensors only straight from a tap
  const perm = IOS_SIGNS ? DeviceMotionEvent.requestPermission().catch(() => 'denied') : Promise.resolve('granted');
  if (navigator.audioSession) navigator.audioSession.type = 'playback'; // iOS: sound even with the silent switch on
  try {
    audio = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  } catch {
    audio = new AudioContext({ latencyHint: 'interactive' });
  }
  audio.resume();
  dirty = true;
  try {
    await audio.audioWorklet.addModule('worklet.js');
  } catch {
    audio = null;
    return toast('This browser cannot play the synth');
  }
  // Session frames are per block, so a 48 kHz context keeps .rez files at Android's speed.
  blocksPerSecond = audio.sampleRate / BLOCK;
  node = new AudioWorkletNode(audio, 'rezina', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.port.onmessage = onEngine;
  node.connect(audio.destination);
  if ((await perm) === 'granted') window.addEventListener('devicemotion', onMotion);
  else toast('No motion sensors: tilt and shake are off');
  keepAwake();
}

document.addEventListener('visibilitychange', () => {
  if (!audio) return;
  if (document.hidden) {
    // like Android onPause: the sound stops, fingers are gone
    fingers.clear();
    panelTouches.clear();
    updateBand();
    audio.suspend();
  } else {
    audio.resume();
    keepAwake();
    dirty = true;
  }
});

// ---- drawing ----

const rgb = (r, g, b, a = 255) => `rgba(${r},${g},${b},${a / 255})`;
const dim = ([r, g, b]) => rgb(Math.trunc(r * 2 / 5), Math.trunc(g * 2 / 5), Math.trunc(b * 2 / 5));

/** The live band: yellow when slack, red when stretched (HSV 40°→0°, s 0.85, v 1). */
function hot(t) {
  const h = (40 - 40 * t) / 60;
  const s = 0.85;
  const f = (n) => {
    const k = (n + h) % 6;
    return Math.round(255 * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

const midi = (freq) => 69 + 12 * Math.log2(freq / 440);
function noteName(freq) {
  const m = midi(freq);
  const n = Math.round(m);
  const cents = Math.trunc((m - n) * 100);
  return `${NOTES[((n % 12) + 12) % 12]}${Math.trunc(n / 12) - 1} ${cents >= 0 ? '+' : ''}${cents}¢`;
}

function font(size, family = SANS) {
  ctx.font = `${px(size)}px ${family}`;
}

function text(s, x, y, color, align = 'left') {
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
}

function roundRect(r, color, radius = px(16)) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
  ctx.fill();
}

function circle(x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fill();
}

function ring(x, y, r, width, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(r, 0), 0, 2 * Math.PI);
  ctx.stroke();
}

/** Centre text on a button, baseline a little below the middle like Android's +13 px. */
const buttonText = (s, r, color = 'white') => text(s, r.x + r.w / 2, r.y + r.h / 2 + px(13), color, 'center');

function draw() {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  drawPanel();
  drawNoteGrid();
  drawReadout();
  const c = peg();
  circle(c.x, c.y, px(18), 'gray');
  drawGhosts();
  for (const p of fingers.values()) circle(p.x, p.y, px(90), rgb(255, 255, 255, 70));
  drawBand(band, tension, hot(tension));

  if (browser) drawBrowser(browser);
  drawToast();
  if (!audio) drawStart();
  else if (window.innerWidth > window.innerHeight && matchMedia('(pointer: coarse)').matches) drawUpright();
}

/** Under the readout: its line count is fixed (3, or 4 with ?debug=1). */
const plate = () => {
  const lines = DEBUG ? 4 : 3;
  return { x: px(12), y: panelBottom + px(10), w: W - px(24), h: px(50) + (lines - 1) * px(46) + px(26) };
};

/** The sound and the sensors, as text over the note grid. */
function drawReadout() {
  const mode = MODES[st.tracks[st.selected].mode];
  let sound;
  if (!gate) sound = '—';
  else if (mode.drums) sound = DRUM_ZONES.find(([upTo]) => lastHit < upTo)[1]; // the last finger's zone
  else {
    const f = mode.freq(tension);
    sound = `${f.toFixed(1).padStart(6)} Hz  ${noteName(f)}`;
  }
  const lines = [
    `${mode.title}: ${sound}`,
    `stretch ${tension.toFixed(2).padStart(4)}  bend ${bend.toFixed(2).padStart(4)}`,
    `tilt ↔ ${clamp(tiltX + aimNow, -1, 1).toFixed(2).padStart(5)}  ↕ ${tiltY.toFixed(2).padStart(4)}  shake ${shake.toFixed(2).padStart(4)}`,
  ];
  if (DEBUG) lines.push(latencyLine()); // plate() counts these lines
  // a see-through plate: the note rings stay visible behind the text
  roundRect(plate(), rgb(16, 16, 22, 150));
  font(36, MONO);
  lines.forEach((s, i) => text(s, px(24), panelBottom + px(50) + i * px(46), 'lightgray'));
}

/**
 * What the browser says it adds between our samples and the speaker: base (the audio graph's own
 * buffering) + output (the device and OS) + our block, which can hold a sample up to 4 ms. Shown as
 * `latency base+out+block = total ms`; `?` where the browser does not tell (older Safari: outputLatency).
 */
function latencyLine() {
  if (!audio) return 'audio: not started';
  const ms = (s) => (typeof s === 'number' ? (s * 1000).toFixed(1) : '?');
  const total = (audio.baseLatency || 0) + (audio.outputLatency || 0) + BLOCK / audio.sampleRate;
  const rate = audio.sampleRate === 48000 ? '' : ` @${audio.sampleRate}`;
  return `latency ${ms(audio.baseLatency)}+${ms(audio.outputLatency)}+${ms(BLOCK / audio.sampleRate)} = ${ms(total)} ms${rate}`;
}

/** Band length (from the peg, one finger) that gives `t`. */
const radius = (t) => diagonal() * (REST + SPAN * t);

/**
 * Where to put one finger: rings around the peg. Melodic modes — a ring per semitone (C bright and labelled,
 * other naturals labelled, sharps faint), the sounding note lit; drums — the three zones.
 */
function drawNoteGrid() {
  const mode = MODES[st.tracks[st.selected].mode];
  const c = peg();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, panelBottom, W, H - panelBottom);
  ctx.clip();
  font(30);
  if (mode.drums) {
    let inner = 0;
    DRUM_ZONES.forEach(([upTo, name], i) => {
      const outer = radius(Math.min(upTo, 1));
      ring(c.x, c.y, (inner + outer) / 2, outer - inner, rgb(255, 150, 50, i % 2 === 0 ? 26 : 12));
      // near the inner edge (the outer zone runs off-screen); the first zone's clear of the peg
      labelRing(name, i === 0 ? px(250) : inner + px(70), rgb(255, 255, 255, 150));
      inner = outer;
    });
  } else {
    const playing = gate && fingers.size === 1 ? Math.round(midi(mode.freq(tension))) : -1;
    const lo = Math.ceil(midi(mode.freq(0)));
    const hi = Math.floor(midi(mode.freq(1)));
    for (let m = lo; m <= hi; m++) {
      const r = radius(mode.tension(440 * Math.pow(2, (m - 69) / 12)));
      const name = NOTES[m % 12];
      const natural = name.length === 1;
      if (m === playing) ring(c.x, c.y, r, px(6), rgb(255, 220, 120, 220));
      else if (name === 'C') ring(c.x, c.y, r, px(3), rgb(255, 255, 255, 110));
      else if (natural) ring(c.x, c.y, r, px(2), rgb(255, 255, 255, 45));
      else ring(c.x, c.y, r, px(1), rgb(255, 255, 255, 18));
      if (natural || m === playing) {
        const alpha = m === playing ? 255 : name === 'C' ? 200 : 110;
        labelRing(`${name}${Math.trunc(m / 12) - 1}`, r, rgb(255, 255, 255, alpha));
      }
    }
  }
  ctx.restore();
}

/** Labels a ring where it meets the left edge, away from the band; small rings at their leftmost point. */
function labelRing(s, r, color) {
  const c = peg();
  const dx = c.x - px(LABEL_X);
  const y = r > dx ? c.y - Math.sqrt(r * r - dx * dx) : c.y;
  const x = r > dx ? px(LABEL_X) : c.x - r + px(8);
  const p = plate();
  if (y - px(8) < p.y + p.h + px(30)) return; // the ring shows through the readout, its name would collide
  text(s, x, y - px(8), color);
}

function drawBrowser(entries) {
  ctx.fillStyle = rgb(16, 16, 22, 235);
  ctx.fillRect(0, panelBottom, W, H - panelBottom);
  font(36, MONO);
  text('Saved loops: tap — open, hold — delete', px(24), panelBottom + px(60), 'white');
  if (entries.length === 0) text('Nothing saved yet', px(24), listTop() + px(60), 'lightgray');
  entries.forEach((entry, i) => {
    const top = listTop() + i * px(ITEM_H);
    if (top + px(ITEM_H) > H) return;
    roundRect({ x: px(16), y: top, w: W - px(32), h: px(ITEM_H) - px(16) }, rgb(42, 42, 52));
    font(40);
    text(entry.title, px(40), top + px(52), 'white');
    font(30);
    text(entry.summary, px(40), top + px(98), rgb(255, 255, 255, 170));
  });
}

function drawToast() {
  if (!toastText || performance.now() > toastUntil) {
    toastText = null;
    return;
  }
  font(38);
  const w = ctx.measureText(toastText).width;
  const h = px(38) * 1.2;
  const r = { x: (W - w) / 2 - px(36), y: H * 0.84, w: w + px(72), h: h + px(36) };
  roundRect(r, rgb(60, 60, 72, 240), r.h / 2);
  text(toastText, W / 2, r.y + px(18) + px(38) * 0.95, 'white', 'center');
}

/** Before the first tap: browsers start sound only from a gesture. */
function drawStart() {
  ctx.fillStyle = rgb(16, 16, 22, 215);
  ctx.fillRect(0, panelBottom, W, H - panelBottom);
  font(64);
  text('Tap to start', W / 2, H * 0.48, 'white', 'center');
  font(34);
  const lines = ['Stretch and bend the band with your fingers,', 'tilt and shake the phone. Sound on.'];
  lines.forEach((s, i) => text(s, W / 2, H * 0.48 + px(80) + i * px(48), rgb(255, 255, 255, 170), 'center'));
}

/** The tilt axes and the layout assume portrait. */
function drawUpright() {
  ctx.fillStyle = rgb(16, 16, 22, 235);
  ctx.fillRect(0, 0, W, H);
  font(44);
  text('Turn the phone upright', W / 2, H / 2, 'white', 'center');
}

function drawPanel() {
  const pulse = performance.now() % 600 < 300;
  st.tracks.forEach((tr, i) => {
    const r = cells[i];
    let color;
    if (tr.recording || st.countingIn === i) color = pulse ? rgb(200, 40, 40) : rgb(140, 30, 30);
    else if (!tr.hasContent) color = rgb(42, 42, 52);
    else if (tr.muted) color = rgb(30, 30, 34);
    else color = dim(TRACK_COLORS[i]);
    roundRect(r, color);
    if (tr.level > 0) {
      ctx.fillStyle = rgb(255, 255, 255, 140);
      ctx.fillRect(r.x + px(10), r.y + r.h - px(16), (r.w - px(20)) * tr.level, px(8));
    }
    if (i === st.selected) {
      ctx.strokeStyle = 'white';
      ctx.lineWidth = px(5);
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, px(16));
      ctx.stroke();
    }
    let state;
    if (tr.recording) state = '● rec';
    else if (st.countingIn === i) state = 'count-in';
    else if (!tr.hasContent) state = 'empty';
    else if (tr.muted) state = 'muted';
    else state = 'playing';
    font(34);
    text(`${i + 1} ${MODES[tr.mode].short}`, r.x + r.w / 2, r.y + r.h * 0.4, 'white', 'center');
    font(28);
    text(state, r.x + r.w / 2, r.y + r.h * 0.72, 'white', 'center');
  });

  // metronome ticking: four beat cells, the current one lit; otherwise the loop's progress
  ctx.fillStyle = rgb(42, 42, 52);
  ctx.fillRect(progress.x, progress.y, progress.w, progress.h);
  const loopLen = st.loopLen;
  const bar = st.barBlocks;
  const beat = bar > 0 ? Math.trunc((st.clickBlocks % bar) * 4 / bar) : -1;
  if (beat >= 0) {
    const cw = progress.w / 4;
    ctx.fillStyle = beat === 0 ? rgb(255, 210, 80) : rgb(90, 160, 255);
    ctx.fillRect(progress.x + beat * cw + px(4), progress.y, cw - px(8), progress.h);
  } else if (loopLen > 0) {
    ctx.fillStyle = rgb(90, 160, 255);
    ctx.fillRect(progress.x, progress.y, progress.w * st.pos / loopLen, progress.h);
    // bar lines, so the loop reads as bars of the metronome's grid
    ctx.fillStyle = BG;
    const bars = Math.trunc(st.loopBeats / 4);
    for (let b = 1; b < bars; b++) {
      const x = progress.x + progress.w * b / bars;
      ctx.fillRect(x - px(3), progress.y, px(6), progress.h);
    }
  }

  const selected = st.tracks[st.selected];
  const firstTake = loopLen === 0 && selected.recording;
  const counting = st.countingIn === st.selected;
  roundRect(recButton, selected.recording || counting ? rgb(170, 40, 40) : rgb(60, 60, 72));
  font(38);
  let recText;
  if (counting) recText = `Count-in… ${4 - beat}`;
  else if (firstTake && bar > 0) recText = `■ Stop · bar ${Math.trunc(st.recCount / bar) + 1}`;
  else if (firstTake) recText = `■ Stop · ${(st.recCount / blocksPerSecond).toFixed(1)} s`;
  else if (selected.recording) recText = '■ Stop';
  else if (loopLen === 0) recText = '● Rec';
  else recText = `● Rec · ${(loopLen / blocksPerSecond).toFixed(1)} s`;
  buttonText(recText, recButton);

  // tempo can change only before the first loop exists; the metronome toggles any time
  roundRect(slowerButton, rgb(60, 60, 72));
  roundRect(fasterButton, rgb(60, 60, 72));
  const tempoColor = loopLen === 0 ? 'white' : rgb(255, 255, 255, 110);
  buttonText('−', slowerButton, tempoColor);
  buttonText('+', fasterButton, tempoColor);
  roundRect(tempoButton, st.metronome ? rgb(90, 80, 30) : rgb(60, 60, 72));
  buttonText(st.metronome ? `♩ ${st.bpm}` : '♩ off', tempoButton);

  roundRect(modeButton, rgb(60, 60, 72));
  buttonText(`${MODES[selected.mode].title} ▸`, modeButton);

  roundRect(saveButton, rgb(60, 60, 72));
  roundRect(openButton, rgb(60, 60, 72));
  buttonText('Save', saveButton);
  buttonText(browser ? 'Close' : 'Open…', openButton);
}

/** Replays each audible track's recorded shapes at the playhead: the band as held, a burst at each drum hit. */
function drawGhosts() {
  const len = st.loopLen;
  if (len === 0) return;
  const now = (st.pos - 1 + len) % len; // the block being heard
  const lookBack = Math.min(len, Math.trunc(BURST_S * blocksPerSecond));
  st.tracks.forEach((tr, ti) => {
    const f = trackFrames[ti];
    if (!tr.hasContent || tr.muted || tr.recording || !f || f.length < len * Frame.SIZE) return;
    const color = TRACK_COLORS[ti];
    const o = now * Frame.SIZE;
    if (f[o + Frame.GATE] > 0.5) drawBand(ghostShape(f, o), f[o + Frame.TENSION], color, GHOST_ALPHA);
    for (let k = 0; k < lookBack; k++) {
      const e = ((now - k + len) % len) * Frame.SIZE;
      if (f[e + Frame.EVENT] !== Frame.EV_HIT) continue;
      const p = 1 - k / blocksPerSecond / BURST_S;
      circle(f[e + Frame.EV_X] * W, f[e + Frame.EV_Y] * H, px(40) + px(120) * (1 - p), rgb(...color, 255 * p * GHOST_ALPHA));
    }
  });
}

function ghostShape(f, o) {
  const n = Math.min(f[o + Frame.COUNT], Frame.MAX_PTS);
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ x: f[o + Frame.PTS + 2 * i] * W, y: f[o + Frame.PTS + 2 * i + 1] * H });
  return pts;
}

/** Smooth curve through the points; thinner as it stretches, like real rubber. */
function drawBand(pts, t, [r, g, b], alpha = 1) {
  if (pts.length < 2) return;
  ctx.strokeStyle = rgb(r, g, b, alpha * 255);
  ctx.lineWidth = px(36) * (1 - 0.75 * t);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const a = pts[0], z = pts[pts.length - 1];
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
  }
  ctx.lineTo(z.x, z.y);
  ctx.stroke();
}

// ---- frame loop: redraw only while something moves (as on iOS: an idle redraw costs battery) ----

let dirty = true;
let busyLastFrame = false;
let shown = [0, 0, 0];

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const busy = fingers.size > 0 || gate || st.countingIn >= 0 || st.barBlocks > 0 || st.loopLen > 0 ||
    st.tracks.some((t) => t.recording) || (toastText !== null && now < toastUntil + 100);
  const live = [clamp(tiltX + aimNow, -1, 1), tiltY, shake];
  const moved = live.some((v, i) => Math.abs(v - shown[i]) > 0.03);
  if (busy || busyLastFrame || dirty || moved) {
    draw();
    shown = live;
    dirty = false;
  }
  busyLastFrame = busy;
}

window.addEventListener('resize', layout);
layout();
requestAnimationFrame(frame);

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
