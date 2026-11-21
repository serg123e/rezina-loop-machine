// The instruments, the master bus and the modes: port of Android Synth.kt, Mode.kt and Voice.kt.
// Keep the per-sample formulas identical to them (and to docs/sound-lab.html, the reference).
// Runs inside the AudioWorklet (worklet.js) and in Node for the sound check (test/soundcheck.mjs).

export const TAU = 2 * Math.PI;
const SEMITONE = 0.05776227; // ln 2 / 12: 2^(x/12) == exp(x * SEMITONE)
/** Frames per audio block: ~4 ms, also the time resolution of recorded gestures. */
export const BLOCK = 192;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const glide = (seconds, sr) => 1 - Math.exp(-1 / (seconds * sr));
export const decay = (seconds, sr) => Math.exp(-1 / (seconds * sr));
const wrap = (p) => (p >= 1 ? p - 1 : p);
const tanh = Math.tanh;
const sin = Math.sin;
const pow2 = (x) => Math.pow(2, x);

/** Band-limited saw (polyBLEP). */
function saw(p, dt) {
  let v = 2 * p - 1;
  if (p < dt) {
    const t = p / dt;
    v -= t + t - t * t - 1;
  } else if (p > 1 - dt) {
    const t = (p - 1) / dt;
    v -= t * t + t + t + 1;
  }
  return v;
}

/** Band-limited square, as the difference of two saws half a cycle apart. */
const sqr = (p, dt) => 0.5 * (saw(p, dt) - saw(p >= 0.5 ? p - 0.5 : p + 0.5, dt));

/** xorshift on 32-bit ints, as in Kotlin. */
class Noise {
  constructor(seed = 22222) { this.s = seed | 0; }
  next() {
    let s = this.s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.s = s | 0;
    return this.s / 2147483648;
  }
}

/** Zavalishin TPT state-variable filter: run() returns the low-pass; bp and hp hold the other outputs. */
class Svf {
  constructor(sr) {
    this.sr = sr;
    this.a = 0; this.b = 0; this.g = 0.1; this.k = 1.4; this.bp = 0; this.hp = 0;
  }
  set(fc, k) {
    this.g = Math.tan(Math.PI * clamp(fc, 10, this.sr * 0.45) / this.sr);
    this.k = k;
    return this;
  }
  run(x) {
    const g = this.g, k = this.k;
    const a1 = 1 / (1 + g * (g + k));
    const v1 = a1 * (this.a + g * (x - this.b));
    const v2 = this.b + g * v1;
    this.a = 2 * v1 - this.a;
    this.b = 2 * v2 - this.b;
    this.bp = v1;
    this.hp = x - k * v1 - v2;
    return v2;
  }
}

/** Ping-pong echo with a darkened feedback path; the delay time can change (tempo). */
class PingPong {
  constructor(sr, maxSeconds, fb, toneHz) {
    this.l = new Float32Array(Math.trunc(maxSeconds * sr) + 1);
    this.r = new Float32Array(this.l.length);
    this.w = 0; this.lp = 0; this.fb = fb;
    this.c = glide(1 / (TAU * toneHz), sr);
    this._len = this.l.length - 1;
    this.outL = 0; this.outR = 0;
  }
  set len(v) { this._len = clamp(v, 1, this.l.length - 1); }
  run(x) {
    let ri = this.w - this._len;
    if (ri < 0) ri += this.l.length;
    const yl = this.l[ri], yr = this.r[ri];
    this.lp += (yr - this.lp) * this.c;
    this.l[this.w] = x + this.lp * this.fb;
    this.r[this.w] = yl * this.fb;
    if (++this.w === this.l.length) this.w = 0;
    this.outL = yl;
    this.outR = yr;
  }
}

class Buf {
  constructor(n) { this.b = new Float32Array(Math.max(8, n)); this.i = 0; this.f = 0; }
}

/** Small Freeverb: 4 combs + 2 allpasses per side. */
class Reverb {
  constructor(sr, size, fb, damp) {
    this.fb = fb; this.damp = damp;
    const s = sr / 44100 * size;
    this.cl = [1557, 1617, 1491, 1422].map((n) => new Buf(Math.round(n * s)));
    this.cr = [1580, 1640, 1514, 1445].map((n) => new Buf(Math.round(n * s)));
    this.al = [556, 441].map((n) => new Buf(Math.round(n * s / size)));
    this.ar = [579, 464].map((n) => new Buf(Math.round(n * s / size)));
    this.outL = 0; this.outR = 0;
  }
  comb(c, x) {
    const y = c.b[c.i];
    c.f = y * (1 - this.damp) + c.f * this.damp;
    c.b[c.i] = x + c.f * this.fb;
    if (++c.i === c.b.length) c.i = 0;
    return y;
  }
  allpass(a, x) {
    const y = a.b[a.i];
    a.b[a.i] = x + y * 0.5;
    if (++a.i === a.b.length) a.i = 0;
    return y - x;
  }
  run(l, r) {
    const x = (l + r) * 0.08;
    let yl = 0, yr = 0;
    for (let j = 0; j < 4; j++) {
      yl += this.comb(this.cl[j], x);
      yr += this.comb(this.cr[j], x);
    }
    for (let j = 0; j < 2; j++) {
      yl = this.allpass(this.al[j], yl);
      yr = this.allpass(this.ar[j], yr);
    }
    this.outL = yl;
    this.outR = yr;
  }
}

