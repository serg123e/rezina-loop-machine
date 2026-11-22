// Saving and loading sessions: port of Android Sessions.kt. The bytes are the Android .rez format
// (gzip, big-endian), kept in the browser's IndexedDB instead of files.
//
// Format v1: magic, version, Frame.SIZE, loopLen, loopBeats, bpm, track count (int32 each); then per track
// mode ordinal (byte), muted, hasContent (bool bytes) and, if present, loopLen × Frame.SIZE float32.
import { Frame, MODES } from './synth.js';

const MAGIC = 0x52455a31; // "REZ1"
const VERSION = 1;

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** session → gzip'd .rez bytes */
export async function encode(s) {
  let size = 7 * 4;
  for (const t of s.tracks) size += 3 + (t.frames ? s.loopLen * Frame.SIZE * 4 : 0);
  const d = new DataView(new ArrayBuffer(size));
  let o = 0;
  for (const v of [MAGIC, VERSION, Frame.SIZE, s.loopLen, s.loopBeats, s.bpm, s.tracks.length]) { d.setInt32(o, v); o += 4; }
  for (const t of s.tracks) {
    d.setInt8(o++, t.mode);
    d.setInt8(o++, t.muted ? 1 : 0);
    d.setInt8(o++, t.frames ? 1 : 0);
    if (t.frames) for (let i = 0; i < s.loopLen * Frame.SIZE; i++, o += 4) d.setFloat32(o, t.frames[i]);
  }
  // Safari before 16.4 has no CompressionStream: keep the bytes plain there (decode takes both)
  if (typeof CompressionStream === 'undefined') return new Uint8Array(d.buffer);
  return pipe(d.buffer, new CompressionStream('gzip'));
}

/** .rez bytes (gzip'd, or plain from an old Safari) → session; throws on anything that is not a v1 session. */
export async function decode(bytes) {
  const b = new Uint8Array(bytes);
  const raw = b[0] === 0x1f && b[1] === 0x8b ? await pipe(b, new DecompressionStream('gzip')) : b;
  const d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let o = 0;
  const int = () => { const v = d.getInt32(o); o += 4; return v; };
  if (int() !== MAGIC || int() !== VERSION || int() !== Frame.SIZE) throw new Error('not a rezina v1 session');
  const loopLen = int(), loopBeats = int(), bpm = int(), count = int();
  const tracks = [];
  for (let k = 0; k < count; k++) {
    const mode = d.getInt8(o++);
    const muted = d.getInt8(o++) !== 0;
    const has = d.getInt8(o++) !== 0;
    if (!MODES[mode]) throw new Error(`unknown sound ${mode}`);
    let frames = null;
    if (has) {
      frames = new Float32Array(loopLen * Frame.SIZE);
      for (let i = 0; i < frames.length; i++, o += 4) frames[i] = d.getFloat32(o);
    }
    tracks.push({ mode, muted, frames });
  }
  return { loopLen, loopBeats, bpm, tracks };
}

// ---- storage: one IndexedDB store, key = file name as on Android (yyyy-MM-dd_HH-mm-ss) ----

let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('rezina', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('sessions', { keyPath: 'name' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function store(mode, fn) {
  const tx = (await db()).transaction('sessions', mode);
  const r = fn(tx.objectStore('sessions'));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  });
}

const two = (n) => String(n).padStart(2, '0');

/** Saves `s`; returns its name. */
export async function save(s) {
  const now = new Date();
  const name = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_` +
    `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
  const data = await encode(s);
  await store('readwrite', (st) => st.put({ name, time: now.getTime(), data }));
  return name;
}

/** Saved sessions, newest first: { name, title, summary, session }. Unreadable ones are skipped. */
export async function list() {
  const all = await store('readonly', (st) => st.getAll());
  all.sort((a, b) => (a.name < b.name ? 1 : -1));
  const out = [];
  for (const rec of all) {
    try {
      const s = await decode(rec.data);
      const bars = Math.trunc(s.loopBeats / 4);
      const used = s.tracks.filter((t) => t.frames).map((t) => MODES[t.mode].title).join(', ');
      const t = new Date(rec.time);
      out.push({
        name: rec.name,
        title: `${two(t.getDate())}.${two(t.getMonth() + 1)} ${two(t.getHours())}:${two(t.getMinutes())}`,
        summary: `${bars} ${bars === 1 ? 'bar' : 'bars'} · ♩ ${s.bpm} · ${used}`,
        session: s,
      });
    } catch {
      // unreadable or from another version: not worth a crash
    }
  }
  return out;
}

export async function remove(name) {
  await store('readwrite', (st) => st.delete(name));
}
