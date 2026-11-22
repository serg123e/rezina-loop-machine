// The looper rules of Android Engine.kt, run on worklet.js's Engine without a browser.
import { Engine } from '../worklet.js';
import { Frame, BLOCK, Mode } from '../synth.js';

let failed = false;
const expect = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${got}, want ${want}`}`);
};

const posts = [];
const e = new Engine(48000, (m) => posts.push(m));
const L = new Float32Array(128), R = new Float32Array(128);
/** Runs `blocks` blocks of audio. */
const run = (blocks) => { for (let i = 0; i < blocks * BLOCK / 128; i++) e.render(L, R); };
const bar = Math.round(4 * 60 / 100 * e.blocksPerSecond); // 100 bpm: 600 blocks

// first take with the metronome: count-in, then recording from the downbeat
e.command({ t: 'live', tension: 0.5, bend: 0, gate: true, aim: 0.2, shape: new Float32Array(13) });
e.command({ t: 'rec' });
expect('count-in on track 1', e.countingIn, 0);
run(bar + 1); // the downbeat block starts the take
expect('recording after one bar', e.tracks[0].recording, true);
run(Math.round(bar * 1.4)); // 1.4 bars → rounds to 1
e.command({ t: 'rec' });
expect('loop = 1 bar', e.loopLen, bar);
expect('4 beats', e.loopBeats, 4);
expect('track 1 has content', e.tracks[0].hasContent, true);
expect('aim recorded into tilt', Math.abs(e.tracks[0].frames[Frame.TILT_X] - 0.2) < 1e-6, true);
const sent = posts.filter((m) => m.t === 'frames' && m.i === 0).pop();
expect('frames sent to the page', sent.frames.length, bar * Frame.SIZE);

// later take: exactly one loop, stops by itself
e.command({ t: 'select', i: 1 });
e.command({ t: 'mode', i: 1, mode: Mode.HARD_DRUMS.id });
e.command({ t: 'rec' });
expect('second take waits for the bar line', [e.armed, e.tracks[1].recording], [1, false]);
run(1); // the playhead is on the loop's start: the line is right here
expect('…and starts on it', e.tracks[1].recording, true);
e.command({ t: 'hit', tune: 0.1, vel: 1, x: 0.5, y: 0.8 });
run(bar);
expect('second take stopped after one loop', e.tracks[1].recording, false);
expect('hit recorded', Array.from({ length: bar }, (_, b) => e.tracks[1].frames[b * Frame.SIZE + Frame.EVENT]).includes(Frame.EV_HIT), true);
expect('tempo locked after first loop', (e.command({ t: 'bpm', bpm: 140 }), e.bpm), 100);

// erase all → loop resets
e.command({ t: 'clear', i: 0 });
e.command({ t: 'clear', i: 1 });
expect('loop reset', e.loopLen, 0);

// too-short free take is dropped
e.command({ t: 'metronome', on: false });
e.command({ t: 'select', i: 2 });
e.command({ t: 'rec' });
run(50);
e.command({ t: 'rec' });
expect('0.2 s take dropped', e.tracks[2].hasContent, false);

// free take: whole bars near the tempo
e.command({ t: 'rec' });
run(1000);
e.command({ t: 'rec' });
expect('free take keeps its length', e.loopLen, 1000);
expect('fitted to 2 bars', e.loopBeats, 8);
expect('tempo from the take', e.bpm, Math.round(8 * 60 * e.blocksPerSecond / 1000));

// a take over a 2-bar loop, Rec in the middle of bar 1: it waits for bar 2's line (block 500)
run(100);
e.command({ t: 'select', i: 3 });
e.command({ t: 'rec' });
expect('armed for the next bar line', [e.armed, e.armedAt], [3, 500]);
run(399);
expect('still waiting before the line', e.tracks[3].recording, false);
run(1);
expect('recording from the line', [e.tracks[3].recording, e.recStart], [true, 500]);
e.command({ t: 'rec' }); // stop by hand
e.command({ t: 'rec' });
e.command({ t: 'rec' }); // armed, then a second tap cancels
expect('a second tap cancels the wait', e.armed, -1);

// load replaces everything
const frames = new Float32Array(300 * Frame.SIZE);
e.command({ t: 'load', session: { loopLen: 300, loopBeats: 4, bpm: 120, tracks: [{ mode: Mode.FM_BASS.id, muted: true, frames }, { mode: 1, muted: false, frames: null }] } });
expect('loaded length', e.loopLen, 300);
expect('loaded mode', e.tracks[0].mode, Mode.FM_BASS.id);
expect('loaded mute', e.tracks[0].muted, true);
expect('track 3 emptied by load', e.tracks[2].hasContent, false);
let peak = 0;
for (let i = 0; i < 100; i++) { e.render(L, R); for (const x of L) peak = Math.max(peak, Math.abs(x)); }
expect('plays without NaN', Number.isFinite(peak), true);

process.exit(failed ? 1 : 0);