/** Short delay line with a fractional read (Haas widening, chorus). */
class Line {
  constructor(sr, maxSeconds) {
    this.sr = sr;
    this.b = new Float32Array(Math.round(maxSeconds * sr) + 2);
    this.i = 0;
  }
  push(x) {
    this.b[this.i] = x;
    if (++this.i === this.b.length) this.i = 0;
  }
  tap(seconds) {
    let p = this.i - 1 - seconds * this.sr;
    while (p < 0) p += this.b.length;
    const i0 = Math.trunc(p);
    const f = p - i0;
    return this.b[i0] * (1 - f) + this.b[(i0 + 1) % this.b.length] * f;
  }
}

export const KICK_UP_TO = 0.33;
export const SNARE_UP_TO = 0.66;

/** Where a drum hit lands: 0 kick, 1 tom/snare, 2 hat; same edges as the grid on screen. */
const drumZone = (tune) => (tune < KICK_UP_TO ? 0 : tune < SNARE_UP_TO ? 1 : 2);
/** 0..1 across the tom/snare zone. */
const snareSpan = (tune) => (tune - KICK_UP_TO) / (SNARE_UP_TO - KICK_UP_TO);

/**
 * How tilt and lift colour a drum kit, per block: tone -0.5…+0.5 moves the noise filters, click 0.5…1.5
 * scales the kick's click, tune raises the pitched parts up to 3 semitones when upright.
 */
class DrumColour {
  constructor() { this.tone = 0; this.click = 1; this.tune = 1; }
  set(c) {
    const bright = (c.tiltX + 1) / 2;
    this.tone = bright - 0.5;
    this.click = 0.5 + bright;
    this.tune = pow2(c.tiltY * 3 / 12);
  }
}

/**
 * Shaker colour from the band held on screen (Ctl.held): its length → brightness (the shaker filter
 * ×0.5…×2), its bend → grain (smooth "shh" at 0 … sparse rattles at 1). With no fingers: unchanged.
 */
class ShakerShape {
  constructor(sr, noise) {
    this.sr = sr; this.noise = noise;
    this.env = 0; this.g = 0; this.p = 0;
    this.gd = decay(0.003, sr);
    this.cutoff = 1;
  }
  set(c) {
    this.g = c.held ? c.bend : 0;
    this.cutoff = c.held ? pow2((c.tension - 0.5) * 2) : 1;
    this.p = 3000 * Math.pow(60 / 3000, this.g) / this.sr; // grains per sample
  }
  /** Per sample: the shaker's level. */
  amp() {
    if (this.g <= 0) return 1;
    if (this.noise.next() * 0.5 + 0.5 < this.p) this.env = 0.5 + 0.5 * Math.abs(this.noise.next());
    else this.env *= this.gd;
    return (1 - this.g) + this.g * this.env * 2.5;
  }
}

/** What an instrument gets once per block, from a frame. */
class Ctl {
  constructor() {
    this.gate = false;
    /** Fingers are on the band (the raw gate; drums get gate false but use this for the shaker). */
    this.held = false;
    /** The finger just touched: gate rose in this block. */
    this.on = false;
    this.freq = 110; this.tension = 0; this.bend = 0;
    this.tiltX = 0; this.tiltY = 0; this.shake = 0; this.bpm = 100;
  }
}

/**
 * Pitch glide, amplitude, a per-note envelope, vibrato and shake wobble shared by the melodic voices.
 * Each instrument holds one (`mel`) rather than extending it: one class behind every call keeps V8's
 * property lookups fast (a base class shared by six subclasses made step() the slowest line).
 */
class Melodic {
  constructor(sr, pitchGlide, attack, release) {
    this.sr = sr;
    this.pg = glide(pitchGlide, sr);
    this.att = glide(attack, sr);
    this.rel = glide(release, sr);
    this.freq = 0; this.vp = 0; this.wp = 0;
    this.amp = 0; this.env = 0; this.envD = 0;
    /** Samples since the voice went quiet; lets echo and reverb tails ring out, then the voice sleeps. */
    this.quiet = 0;
  }
  /** One sample: glides pitch and amplitude toward the targets; returns the frequency with vibrato and wobble. */
  step(c, targetAmp, vibDepth) {
    if (this.freq === 0) this.freq = c.freq;
    this.freq += (c.freq - this.freq) * this.pg;
    this.amp += (targetAmp - this.amp) * (targetAmp > this.amp ? this.att : this.rel);
    this.env *= this.envD;
    this.vp = wrap(this.vp + 5.5 / this.sr);
    this.wp = wrap(this.wp + 11 / this.sr);
    return this.freq * Math.exp((vibDepth * sin(TAU * this.vp) + 1.5 * c.shake * sin(TAU * this.wp)) * SEMITONE);
  }
  /** True when nothing would be heard: not playing and the tail (tailSeconds) has run out. */
  asleep(c, n, tailSeconds) {
    if (c.gate || this.amp > 1e-5) {
      this.quiet = 0;
      return false;
    }
    if (this.quiet > tailSeconds * this.sr) return true;
    this.quiet += n;
    return false;
  }
}

const GROWL_DETUNE = [1, 1.0065, 0.9938];

