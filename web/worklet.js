// The audio thread and the looper: port of Android Engine.kt, as an AudioWorkletProcessor.
//
// The page (app.js) never touches looper state: it posts messages (the live gesture, hits, commands) to
// `port`, and this processor posts back what the screen shows (`state`, ~60 times a second) and a copy
// of a track's frames whenever they change (`frames`: the played ones for ghosts, the raw ones for saving).
//
// A track records into `raw`, shifted back by the measured latency (`comp`); it plays `frames`, which is
// `raw` with the grid applied (quantize.js) or a plain copy when the grid is off.
//
// The synth runs in 192-sample blocks, one Frame per block, like Android; the browser asks for 128
// samples at a time, served from whole blocks (mixPos), as on iOS.
import { Voice, Master, Mode, MODES, Frame, BLOCK } from './synth.js';
import { quantizeHits, quantizeNotes, DIVISION } from './quantize.js';

const MAX_SECONDS = 60;
const MIN_LOOP_SECONDS = 0.5;
const DEFAULT_MODES = [Mode.BASS.id, Mode.DRUMS.id, Mode.LEAD.id, Mode.LEAD.id];
/** Post the state every this many blocks (4 × 4 ms). */
const STATE_EVERY = 4;

/** Metronome tick: a short sine blip, higher on the downbeat. */
class Click {
  constructor(sr) {
    this.sr = sr;
    this.startIn = -1; this.freq = 0; this.phase = 0; this.env = 0;
    this.decay = Math.exp(-1 / (0.03 * sr));
  }
  /** Schedules the beat (if any) that falls in the block starting at sample `from` of a grid of `beat` samples. */
  tick(from, beat) {
    // beats fall on exact samples of the grid, not on block edges
    let k = Math.ceil(from / beat);
    while (k * beat < from + BLOCK) {
      this.startIn = Math.trunc(k * beat - from);
      this.freq = k % 4 === 0 ? 2000 : 1300;
      k++;
    }
  }
  /** Adds the click into interleaved stereo `out`, after the master. */
  render(out) {
    for (let i = 0; i < BLOCK; i++) {
      if (i === this.startIn) {
        this.env = 0.35;
        this.phase = 0;
        this.startIn = -1;
      }
      if (this.env < 1e-4) continue;
      this.phase += this.freq / this.sr;
      const s = Math.sin(2 * Math.PI * this.phase) * this.env;
      out[2 * i] += s;
      out[2 * i + 1] += s;
      this.env *= this.decay;
    }
    this.startIn = -1;
  }
}

export class Engine {
  constructor(sr, post) {
    this.sr = sr;
    this.post = post;
    this.blocksPerSecond = sr / BLOCK;
    this.maxBlocks = Math.trunc(MAX_SECONDS * this.blocksPerSecond);
    this.tracks = DEFAULT_MODES.map((mode) => ({
      mode, frames: new Float32Array(this.maxBlocks * Frame.SIZE), raw: new Float32Array(this.maxBlocks * Frame.SIZE),
      hasContent: false, muted: false, recording: false, level: 0,
    }));
    this.selected = 0;

    // live gesture
    this.tension = 0; this.bend = 0; this.gate = false;
    this.tiltX = 0; this.aim = 0; this.tiltY = 0; this.shake = 0;
    this.shape = new Float32Array(1 + 2 * Frame.MAX_PTS);
    /** Drum hits waiting for the next blocks: [tune, vel, x, y], one per block. */
    this.hits = [];

    // looper
    this.loopLen = 0; this.pos = 0; this.recCount = 0;
    this.metronome = true; this.bpm = 100;
    this.loopBeats = 0; this.barBlocks = 0; this.clickBlocks = 0; this.countingIn = -1;
    /** Once a loop exists, Rec waits for the next bar line: the track waiting, or -1, and that line's block. */
    this.armed = -1;
    this.armedAt = 0;
    /** Block where the current take started (later takes), for the red recorded part on screen. */
    this.recStart = 0;
    /** Pull hits and note starts toward the sixteenths (quantize.js). */
    this.grid = true;
    /**
     * Blocks a take is shifted back by: what the player hears is late by the output latency, and their
     * touch reaches us late by the input latency, so everything they play lands late by both.
     */
    this.comp = 0;

    this.liveVoice = new Voice(sr);
    this.voices = this.tracks.map(() => new Voice(sr));
    this.live = new Float32Array(Frame.SIZE);
    this.toneL = new Float32Array(BLOCK); this.toneR = new Float32Array(BLOCK);
    this.drumL = new Float32Array(BLOCK); this.drumR = new Float32Array(BLOCK);
    this.mix = new Float32Array(2 * BLOCK); // interleaved stereo
    this.mixPos = BLOCK; // samples of `mix` already served
    this.master = new Master(sr);
    this.click = new Click(sr);
    this.blockCount = 0;
    /** Share of real time spent rendering, over the last second (0.5 = half the time budget). */
    this.cpu = 0;
    /** The longest single render call over the last second, ms (1 ms resolution). */
    this.peakMs = 0;
    this.peak = 0;
    this.busyMs = 0;
    this.measured = 0;
  }

