package it.automate123.rezina

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
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
}

/**
 * Sessions live as gzip'd files in app-private storage (`files/sessions/<date>.rez`), newest first.
 *
 * Format v2: magic, version, Frame.SIZE, sample rate, loopLen, loopBeats, bpm, track count (int32 each);
 * then per track mode ordinal, muted, hasContent and, if present, loopLen × Frame.SIZE big-endian floats.
 * v1 is the same without the sample rate; it is still read (rate 0 = unknown).
 * Frames are per audio block, so a file plays at the speed of the device's sample rate. Loading does not
 * convert yet (see PORTING.md): a file from a 44.1 kHz phone plays ~9 % faster on a 48 kHz one.
 */
object Sessions {
    private const val MAGIC = 0x52455a31 // "REZ1"
    private const val VERSION = 2
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
                    Entry(f, title.format(Date(f.lastModified())), "$bars ${barsWord(bars)} · ♩ ${s.bpm} · $used")
                } catch (e: IOException) {
                    null // unreadable or from another version — not worth a crash
                }
            }

    fun save(dir: File, s: Session): File {
        dir.mkdirs()
        val f = File(dir, fileName.format(Date()) + ".rez")
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

    fun load(f: File): Session =
        DataInputStream(GZIPInputStream(f.inputStream().buffered())).use { inp ->
            if (inp.readInt() != MAGIC) throw IOException("not a rezina session: $f")
            val version = inp.readInt()
            if (version !in 1..VERSION || inp.readInt() != Frame.SIZE) throw IOException("unsupported rezina session v$version: $f")
            val sampleRate = if (version >= 2) inp.readInt() else 0
            val loopLen = inp.readInt()
            val loopBeats = inp.readInt()
            val bpm = inp.readInt()
            val tracks = List(inp.readInt()) {
                val mode = Mode.entries[inp.readByte().toInt()]
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

    private fun barsWord(n: Int) = if (n == 1) "bar" else "bars"
}