/** Bass "growl": three detuned saws → drive → resonant low-pass → drive; a clean sub; the top widened. */
class GrowlBass {
  constructor(sr) {
    this.sr = sr;
    this.mel = new Melodic(sr, 0.02, 0.004, 0.06);
    this.p = new Float64Array([0, 0.33, 0.67]);
    this.ps = 0;
    this.f = new Svf(sr);
    this.lfo = 0; this.hlp = 0;
    this.hc = glide(1 / (TAU * 250), sr);
    this.haas = new Float32Array(Math.round(0.011 * sr));
    this.hi = 0;
    this.envDecay = decay(0.25, sr);
  }
  hit() { return false; }
  render(l, r, n, c, gain) {
    const mel = this.mel;
    if (mel.asleep(c, n, 0.05)) return;
    const sr = this.sr;
    if (c.on) {
      mel.env = 1;
      mel.envD = this.envDecay;
    }
    const bright = (c.tiltX + 1) / 2;
    const base = 110 * pow2(bright * 4.2);
    // the phone is held at an angle while playing: only the last stretch toward upright wobbles
    const wub = clamp((c.tiltY - 0.8) / 0.2, 0, 1);
    const drv = 1.5 + 5 * c.bend;
    const k = 0.95 - 0.55 * c.bend;
    const ta = c.gate ? 1 : 0;
    const lfoStep = c.bpm / 60 * 2 / sr;
    const p = this.p, f = this.f, haas = this.haas;
    for (let i = 0; i < n; i++) {
      const fr = mel.step(c, ta, 0);
      this.lfo = wrap(this.lfo + lfoStep);
      let x = 0;
      for (let j = 0; j < 3; j++) {
        const dt = fr * GROWL_DETUNE[j] / sr;
        p[j] = wrap(p[j] + dt);
        x += saw(p[j], dt);
      }
      x = tanh(x * 0.4 * drv);
      if ((i & 7) === 0) {
        const w = (0.5 - 0.5 * Math.cos(TAU * this.lfo)) * wub * 3 - wub * 1.2;
        f.set(base * (1 + 1.5 * mel.env) * pow2(w), k);
      }
      let y = f.run(x);
      y = tanh((y + 0.3 * f.bp) * 1.5);
      this.ps = wrap(this.ps + fr / sr);
      const sub = 0.55 * sin(TAU * this.ps);
      this.hlp += (y - this.hlp) * this.hc;
      const top = y - this.hlp;
      const topLate = haas[this.hi];
      haas[this.hi] = top;
      if (++this.hi === haas.length) this.hi = 0;
      l[i] += (y + sub) * mel.amp * gain;
      r[i] += (y - top + topLate + sub) * mel.amp * gain;
    }
  }
}

/** Lead "pluck": saw + square through a low-pass that snaps open on every touch; dotted-eighth echo, reverb. */
class PluckLead {
  constructor(sr) {
    this.sr = sr;
    this.mel = new Melodic(sr, 0.015, 0.002, 0.15);
    this.p1 = 0; this.p2 = 0.5;
    this.f = new Svf(sr);
    this.a2 = 0;
    this.ad = decay(0.25, sr);
    this.echo = new PingPong(sr, 0.75 * 60 / 40, 0.45, 4000);
    this.room = new Reverb(sr, 1, 0.8, 0.4);
  }
  hit() { return false; }
  render(l, r, n, c, gain) {
    const mel = this.mel;
    if (mel.asleep(c, n, 6)) return;
    const sr = this.sr;
    if (c.on) {
      mel.env = 1;
      mel.envD = decay(0.1 + 0.25 * c.bend, sr);
      this.a2 = 1;
    }
    const echo = this.echo, room = this.room, f = this.f;
    echo.len = Math.round(0.75 * 60 / c.bpm * sr);
    const bright = (c.tiltX + 1) / 2;
    const base = 250 * pow2(bright * 3.5);
    const k = 1 - 0.7 * c.bend;
    const ta = c.gate ? 1 : 0;
    const drv = 1.2 + 2 * c.bend;
    for (let i = 0; i < n; i++) {
      const fr = mel.step(c, ta, 0.45 * c.tiltY);
      this.a2 *= this.ad;
      const d1 = fr / sr;
      const d2 = fr * 1.005 / sr;
      this.p1 = wrap(this.p1 + d1);
      this.p2 = wrap(this.p2 + d2);
      if ((i & 7) === 0) f.set(base * pow2(mel.env * 4), k);
      const y = tanh(f.run(0.6 * saw(this.p1, d1) + 0.5 * sqr(this.p2, d2)) * drv) * mel.amp * (0.35 + 0.65 * this.a2);
      echo.run(y);
      room.run(y + 0.6 * echo.outL, y + 0.6 * echo.outR);
      l[i] += (y + 0.38 * echo.outL + 0.25 * room.outL) * gain;
      r[i] += (y + 0.38 * echo.outR + 0.25 * room.outR) * gain;
    }
  }
}

const HAT_HZ = [205.3, 304.4, 369.6, 522.7, 540, 800];