  /** A message from the page. */
  command(m) {
    switch (m.t) {
      case 'live':
        this.tension = m.tension; this.bend = m.bend; this.gate = m.gate; this.aim = m.aim;
        this.shape.set(m.shape);
        break;
      case 'motion': this.tiltX = m.tiltX; this.tiltY = m.tiltY; this.shake = m.shake; break;
      case 'hit': this.hits.push([m.tune, m.vel, m.x, m.y]); break;
      case 'select': this.selected = m.i; break;
      case 'mute': this.tracks[m.i].muted = !this.tracks[m.i].muted; break;
      case 'mode': this.tracks[m.i].mode = m.mode; this.applyGrid(m.i); break;
      case 'grid': this.grid = m.on; this.tracks.forEach((t, i) => this.applyGrid(i)); break;
      case 'latency': this.comp = Math.max(0, Math.round(m.seconds * this.blocksPerSecond)); break;
      case 'metronome': this.metronome = m.on; break;
      // tempo changes only before the first loop and while not counting in (BandView.changeTempo)
      case 'bpm': if (this.loopLen === 0 && this.barBlocks === 0) this.bpm = m.bpm; break;
      case 'rec': this.toggleRecord(this.selected); break;
      case 'clear': this.clear(m.i); break;
      case 'load': this.load(m.session); break;
    }
  }

  toggleRecord(i) {
    const t = this.tracks[i];
    if (t.recording) this.stopRecording(t);
    else if (this.countingIn >= 0 || this.armed >= 0) this.stopClicks(); // a second tap while waiting cancels
    else {
      for (const o of this.tracks) if (o.recording) this.stopRecording(o);
      if (this.loopLen === 0 && this.metronome) {
        this.barBlocks = Math.round(4 * 60 / this.bpm * this.blocksPerSecond);
        this.clickBlocks = 0;
        this.countingIn = i;
      } else if (this.loopLen > 0) {
        // a take over a loop starts on the next bar line and lasts one loop
        this.armed = i;
        this.armedAt = this.nextBar(this.pos);
      } else {
        this.startRecording(t);
      }
    }
  }

  /** The first bar line at or after block `p` (bars are whole parts of the loop). */
  nextBar(p) {
    const bars = Math.max(1, Math.round(this.loopBeats / 4));
    for (let k = 0; k < bars; k++) {
      const b = Math.round(k * this.loopLen / bars);
      if (b >= p) return b;
    }
    return 0; // past the last line: the loop's start
  }

  load(s) {
    this.stopClicks();
    this.tracks.forEach((t, i) => {
      const d = s.tracks[i];
      t.recording = false;
      t.mode = d ? d.mode : t.mode;
      t.muted = d ? d.muted : false;
      t.hasContent = !!(d && d.frames);
      if (t.hasContent) t.raw.set(d.frames.subarray(0, Math.min(d.frames.length, t.raw.length)));
    });
    this.loopLen = Math.min(s.loopLen, this.maxBlocks);
    this.loopBeats = s.loopBeats;
    this.bpm = s.bpm;
    this.pos = 0;
    this.tracks.forEach((t, i) => this.applyGrid(i));
  }

  clear(i) {
    const t = this.tracks[i];
    if (this.countingIn === i || this.armed === i) this.stopClicks();
    t.recording = false;
    t.hasContent = false;
    if (!this.tracks.some((o) => o.hasContent || o.recording)) {
      this.stopClicks(); // no loop, no bar line to wait for
      this.loopLen = 0;
      this.loopBeats = 0;
      this.pos = 0;
    }
    this.applyGrid(i);
  }

