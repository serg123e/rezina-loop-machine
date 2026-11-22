package it.automate123.rezina

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/**
 * One saved looper: the loop's grid plus, per track, its sound and one loop of gesture frames.
 * [sampleRate] is the rate the frames were recorded at (one frame per 192-sample block); 0 = unknown (a v1 file).
 */
class Session(val sampleRate: Int, val loopLen: Int, val loopBeats: Int, val bpm: Int, val tracks: List<TrackData>) {
    /** [frames] is null for an empty track, else exactly loopLen × [Frame.SIZE] floats. */
    class TrackData(val mode: Mode, val muted: Boolean, val frames: FloatArray?)

    /**
     * The same loop, as long in seconds, at [rate]: one frame per block of that rate. Each new block takes
     * the nearest old one; every drum hit is kept once, at its nearest block. Unknown rate (0) or the
     * same rate: unchanged.
     */
    fun atRate(rate: Int): Session {
        if (sampleRate <= 0 || sampleRate == rate) return this
        val ratio = rate.toDouble() / sampleRate
        val len = maxOf(1, Math.round(loopLen * ratio).toInt())
        val s = Frame.SIZE
        return Session(rate, len, loopBeats, bpm, tracks.map { t ->
            val f = t.frames ?: return@map t
            val out = FloatArray(len * s)
            for (b in 0 until len) {
                val src = minOf(((b + 0.5) / ratio).toInt(), loopLen - 1)
                f.copyInto(out, b * s, src * s, src * s + s)
                out[b * s + Frame.EVENT] = Frame.EV_NONE
            }
            val taken = BooleanArray(len)
            for (b in 0 until loopLen) {
                if (f[b * s + Frame.EVENT] != Frame.EV_HIT) continue
                var q = minOf(Math.round(b * ratio).toInt(), len - 1)
                var k = 0
                while (taken[q] && k < len) { q = (q + 1) % len; k++ }
                taken[q] = true
                f.copyInto(out, q * s + Frame.EVENT, b * s + Frame.EVENT, b * s + Frame.EV_Y + 1)
            }
            TrackData(t.mode, t.muted, out)
        })
    }
}

/**
 * Sessions live as gzip'd files in app-private storage (`files/sessions/<date>.rez`), newest first.
 *
 * An imported file keeps its name: `<date> <name>.rez`, listed by that name.
 *
 * Format v2: magic, version, Frame.SIZE, sample rate, loopLen, loopBeats, bpm, track count (int32 each);
 * then per track mode ordinal, muted, hasContent and, if present, loopLen × Frame.SIZE big-endian floats.
 * v1 is the same without the sample rate; it is still read (rate 0 = unknown).
 * Frames are per audio block, so they are tied to the rate they were recorded at; [Session.atRate]
 * converts a file from another phone on load (v1 files, rate unknown, play as they are).
 */
object Sessions {
    private const val MAGIC = 0x52455a31 // "REZ1"
    private const val VERSION = 2
    /** More blocks than a minute at 192 kHz: a header saying more is broken. */
    private const val MAX_LEN = 60 * 1000
    private val fileName = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.ROOT)
    private val title = SimpleDateFormat("dd.MM HH:mm", Locale.ROOT)

    /** A saved file and a one-line summary read from its header. */
    class Entry(val file: File, val title: String, val summary: String)

    fun list(dir: File): List<Entry> =
        dir.listFiles { f -> f.name.endsWith(".rez") }.orEmpty()
            .sortedByDescending { it.name }
            .mapNotNull { f ->
                try {
                    val s = load(f)
                    val bars = s.loopBeats / 4
                    val used = s.tracks.filter { it.frames != null }.joinToString(", ") { it.mode.title }
                    val name = f.nameWithoutExtension.substringAfter(' ', "")
                    Entry(f, name.ifEmpty { title.format(Date(f.lastModified())) }, "$bars ${barsWord(bars)} · ♩ ${s.bpm} · $used")
                } catch (e: IOException) {
                    null // unreadable or from another version — not worth a crash
                }
            }

    /** Writes [s] as a new file; [label] (an imported file's name) is listed instead of the date. */
    fun save(dir: File, s: Session, label: String? = null): File {
        dir.mkdirs()
        val clean = label?.replace(Regex("[/\\\\:*?\"<>|\\s]+"), " ")?.trim().orEmpty()
        val f = File(dir, fileName.format(Date()) + (if (clean.isEmpty()) "" else " $clean") + ".rez")
        DataOutputStream(GZIPOutputStream(f.outputStream().buffered())).use { out ->
            out.writeInt(MAGIC)
            out.writeInt(VERSION)
            out.writeInt(Frame.SIZE)
            out.writeInt(s.sampleRate)
            out.writeInt(s.loopLen)
            out.writeInt(s.loopBeats)
            out.writeInt(s.bpm)
            out.writeInt(s.tracks.size)
            for (t in s.tracks) {
                out.writeByte(t.mode.ordinal)
                out.writeBoolean(t.muted)
                out.writeBoolean(t.frames != null)
                t.frames?.let { frames ->
                    val bytes = ByteBuffer.allocate(frames.size * 4)
                    bytes.asFloatBuffer().put(frames)
                    out.write(bytes.array())
                }
            }
        }
        return f
    }

    fun load(f: File): Session = read(f.inputStream())

    /** Reads a .rez from [stream] (and closes it); throws IOException on anything that is not a v1/v2 session. */
    fun read(stream: InputStream): Session {
        val buffered = stream.buffered()
        // the web version on an old Safari writes the bytes without gzip
        buffered.mark(2)
        val gzip = buffered.read() == 0x1f && buffered.read() == 0x8b
        buffered.reset()
        return DataInputStream(if (gzip) GZIPInputStream(buffered) else buffered).use { inp ->
            if (inp.readInt() != MAGIC) throw IOException("not a rezina session")
            val version = inp.readInt()
            if (version !in 1..VERSION || inp.readInt() != Frame.SIZE) throw IOException("unsupported rezina session v$version")
            val sampleRate = if (version >= 2) inp.readInt() else 0
            val loopLen = inp.readInt()
            val loopBeats = inp.readInt()
            val bpm = inp.readInt()
            val count = inp.readInt()
            // a file from outside can be broken: no app writes these
            if (loopLen <= 0 || loopLen > MAX_LEN || loopBeats <= 0 || bpm <= 0 || count !in 0..16) throw IOException("broken rezina session")
            val tracks = List(count) {
                val mode = Mode.entries.getOrNull(inp.readByte().toInt()) ?: throw IOException("unknown sound")
                val muted = inp.readBoolean()
                val frames = if (inp.readBoolean()) {
                    val bytes = ByteArray(loopLen * Frame.SIZE * 4)
                    inp.readFully(bytes)
                    FloatArray(loopLen * Frame.SIZE).also { ByteBuffer.wrap(bytes).asFloatBuffer().get(it) }
                } else {
                    null
                }
                Session.TrackData(mode, muted, frames)
            }
            Session(sampleRate, loopLen, loopBeats, bpm, tracks)
        }
    }

    private fun barsWord(n: Int) = if (n == 1) "bar" else "bars"
}