/** Drums "808": kick with click and drive, two-tone snare, metallic hat; shaking adds a shaker. */
class Kit808 {
  constructor(sr) {
    this.sr = sr;
    this.noise = new Noise();
    this.kp = 0; this.ke = 0; this.kpe = 0; this.kf0 = 50; this.kd = 0; this.kcl = 0;
    this.pd = decay(0.028, sr);
    this.cd = decay(0.0025, sr);
    this.mp1 = 0; this.mp2 = 0; this.mte = 0; this.mtd = 0; this.mne = 0; this.mnd = 0; this.mf = 150; this.mu = 0;
    this.ms = new Svf(sr).set(1800, 0.8);
    this.hp = new Float64Array(6);
    this.he = 0; this.hd = 0;
    this.hs = new Svf(sr).set(7500, 0.7);
    this.shs = new Svf(sr).set(5000, 1);
    this.col = new DrumColour();
    this.shape = new ShakerShape(sr, this.noise);
  }
  hit(tune, vel, bend) {
    const sr = this.sr;
    switch (drumZone(tune)) {
      case 0:
        this.kf0 = 48 * pow2(tune * 1.5);
        this.kp = 0; this.ke = vel; this.kpe = 1;
        this.kd = decay(0.38 * (1 + 1.5 * bend), sr);
        this.kcl = vel;
        return true;
      case 1: {
        const u = snareSpan(tune);
        this.mu = u;
        this.mf = 110 * pow2(u * 1.3);
        this.mte = vel;
        this.mtd = decay(0.2 * (1 - 0.5 * u) * (1 + bend), sr);
        this.mne = vel * u * u;
        this.mnd = decay(0.13 + 0.15 * bend, sr);
        this.mp1 = 0; this.mp2 = 0;
        return false;
      }
      default:
        this.he = vel;
        this.hd = decay(0.045 + 0.35 * bend, sr);
        return false;
    }
  }
  render(l, r, n, c, gain) {
    const shaker = 0.35 * c.shake * c.shake;
    if (this.ke <= 1e-4 && this.mte <= 1e-4 && this.mne <= 1e-4 && this.he <= 1e-4 && shaker <= 0) return;
    const sr = this.sr, col = this.col, noise = this.noise, ms = this.ms, hs = this.hs, shs = this.shs, hp = this.hp;
    col.set(c);
    ms.set(1800 * pow2(col.tone * 2), 0.8);
    hs.set(7500 * pow2(col.tone * 1.2), 0.7);
    this.shape.set(c);
    shs.set(5000 * this.shape.cutoff, 1);
    for (let i = 0; i < n; i++) {
      let left = 0, right = 0;
      if (this.ke > 1e-4) {
        this.kpe *= this.pd;
        this.kp = wrap(this.kp + this.kf0 * col.tune * (1 + 4 * this.kpe) / sr);
        const y = tanh((sin(TAU * this.kp) * this.ke + 0.4 * col.click * noise.next() * this.kcl) * 2.5) * 0.8;
        this.ke *= this.kd;
        this.kcl *= this.cd;
        left += y;
        right += y;
      }
      if (this.mte > 1e-4 || this.mne > 1e-4) {
        this.mp1 = wrap(this.mp1 + this.mf * col.tune / sr);
        this.mp2 = wrap(this.mp2 + this.mf * col.tune * 1.48 / sr);
        const tone = (0.75 * sin(TAU * this.mp1) + 0.35 * sin(TAU * this.mp2)) * this.mte;
        ms.run(noise.next());
        const nz = (0.7 * ms.hp + 0.5 * ms.bp) * this.mne;
        const y = tanh((tone + nz) * 1.6) * 0.75;
        this.mte *= this.mtd;
        this.mne *= this.mnd;
        const pan = 0.5 - 0.35 * (1 - this.mu);
        left += y * (1 - pan) * 1.4;
        right += y * pan * 1.4;
      }
      if (this.he > 1e-4) {
        let x = 0;
        for (let j = 0; j < 6; j++) {
          hp[j] = wrap(hp[j] + HAT_HZ[j] * 1.7 * col.tune / sr);
          x += hp[j] < 0.5 ? 1 : -1;
        }
        hs.run(x / 6 * 0.8 + 0.3 * noise.next());
        const y = hs.hp * this.he * 0.6;
        this.he *= this.hd;
        left += y * 0.7;
        right += y * 1.1;
      }
      if (shaker > 0) {
        shs.run(noise.next());
        const y = shs.hp * shaker * this.shape.amp();
        left += y * 0.6;
        right += y;
      }
      l[i] += left * gain;
      r[i] += right * gain;
    }
  }
}

/** Bass "acid": one saw through a resonant low-pass that snaps open on every touch and falls back. */
class AcidBass {
  constructor(sr) {
    this.sr = sr;
    this.mel = new Melodic(sr, 0.035, 0.002, 0.04);
    this.f = new Svf(sr);
    this.p = 0; this.ps = 0;
  }
  hit() { return false; }
  render(l, r, n, c, gain) {
    const mel = this.mel;
    if (mel.asleep(c, n, 0.05)) return;
    const sr = this.sr, f = this.f;
    if (c.on) {
      mel.env = 1;
      mel.envD = decay(0.14 + 0.5 * c.bend, sr);
    }
    const bright = (c.tiltX + 1) / 2;
    const base = 80 * pow2(bright * 3.5);
    const envOct = 2.5 + 3 * c.bend;
    const k = 0.5 - 0.4 * c.bend;
    const ta = c.gate ? 1 : 0;
    const drv = 2 + 4 * c.bend;
    for (let i = 0; i < n; i++) {
      const fr = mel.step(c, ta, 0.3 * c.tiltY);
      const dt = fr / sr;
      this.p = wrap(this.p + dt);
      this.ps = wrap(this.ps + dt);
      if ((i & 7) === 0) f.set(base * pow2(mel.env * envOct), k);
      const y = tanh(f.run(saw(this.p, dt) * 1.2) * drv) * 0.8;
      const s = (y + 0.35 * sin(TAU * this.ps)) * mel.amp * (0.75 + 0.25 * mel.env) * gain;
      l[i] += s;
      r[i] += s;
    }
  }
}

/** Bass "FM": a sine phase-modulated by itself: a bark on the attack and mids a phone speaker can play. */
class FmBass {
  constructor(sr) {
    this.sr = sr;
    this.mel = new Melodic(sr, 0.02, 0.002, 0.05);
    this.pc = 0; this.pm = 0; this.pm2 = 0;
  }
  hit() { return false; }
  render(l, r, n, c, gain) {
    const mel = this.mel;
    if (mel.asleep(c, n, 0.05)) return;
    const sr = this.sr;
    if (c.on) {
      mel.env = 1;
      mel.envD = decay(0.11 + 0.3 * c.bend, sr);
    }
    const bright = (c.tiltX + 1) / 2;
    const idx0 = 0.6 + 2.6 * c.bend + 2.2 * bright;
    const ta = c.gate ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const fr = mel.step(c, ta, 0.3 * c.tiltY);
      this.pc = wrap(this.pc + fr / sr);
      this.pm = wrap(this.pm + fr / sr);
      this.pm2 = wrap(this.pm2 + fr * 2 / sr);
      const idx = idx0 * (0.3 + 0.7 * mel.env);
      const mod = sin(TAU * this.pm) + 0.35 * mel.env * sin(TAU * this.pm2);
      const s = tanh(sin(TAU * this.pc + idx * mod) * 1.7) * 0.85 * mel.amp * gain;
      l[i] += s;
      r[i] += s;
    }
  }
}