  startRecording(t) {
    this.recCount = 0;
    t.recording = true;
  }

  stopRecording(t) {
    t.recording = false;
    if (this.loopLen === 0) {
      const bar = this.barBlocks;
      this.stopClicks();
      // the last `comp` blocks were never written (the take is shifted back by them): silence
      t.raw.fill(0, Math.max(0, this.recCount - this.comp) * Frame.SIZE, this.recCount * Frame.SIZE);
      // the first take sets the loop; a too-short one is a mis-tap, drop it
      if (this.recCount < this.blocksPerSecond * MIN_LOOP_SECONDS) return;
      if (bar > 0) {
        const bars = Math.min(Math.max(Math.round(this.recCount / bar), 1), Math.trunc(this.maxBlocks / bar));
        // rounded up → the tail was never played: silence, not leftovers of an old take
        if (bars * bar > this.recCount) t.raw.fill(0, this.recCount * Frame.SIZE, bars * bar * Frame.SIZE);
        this.loopLen = bars * bar;
        this.loopBeats = bars * 4;
      } else {
        // free take: fit whole bars near the chosen tempo, so the metronome can still click over it
        this.loopLen = this.recCount;
        this.loopBeats = 4 * Math.max(Math.round(this.recCount / (4 * 60 / this.bpm * this.blocksPerSecond)), 1);
      }
      this.bpm = Math.round(this.loopBeats * 60 * this.blocksPerSecond / this.loopLen);
      this.pos = 0;
    }
    t.hasContent = true;
    this.applyGrid(this.tracks.indexOf(t));
  }

  /** Cancels any wait for a take: the count-in, or a take armed for the next bar line. */
  stopClicks() {
    this.countingIn = -1;
    this.barBlocks = 0;
    this.armed = -1;
  }

  /** Rebuilds what track `i` plays from its raw take (grid or plain copy), then tells the page. */
  applyGrid(i) {
    const t = this.tracks[i];
    const len = this.loopLen;
    if (t.hasContent && len > 0) {
      const step = len / (this.loopBeats * DIVISION);
      if (!this.grid || !(step >= 1) || !Number.isFinite(step)) t.frames.set(t.raw.subarray(0, len * Frame.SIZE));
      else if (MODES[t.mode].drums) quantizeHits(t.raw, t.frames, len, step);
      else quantizeNotes(t.raw, t.frames, len, step);
    }
    this.sendFrames(i);
  }

  /** Copies track `i`'s loop to the page (null when it is empty): `frames` as played, `raw` for saving. */
  sendFrames(i) {
    const t = this.tracks[i];
    const has = t.hasContent && this.loopLen > 0;
    const frames = has ? t.frames.slice(0, this.loopLen * Frame.SIZE) : null;
    const raw = has ? t.raw.slice(0, this.loopLen * Frame.SIZE) : null;
    this.post({ t: 'frames', i, frames, raw }, has ? [frames.buffer, raw.buffer] : []);
  }

  levelOf(f, o) {
    return f[o + Frame.GATE] > 0.5 ? 0.2 + 0.8 * f[o + Frame.TENSION] : 0;
  }

