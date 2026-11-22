// .rez files: a round trip, and the bytes checked field by field with Node's own gunzip (Android's layout).
import { gunzipSync } from 'node:zlib';
import { encode, decode } from '../sessions.js';
import { Frame } from '../synth.js';

let failed = false;
const expect = (label, ok) => { if (!ok) failed = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); };

const frames = Float32Array.from({ length: 3 * Frame.SIZE }, (_, i) => i / 7);
const s = { sampleRate: 44100, loopLen: 3, loopBeats: 4, bpm: 105, tracks: [{ mode: 5, muted: true, frames }, { mode: 2, muted: false, frames: null }] };
const bytes = await encode(s);
const gz = gunzipSync(bytes);
const raw = new DataView(gz.buffer, gz.byteOffset, gz.byteLength);
expect('magic REZ1', raw.getInt32(0) === 0x52455a31);
expect('header: version 2, frame size, rate, len, beats, bpm, tracks', [2, Frame.SIZE, 44100, 3, 4, 105, 2].every((v, k) => raw.getInt32(4 + 4 * k) === v));
expect('track 1: mode, muted, has frames', raw.getInt8(32) === 5 && raw.getInt8(33) === 1 && raw.getInt8(34) === 1);
expect('frames big-endian', raw.getFloat32(35 + 4 * 10) === Math.fround(10 / 7));
expect('total size', raw.byteLength === 32 + 3 + 3 * Frame.SIZE * 4 + 3);
const back = await decode(bytes);
expect('round trip', back.sampleRate === 44100 && back.bpm === 105 && back.tracks[0].muted && back.tracks[1].frames === null &&
  back.tracks[0].frames.every((v, i) => v === Math.fround(i / 7)));
// a v1 file (no rate), as older versions of all three apps wrote it
const v1 = new DataView(new ArrayBuffer(28 + 3 + 2 * Frame.SIZE * 4));
[0x52455a31, 1, Frame.SIZE, 2, 4, 100, 1].forEach((v, k) => v1.setInt32(4 * k, v));
v1.setInt8(28, 1); v1.setInt8(29, 0); v1.setInt8(30, 1);
for (let i = 0; i < 2 * Frame.SIZE; i++) v1.setFloat32(31 + 4 * i, 0.5);
const old = await decode(new Uint8Array(v1.buffer));
expect('v1 opens, rate unknown', old.sampleRate === 0 && old.loopLen === 2 && old.tracks[0].frames[Frame.SIZE + 1] === 0.5);
let threw = false;
try { await decode(await encode({ ...s, tracks: [{ mode: 99, muted: false, frames: null }] })); } catch { threw = true; }
expect('unknown sound refused', threw);
threw = false;
try { await decode(await encode({ ...s, loopBeats: 0 })); } catch { threw = true; }
expect('a loop with no beats refused', threw);
// an old Safari (no CompressionStream) stores plain bytes; decode reads them too
const CS = globalThis.CompressionStream;
delete globalThis.CompressionStream;
const plain = await encode(s);
globalThis.CompressionStream = CS;
expect('plain bytes without CompressionStream', plain[0] === 0x52 && (await decode(plain)).bpm === 105);
process.exit(failed ? 1 : 0);