const WIDE_OFFSET = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];
/** 1 = mostly left, 0 = mostly right. */
const WIDE_SIDE = [1, 0, 1, 0.5, 0, 1, 0];

/** Lead "wide": seven detuned saws split left/right, a filter, a 3/16 ping-pong echo and a hall. */
class WideLead {
  constructor(sr) {
    this.sr = sr;
    this.mel = new Melodic(sr, 0.02, 0.01, 0.12);
    this.p = Float64Array.from({ length: 7 }, (_, i) => (i * 0.618) % 1);
    this.rat = new Float64Array(7);
    this.fl = new Svf(sr);
    this.fr = new Svf(sr);
    this.echo = new PingPong(sr, 0.75 * 60 / 40, 0.38, 3500);
    this.room = new Reverb(sr, 1.1, 0.84, 0.35);
    this.envDecay = decay(0.3, sr);
  }
  hit() { return false; }
  render(l, r, n, c, gain) {
    const mel = this.mel;
    if (mel.asleep(c, n, 6)) return;
    const sr = this.sr, p = this.p, rat = this.rat, echo = this.echo, room = this.room;
    if (c.on) {
      mel.env = 1;
      mel.envD = this.envDecay;
    }
    echo.len = Math.round(0.75 * 60 / c.bpm * sr);
    const bright = (c.tiltX + 1) / 2;
    const cents = 14 + 30 * c.bend;
    for (let j = 0; j < 7; j++) rat[j] = pow2(WIDE_OFFSET[j] * cents / 1200) / sr;
    const k = 1.1 - 0.6 * c.bend;
    const ta = c.gate ? 0.5 + 0.5 * c.tension : 0;
    for (let i = 0; i < n; i++) {
      const f = mel.step(c, ta, 0.5 * c.tiltY);
      let xl = 0, xr = 0;
      for (let j = 0; j < 7; j++) {
        const dt = f * rat[j];
        p[j] = wrap(p[j] + dt);
        const s = saw(p[j], dt);
        xl += s * (0.25 + 0.75 * WIDE_SIDE[j]);
        xr += s * (1 - 0.75 * WIDE_SIDE[j]);
      }
      if ((i & 15) === 0) {
        const fc = 400 * pow2(bright * 4.5) * (1 + 1.5 * mel.env);
        this.fl.set(fc, k);
        this.fr.set(fc, k);
      }
      const yl = tanh(this.fl.run(xl * 0.22) * 1.3) * mel.amp;
      const yr = tanh(this.fr.run(xr * 0.22) * 1.3) * mel.amp;
      echo.run((yl + yr) * 0.5);
      room.run(yl + 0.5 * echo.outL, yr + 0.5 * echo.outR);
      l[i] += (yl + 0.32 * echo.outL + 0.3 * room.outL) * gain;
      r[i] += (yr + 0.32 * echo.outR + 0.3 * room.outR) * gain;
    }
  }
}

/** Formants in Hz: U, O, A, E, I. */
const VOWELS = [[325, 700, 2530], [450, 800, 2830], [800, 1150, 2900], [400, 1600, 2700], [300, 2300, 3000]];
const FORMANT_GAIN = [1, 0.7, 0.35];

/** Lead "voice": a saw through three vowel formants; tilt moves the vowel U-O-A-E-I, bend opens it toward A. */
class VoiceLead {
  constructor(sr) {
    this.sr = sr;
    this.mel = new Melodic(sr, 0.03, 0.02, 0.12);
    this.noise = new Noise();
    this.p = 0;
    this.bp = [new Svf(sr), new Svf(sr), new Svf(sr)];
    this.vowel = 1;
    this.vg = glide(0.05, sr);
    this.line = new Line(sr, 0.03);
    this.cp = 0;
    this.room = new Reverb(sr, 1.2, 0.85, 0.3);
  }
  hit() { return false; }
  render(l, r, n, c, gain) {
    const mel = this.mel;
    if (mel.asleep(c, n, 4)) return;
    const sr = this.sr, bp = this.bp, line = this.line, room = this.room;
    const bright = (c.tiltX + 1) / 2;
    const tv = clamp(bright * 0.9 + 0.4 * c.bend, 0, 1) * 4;
    const ta = c.gate ? 0.6 + 0.4 * c.tension : 0;
    const drv = 2 + 2 * c.bend;
    for (let i = 0; i < n; i++) {
      const f = mel.step(c, ta, 0.15 + 0.5 * c.tiltY);
      const dt = f / sr;
      this.p = wrap(this.p + dt);
      this.vowel += (tv - this.vowel) * this.vg;
      if ((i & 15) === 0) {
        const a = Math.trunc(clamp(this.vowel, 0, 3.999));
        const fr = this.vowel - a;
        for (let j = 0; j < 3; j++) bp[j].set(VOWELS[a][j] * (1 - fr) + VOWELS[a + 1][j] * fr, j === 0 ? 0.25 : 0.14);
      }
      const x = saw(this.p, dt) + 0.06 * this.noise.next();
      let y = 0;
      for (let j = 0; j < 3; j++) {
        bp[j].run(x);
        y += bp[j].bp * bp[j].k * FORMANT_GAIN[j];
      }
      y = tanh(y * drv) * mel.amp;
      line.push(y);
      this.cp = wrap(this.cp + 0.6 / sr);
      const ch = line.tap(0.012 + 0.004 * sin(TAU * this.cp));
      room.run(y, ch);
      l[i] += (y + 0.3 * room.outL) * gain;
      r[i] += (0.6 * y + 0.5 * ch + 0.3 * room.outR) * gain;
    }
  }
}

