// .rez files: a round trip, and the bytes checked field by field with Node's own gunzip (Android's layout).
import { gunzipSync } from 'node:zlib';
import { encode, decode } from '../sessions.js';
import { Frame } from '../synth.js';

let failed = false;
const expect = (label, ok) => { if (!ok) failed = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); };

const frames = Float32Array.from({ length: 3 * Frame.SIZE }, (_, i) => i / 7);
const s = { loopLen: 3, loopBeats: 4, bpm: 105, tracks: [{ mode: 5, muted: true, frames }, { mode: 2, muted: false, frames: null }] };
const bytes = await encode(s);
const gz = gunzipSync(bytes);
const raw = new DataView(gz.buffer, gz.byteOffset, gz.byteLength);
expect('magic REZ1', raw.getInt32(0) === 0x52455a31);
expect('header: version, frame size, len, beats, bpm, tracks', [1, Frame.SIZE, 3, 4, 105, 2].every((v, k) => raw.getInt32(4 + 4 * k) === v));
expect('track 1: mode, muted, has frames', raw.getInt8(28) === 5 && raw.getInt8(29) === 1 && raw.getInt8(30) === 1);
expect('frames big-endian', raw.getFloat32(31 + 4 * 10) === Math.fround(10 / 7));
expect('total size', raw.byteLength === 28 + 3 + 3 * Frame.SIZE * 4 + 3);
const back = await decode(bytes);
expect('round trip', back.bpm === 105 && back.tracks[0].muted && back.tracks[1].frames === null &&
  back.tracks[0].frames.every((v, i) => v === Math.fround(i / 7)));
let threw = false;
try { await decode(await encode({ ...s, tracks: [{ mode: 99, muted: false, frames: null }] })); } catch { threw = true; }
expect('unknown sound refused', threw);
// an old Safari (no CompressionStream) stores plain bytes; decode reads them too
const CS = globalThis.CompressionStream;
delete globalThis.CompressionStream;
const plain = await encode(s);
globalThis.CompressionStream = CS;
expect('plain bytes without CompressionStream', plain[0] === 0x52 && (await decode(plain)).bpm === 105);
process.exit(failed ? 1 : 0);