  /** One block of BLOCK samples into `mix`. */
  renderBlock() {
    const { live, tracks, toneL, toneR, drumL, drumR } = this;
    if (this.countingIn >= 0 && this.clickBlocks === this.barBlocks) {
      this.startRecording(tracks[this.countingIn]);
      this.countingIn = -1;
    }
    if (this.armed >= 0 && this.pos === this.armedAt) {
      this.startRecording(tracks[this.armed]);
      this.recStart = this.pos;
      this.armed = -1;
    }

    live[Frame.TENSION] = this.tension;
    live[Frame.BEND] = this.bend;
    live[Frame.GATE] = this.gate ? 1 : 0;
    live[Frame.TILT_X] = Math.min(Math.max(this.tiltX + this.aim, -1), 1);
    live[Frame.TILT_Y] = this.tiltY;
    live[Frame.SHAKE] = this.shake;
    live.set(this.shape, Frame.COUNT);
    live[Frame.EVENT] = Frame.EV_NONE;
    const hit = this.hits.shift();
    if (hit) {
      live[Frame.EVENT] = Frame.EV_HIT;
      live[Frame.EV_A] = hit[0];
      live[Frame.EV_B] = hit[1];
      live[Frame.EV_X] = hit[2];
      live[Frame.EV_Y] = hit[3];
    }

    toneL.fill(0); toneR.fill(0); drumL.fill(0); drumR.fill(0);
    const tempo = this.bpm;
    let kicked = this.liveVoice.render(toneL, toneR, drumL, drumR, BLOCK, live, 0, tracks[this.selected].mode, tempo);

    // the take is shifted back by `comp` blocks; on the first take the earliest ones fall before its start
    const writeBlock = this.loopLen === 0 ? this.recCount - this.comp
      : (this.pos - (this.comp % this.loopLen) + this.loopLen) % this.loopLen;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.recording) {
        if (writeBlock >= 0) t.raw.set(live, writeBlock * Frame.SIZE);
        t.level = this.levelOf(live, 0);
      } else if (t.hasContent && this.loopLen > 0) {
        const o = this.pos * Frame.SIZE;
        t.level = t.muted ? 0 : this.levelOf(t.frames, o);
        if (!t.muted && this.voices[i].render(toneL, toneR, drumL, drumR, BLOCK, t.frames, o, t.mode, tempo)) kicked = true;
      } else {
        t.level = 0;
      }
    }

    if (this.barBlocks > 0) this.click.tick(this.clickBlocks++ * BLOCK, this.barBlocks * BLOCK / 4);
    else if (this.metronome && this.loopLen > 0) this.click.tick(this.pos * BLOCK, this.loopLen * BLOCK / this.loopBeats);
    this.master.render(toneL, toneR, drumL, drumR, BLOCK, kicked, this.mix);
    this.click.render(this.mix);

    if (this.loopLen > 0) this.pos = (this.pos + 1) % this.loopLen;
    const rec = tracks.find((t) => t.recording);
    if (rec) {
      this.recCount++;
      const limit = this.loopLen === 0 ? this.maxBlocks : this.loopLen;
      if (this.recCount >= limit) this.stopRecording(rec);
    }
    if (++this.blockCount % STATE_EVERY === 0) this.sendState();
  }

  sendState() {
    this.post({
      t: 'state',
      selected: this.selected, loopLen: this.loopLen, pos: this.pos, recCount: this.recCount,
      metronome: this.metronome, bpm: this.bpm, loopBeats: this.loopBeats, barBlocks: this.barBlocks,
      clickBlocks: this.clickBlocks, countingIn: this.countingIn,
      armed: this.armed, armedAt: this.armedAt, recStart: this.recStart, cpu: this.cpu, peakMs: this.peakMs,
      tracks: this.tracks.map((t) => ({ mode: t.mode, muted: t.muted, hasContent: t.hasContent, recording: t.recording, level: t.level })),
    });
  }

  /** Fills `outL`/`outR` (any length) from whole blocks. */
  render(outL, outR) {
    const n = outL.length;
    // Date.now() is the only clock in an AudioWorklet; at 1 ms it reads 0 or 1 per call, which
    // averages out over a second of calls into the busy time
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      if (this.mixPos === BLOCK) {
        this.renderBlock();
        this.mixPos = 0;
      }
      outL[i] = this.mix[2 * this.mixPos];
      if (outR) outR[i] = this.mix[2 * this.mixPos + 1];
      this.mixPos++;
    }
    const took = Date.now() - t0;
    this.busyMs += took;
    if (took > this.peak) this.peak = took;
    this.measured += n;
    if (this.measured >= this.sr) {
      this.cpu = this.busyMs / (this.measured / this.sr * 1000);
      this.peakMs = this.peak;
      this.peak = 0;
      this.busyMs = 0;
      this.measured = 0;
    }
  }
}

// Node (the looper test) loads this file without the AudioWorklet globals.
if (typeof registerProcessor === 'function') {
  registerProcessor('rezina', class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.engine = new Engine(sampleRate, (m, transfer) => this.port.postMessage(m, transfer));
      this.port.onmessage = (e) => this.engine.command(e.data);
      this.engine.sendState();
    }
    process(inputs, outputs) {
      const out = outputs[0];
      this.engine.render(out[0], out[1]);
      return true;
    }
  });
}