/** Drums "hard": a heavily driven kick, a hand clap (three bursts and a tail) over a tom tone, a sharp hat. */
class KitHard {
  constructor(sr) {
    this.sr = sr;
    this.noise = new Noise();
    this.kp = 0; this.ke = 0; this.kpe = 0; this.kd = 0; this.kcl = 0;
    this.pd = decay(0.018, sr);
    this.cd = decay(0.002, sr);
    /** Samples since the clap started; past 2 s it is silent. */
    this.mt = Number.MAX_SAFE_INTEGER;
    this.mv = 0; this.mtail = 0.15; this.mu = 0; this.mp = 0; this.mte = 0; this.mtd = 0; this.mf = 100;
    this.ms = new Svf(sr).set(1150, 0.55);
    this.line = new Line(sr, 0.02);
    this.he = 0; this.hd = 0; this.hp = 0;
    this.hs = new Svf(sr).set(8500, 0.6);
    this.burst = 0.008 * sr;
    this.burstDecay = 0.002 * sr;
    this.col = new DrumColour();
    this.shs = new Svf(sr).set(6000, 1);
    this.shape = new ShakerShape(sr, this.noise);
  }
  hit(tune, vel, bend) {
    const sr = this.sr;
    switch (drumZone(tune)) {
      case 0:
        this.kp = 0; this.ke = vel; this.kpe = 1;
        this.kd = decay(0.42 * (1 + bend), sr);
        this.kcl = vel;
        return true;
      case 1: {
        const u = snareSpan(tune);
        this.mt = 0;
        this.mu = u;
        this.mv = vel;
        this.mtail = 0.12 + 0.2 * bend;
        this.mf = 95 * pow2(u * 1.1);
        this.mte = vel * (1 - u);
        this.mtd = decay(0.22, sr);
        this.mp = 0;
        return false;
      }
      default:
        this.he = vel;
        this.hd = decay(0.03 + 0.3 * bend, sr);
        return false;
    }
  }
  render(l, r, n, c, gain) {
    const sr = this.sr;
    const sh = 0.4 * c.shake * c.shake;
    if (this.ke <= 1e-4 && this.mt > 2 * sr && this.he <= 1e-4 && sh <= 0) return;
    const col = this.col, noise = this.noise, ms = this.ms, hs = this.hs, shs = this.shs, line = this.line;
    col.set(c);
    ms.set(1150 * pow2(col.tone * 1.6), 0.55);
    hs.set(8500 * pow2(col.tone), 0.6);
    this.shape.set(c);
    shs.set(6000 * this.shape.cutoff, 1);
    const burst = this.burst, burstDecay = this.burstDecay;
    for (let i = 0; i < n; i++) {
      let left = 0, right = 0;
      if (this.ke > 1e-4) {
        this.kpe *= this.pd;
        this.kp = wrap(this.kp + 46 * col.tune * (1 + 7 * this.kpe) / sr);
        const y = tanh((sin(TAU * this.kp) * this.ke + 0.5 * col.click * this.kcl * sin(TAU * this.kp * 37)) * 7) * 0.55;
        this.ke *= this.kd;
        this.kcl *= this.cd;
        left += y;
        right += y;
      }
      let clap = 0;
      if (this.mt < 2 * sr) {
        const t = this.mt++;
        const env = t < 3 * burst ? Math.exp(-(t % burst) / burstDecay) : Math.exp(-(t - 3 * burst) / (this.mtail * sr));
        ms.run(noise.next());
        clap = ms.bp * env * this.mv * (0.3 + 0.7 * this.mu) * 1.6;
        this.mp = wrap(this.mp + this.mf * col.tune * (1 + 0.5 * this.mte) / sr);
        clap += sin(TAU * this.mp) * this.mte;
        this.mte *= this.mtd;
      }
      line.push(clap);
      left += clap;
      right += 0.6 * clap + 0.5 * line.tap(0.009);
      if (sh > 0) {
        shs.run(noise.next());
        const y = shs.hp * sh * this.shape.amp();
        left += y * 0.8;
        right += y;
      }
      if (this.he > 1e-4) {
        this.hp = wrap(this.hp + 3970 * col.tune / sr);
        hs.run(noise.next() * (this.hp < 0.5 ? 1 : -0.4));
        const y = hs.hp * this.he * 0.55;
        this.he *= this.hd;
        left += y * 0.8;
        right += y;
      }
      l[i] += tanh(left * 1.3) * gain;
      r[i] += tanh(right * 1.3) * gain;
    }
  }
}

