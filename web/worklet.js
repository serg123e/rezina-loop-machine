// The audio thread and the looper: port of Android Engine.kt, as an AudioWorkletProcessor.
//
// The page (app.js) never touches looper state: it posts messages (the live gesture, hits, commands) to
// `port`, and this processor posts back what the screen shows (`state`, ~60 times a second) and a copy
// of a track's frames whenever they become final (`frames`), for ghosts and saving.
//
// The synth runs in 192-sample blocks, one Frame per block, like Android; the browser asks for 128
// samples at a time, served from whole blocks (mixPos), as on iOS.
import { Voice, Master, Mode, Frame, BLOCK } from './synth.js';

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
      mode, frames: new Float32Array(this.maxBlocks * Frame.SIZE),
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
      case 'mode': this.tracks[m.i].mode = m.mode; break;
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
    else if (this.countingIn >= 0) this.stopClicks(); // second tap during count-in cancels it
    else {
      for (const o of this.tracks) if (o.recording) this.stopRecording(o);
      if (this.loopLen === 0 && this.metronome) {
        this.barBlocks = Math.round(4 * 60 / this.bpm * this.blocksPerSecond);
        this.clickBlocks = 0;
        this.countingIn = i;
      } else {
        this.startRecording(t);
      }
    }
  }

  load(s) {
    this.stopClicks();
    this.tracks.forEach((t, i) => {
      const d = s.tracks[i];
      t.recording = false;
      t.mode = d ? d.mode : t.mode;
      t.muted = d ? d.muted : false;
      t.hasContent = !!(d && d.frames);
      if (t.hasContent) t.frames.set(d.frames.subarray(0, Math.min(d.frames.length, t.frames.length)));
    });
    this.loopLen = Math.min(s.loopLen, this.maxBlocks);
    this.loopBeats = s.loopBeats;
    this.bpm = s.bpm;
    this.pos = 0;
    this.tracks.forEach((t, i) => this.sendFrames(i));
  }

  clear(i) {
    const t = this.tracks[i];
    if (this.countingIn === i) this.stopClicks();
    t.recording = false;
    t.hasContent = false;
    if (!this.tracks.some((o) => o.hasContent || o.recording)) {
      this.loopLen = 0;
      this.loopBeats = 0;
      this.pos = 0;
    }
    this.sendFrames(i);
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
      // the first take sets the loop; a too-short one is a mis-tap, drop it
      if (this.recCount < this.blocksPerSecond * MIN_LOOP_SECONDS) return;
      if (bar > 0) {
        const bars = Math.min(Math.max(Math.round(this.recCount / bar), 1), Math.trunc(this.maxBlocks / bar));
        // rounded up → the tail was never played: silence, not leftovers of an old take
        if (bars * bar > this.recCount) t.frames.fill(0, this.recCount * Frame.SIZE, bars * bar * Frame.SIZE);
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
    this.sendFrames(this.tracks.indexOf(t));
  }

  stopClicks() {
    this.countingIn = -1;
    this.barBlocks = 0;
  }

  /** Copies track `i`'s loop to the page (null when it is empty). */
  sendFrames(i) {
    const t = this.tracks[i];
    const frames = t.hasContent && this.loopLen > 0 ? t.frames.slice(0, this.loopLen * Frame.SIZE) : null;
    this.post({ t: 'frames', i, frames }, frames ? [frames.buffer] : []);
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

    const writeAt = (this.loopLen === 0 ? this.recCount : this.pos) * Frame.SIZE;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.recording) {
        t.frames.set(live, writeAt);
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
      tracks: this.tracks.map((t) => ({ mode: t.mode, muted: t.muted, hasContent: t.hasContent, recording: t.recording, level: t.level })),
    });
  }

  /** Fills `outL`/`outR` (any length) from whole blocks. */
  render(outL, outR) {
    const n = outL.length;
    for (let i = 0; i < n; i++) {
      if (this.mixPos === BLOCK) {
        this.renderBlock();
        this.mixPos = 0;
      }
      outL[i] = this.mix[2 * this.mixPos];
      if (outR) outR[i] = this.mix[2 * this.mixPos + 1];
      this.mixPos++;
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