/** Drums "lo-fi": a soft kit through an "old sampler" (12 bit at half rate, two low-passes, saturation) and a room. */
class KitLofi {
  constructor(sr) {
    this.sr = sr;
    this.noise = new Noise();
    this.kp = 0; this.ke = 0; this.kpe = 0; this.kd = 0; this.kcl = 0;
    this.pd = decay(0.04, sr);
    this.cd = decay(0.004, sr);
    this.mp = 0; this.mte = 0; this.mtd = 0; this.mne = 0; this.mnd = 0; this.mf = 185;
    this.ms = new Svf(sr).set(2200, 1);
    this.he = 0; this.hd = 0;
    this.hs = new Svf(sr).set(7000, 1.2);
    this.shs = new Svf(sr).set(4000, 1.2);
    this.lpA = 0;
    this.col = new DrumColour();
    this.shape = new ShakerShape(sr, this.noise);
    this.hc = 0; this.hl = 0; this.hr = 0;
    this.l1 = 0; this.l2 = 0; this.r1 = 0; this.r2 = 0;
    this.room = new Reverb(sr, 0.5, 0.72, 0.5);
    /** Samples since the last sound; lets the room ring out, then the kit sleeps. */
    this.quiet = Number.MAX_SAFE_INTEGER / 2;
  }
  hit(tune, vel, bend) {
    const sr = this.sr;
    const v = vel * (0.9 + 0.1 * this.noise.next());
    this.quiet = 0;
    switch (drumZone(tune)) {
      case 0:
        this.kp = 0; this.ke = v; this.kpe = 1;
        this.kd = decay(0.32 * (1 + bend), sr);
        this.kcl = v;
        return true;
      case 1: {
        const u = snareSpan(tune);
        this.mf = 150 * pow2(u * 0.8);
        this.mte = v * (1 - 0.3 * u);
        this.mtd = decay(0.09 * (1 + bend), sr);
        this.mne = v * (0.35 + 0.65 * u);
        this.mnd = decay(0.16 * (1 + bend), sr);
        this.mp = 0;
        return false;
      }
      default:
        this.he = v * 0.7;
        this.hd = decay(0.04 + 0.25 * bend, sr);
        return false;
    }
  }
  render(l, r, n, c, gain) {
    const sr = this.sr;
    const shaker = 0.3 * c.shake * c.shake;
    if (shaker > 0) this.quiet = 0;
    if (this.quiet > 2 * sr) return;
    this.quiet += n;
    const col = this.col, noise = this.noise, ms = this.ms, hs = this.hs, shs = this.shs, room = this.room;
    col.set(c);
    const lpA = glide(1 / (TAU * 8000 * pow2(col.tone * 2)), sr);
    ms.set(2200 * pow2(col.tone * 1.4), 1);
    hs.set(7000 * pow2(col.tone), 1.2);
    this.shape.set(c);
    shs.set(4000 * this.shape.cutoff, 1.2);
    for (let i = 0; i < n; i++) {
      let x = 0, top = 0;
      if (this.ke > 1e-4) {
        this.kpe *= this.pd;
        this.kp = wrap(this.kp + 52 * col.tune * (1 + 1.5 * this.kpe) / sr);
        x += tanh((sin(TAU * this.kp) * this.ke + 0.25 * col.click * noise.next() * this.kcl) * 1.3);
        this.ke *= this.kd;
        this.kcl *= this.cd;
      }
      if (this.mte > 1e-4 || this.mne > 1e-4) {
        this.mp = wrap(this.mp + this.mf * col.tune / sr);
        const lp = ms.run(noise.next());
        x += sin(TAU * this.mp) * this.mte * 0.8 + (0.9 * ms.bp + 0.2 * lp) * this.mne;
        this.mte *= this.mtd;
        this.mne *= this.mnd;
      }
      if (this.he > 1e-4) {
        hs.run(noise.next());
        top += hs.hp * this.he * 0.5;
        this.he *= this.hd;
      }
      if (shaker > 0) {
        shs.run(noise.next());
        top += shs.hp * shaker * this.shape.amp();
      }
      const sl = x + 0.8 * top;
      const sR = x + 1.1 * top;
      if (++this.hc >= 2) {
        this.hc = 0;
        this.hl = Math.round(sl * 2048) / 2048;
        this.hr = Math.round(sR * 2048) / 2048;
      }
      this.l1 += (this.hl - this.l1) * lpA;
      this.l2 += (this.l1 - this.l2) * lpA;
      this.r1 += (this.hr - this.r1) * lpA;
      this.r2 += (this.r1 - this.r2) * lpA;
      const ol = tanh(this.l2 * 1.4);
      const or = tanh(this.r2 * 1.4);
      room.run(ol, or);
      l[i] += (ol + 0.3 * room.outL) * gain;
      r[i] += (or + 0.3 * room.outR) * gain;
    }
  }
}

const THRESHOLD = 0.3;
const RATIO = 4;

/**
 * Master "juicy": bass and lead duck under every kick, the drums get a small room, a bus compressor,
 * tanh on the peaks. Writes interleaved stereo.
 */
export class Master {
  constructor(sr) {
    this.room = new Reverb(sr, 0.7, 0.75, 0.45);
    this.duckAtt = glide(0.004, sr);
    this.duckRel = decay(0.16, sr);
    this.compAtt = glide(0.008, sr);
    this.compRel = glide(0.15, sr);
    this.duck = 0; this.rising = false; this.env = 0;
  }
  render(toneL, toneR, drumL, drumR, n, kicked, out) {
    if (kicked) this.rising = true;
    const room = this.room;
    for (let i = 0; i < n; i++) {
      if (this.rising) {
        this.duck += (1 - this.duck) * this.duckAtt;
        if (this.duck > 0.98) this.rising = false;
      } else {
        this.duck *= this.duckRel;
      }
      const g = 1 - 0.45 * this.duck;
      room.run(drumL[i] * 0.5, drumR[i] * 0.5);
      const l = toneL[i] * g + drumL[i] + 0.22 * room.outL;
      const r = toneR[i] * g + drumR[i] + 0.22 * room.outR;
      const x = Math.max(Math.abs(l), Math.abs(r));
      this.env += (x - this.env) * (x > this.env ? this.compAtt : this.compRel);
      const cg = this.env > THRESHOLD ? (THRESHOLD + (this.env - THRESHOLD) / RATIO) / this.env : 1;
      out[2 * i] = tanh(l * cg * 1.8);
      out[2 * i + 1] = tanh(r * cg * 1.8);
    }
  }
}

// ---- Mode.kt ----

/**
 * Instrument family: pitch range and screen behaviour (drums show hit zones instead of note rings).
 * Stretch 0..1 maps to `octaves` octaves up from `base` Hz.
 */
export const Kind = {
  BASS: { name: 'BASS', base: 27.5, octaves: 3.5 }, // A0 … ~310 Hz
  DRUMS: { name: 'DRUMS', base: 45, octaves: 3 }, // kick … high tom
  LEAD: { name: 'LEAD', base: 110, octaves: 4 }, // A2 … A6
};

/**
 * The nine sounds. The index (`id`) is stored in session files, as Kotlin's Mode ordinal: only append.
 * `gain` levels them as on the comparison page; `short` fits a track cell, `title` goes on the Sound button.
 */
export const MODES = [
  ['BASS', 'Growl bass', 'Growl', Kind.BASS, 0.323],
  ['DRUMS', '808 drums', '808', Kind.DRUMS, 0.47],
  ['LEAD', 'Pluck lead', 'Pluck', Kind.LEAD, 0.357],
  ['ACID_BASS', 'Acid bass', 'Acid', Kind.BASS, 0.521],
  ['FM_BASS', 'FM bass', 'FM', Kind.BASS, 0.391],
  ['HARD_DRUMS', 'Hard drums', 'Hard', Kind.DRUMS, 0.415],
  ['LOFI_DRUMS', 'Lo-fi drums', 'Lo-fi', Kind.DRUMS, 0.364],
  ['WIDE_LEAD', 'Wide lead', 'Wide', Kind.LEAD, 0.581],
  ['VOICE_LEAD', 'Voice lead', 'Voice', Kind.LEAD, 0.331],
].map(([name, title, short, kind, gain], id) => ({
  id, name, title, short, kind, gain,
  drums: kind === Kind.DRUMS,
  freq: (tension) => kind.base * pow2(tension * kind.octaves),
  /** Inverse of freq: how far to stretch for `f` Hz. */
  tension: (f) => Math.log2(f / kind.base) / kind.octaves,
}));
export const Mode = Object.fromEntries(MODES.map((m) => [m.name, m]));

const ORDER = ['BASS', 'ACID_BASS', 'FM_BASS', 'DRUMS', 'HARD_DRUMS', 'LOFI_DRUMS', 'LEAD', 'WIDE_LEAD', 'VOICE_LEAD'];
/** The Sound button: through the basses, then the drums, then the leads. Takes and returns a mode id. */
export const nextMode = (id) => Mode[ORDER[(ORDER.indexOf(MODES[id].name) + 1) % ORDER.length]].id;

/** One snapshot of the gesture per audio block; a track is a flat Float32Array of these. */
export const Frame = {
  TENSION: 0, BEND: 1, GATE: 2, TILT_X: 3, TILT_Y: 4, SHAKE: 5,
  EVENT: 6, EV_A: 7, EV_B: 8,
  /** where the event happened, 0..1 of view width/height (for drawing) */
  EV_X: 9, EV_Y: 10,
  /** band shape for drawing: point count, then x,y pairs normalised to 0..1 of the view */
  COUNT: 11, PTS: 12, MAX_PTS: 6, SIZE: 12 + 2 * 6,
  EV_NONE: 0,
  /** drum hit: EV_A = tune 0..1, EV_B = loudness */
  EV_HIT: 2,
};

// ---- Voice.kt ----

const INSTRUMENTS = {
  BASS: GrowlBass, ACID_BASS: AcidBass, FM_BASS: FmBass,
  DRUMS: Kit808, HARD_DRUMS: KitHard, LOFI_DRUMS: KitLofi,
  LEAD: PluckLead, WIDE_LEAD: WideLead, VOICE_LEAD: VoiceLead,
};

/**
 * One track's (or the live) sound, driven by frames. Holds one instrument per mode; the frame's gesture goes
 * to the one matching the track's mode, the others get a closed gate, ring out and sleep.
 */
export class Voice {
  constructor(sr) {
    this.instruments = MODES.map((m) => new INSTRUMENTS[m.name](sr));
    this.c = new Ctl();
    this.wasGate = false;
  }

  /**
   * Renders `n` samples from the frame at frames[off] and ADDS them: melodic modes into toneL/toneR,
   * drums into drumL/drumR. Returns true when this block hit a kick.
   */
  render(toneL, toneR, drumL, drumR, n, frames, off, modeId, bpm) {
    const c = this.c;
    const mode = MODES[modeId];
    const gate = frames[off + Frame.GATE] > 0.5;
    const on = gate && !this.wasGate;
    this.wasGate = gate;
    const tension = frames[off + Frame.TENSION];
    const shake = frames[off + Frame.SHAKE];
    c.tension = tension;
    c.bend = frames[off + Frame.BEND];
    c.tiltX = frames[off + Frame.TILT_X];
    c.tiltY = frames[off + Frame.TILT_Y];
    c.bpm = bpm;

    let kicked = false;
    if (mode.drums && frames[off + Frame.EVENT] === Frame.EV_HIT) {
      kicked = this.instruments[modeId].hit(frames[off + Frame.EV_A], frames[off + Frame.EV_B], c.bend);
    }
    for (let i = 0; i < MODES.length; i++) {
      const m = MODES[i];
      const active = i === modeId;
      c.held = gate && active;
      c.gate = c.held && !m.drums;
      c.on = on && active;
      c.shake = active ? shake : 0;
      c.freq = m.freq(tension);
      if (m.drums) this.instruments[i].render(drumL, drumR, n, c, m.gain);
      else this.instruments[i].render(toneL, toneR, n, c, m.gain);
    }
    return kicked;
  }
}
