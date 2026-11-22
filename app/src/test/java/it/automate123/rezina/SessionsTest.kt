package it.automate123.rezina

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.util.zip.GZIPOutputStream

/** .rez files: v2 round trip, v1 files still open, rate conversion, imported names, broken and plain files. */
class SessionsTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun v2KeepsTheSampleRate() {
        val frames = FloatArray(3 * Frame.SIZE) { it / 7f }
        val s = Session(44100, 3, 4, 105, listOf(
            Session.TrackData(Mode.HARD_DRUMS, true, frames),
            Session.TrackData(Mode.LEAD, false, null),
        ))
        val back = Sessions.load(Sessions.save(tmp.root, s))
        assertEquals(44100, back.sampleRate)
        assertEquals(105, back.bpm)
        assertEquals(Mode.HARD_DRUMS, back.tracks[0].mode)
        assertArrayEquals(frames, back.tracks[0].frames, 0f)
        assertNull(back.tracks[1].frames)
    }

    @Test
    fun v1OpensWithAnUnknownRate() {
        val f = File(tmp.root, "old.rez")
        DataOutputStream(GZIPOutputStream(f.outputStream())).use { out ->
            for (v in intArrayOf(0x52455a31, 1, Frame.SIZE, 2, 4, 100, 1)) out.writeInt(v)
            out.writeByte(Mode.DRUMS.ordinal)
            out.writeBoolean(false)
            out.writeBoolean(true)
            repeat(2 * Frame.SIZE) { out.writeFloat(0.5f) }
        }
        val s = Sessions.load(f)
        assertEquals(0, s.sampleRate)
        assertEquals(2, s.loopLen)
        assertEquals(0.5f, s.tracks[0].frames!![Frame.SIZE + 1], 0f)
    }

    @Test
    fun aFileFromA44kPhoneKeepsItsLengthInSeconds() {
        val f = FloatArray(441 * Frame.SIZE)
        for (b in 0 until 441) f[b * Frame.SIZE + Frame.TENSION] = b / 441f
        f[100 * Frame.SIZE + Frame.EVENT] = Frame.EV_HIT
        f[100 * Frame.SIZE + Frame.EV_A] = 0.9f
        val s = Session(44100, 441, 4, 100, listOf(Session.TrackData(Mode.DRUMS, false, f))).atRate(48000)
        assertEquals(48000, s.sampleRate)
        assertEquals(480, s.loopLen)
        val out = s.tracks[0].frames!!
        val hits = (0 until 480).filter { out[it * Frame.SIZE + Frame.EVENT] == Frame.EV_HIT }
        assertEquals(listOf(109), hits) // 100 × 48/44.1 = 108.8
        assertEquals(0.9f, out[109 * Frame.SIZE + Frame.EV_A], 0f)
        assertEquals(240 / 480f, out[240 * Frame.SIZE + Frame.TENSION], 0.01f) // halfway is still halfway
        val same = Session(0, 2, 4, 100, emptyList())
        assertSame(same, same.atRate(48000)) // a v1 file: rate unknown, left as it is
    }

    @Test
    fun anImportedFileIsListedByItsName() {
        val s = Session(48000, 2, 4, 100, listOf(Session.TrackData(Mode.LEAD, false, FloatArray(2 * Frame.SIZE))))
        Sessions.save(tmp.root, s, "vse vmeste")
        assertEquals(listOf("vse vmeste"), Sessions.list(tmp.root).map { it.title })
    }

    @Test(expected = IOException::class)
    fun aBrokenHeaderIsRefused() {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(GZIPOutputStream(bytes)).use { out ->
            for (v in intArrayOf(0x52455a31, 2, Frame.SIZE, 48000, 2, 0, 100, 1)) out.writeInt(v) // 0 beats
        }
        Sessions.read(ByteArrayInputStream(bytes.toByteArray()))
    }

    @Test
    fun plainBytesFromAnOldSafariOpen() {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out ->
            for (v in intArrayOf(0x52455a31, 2, Frame.SIZE, 48000, 1, 4, 120, 1)) out.writeInt(v)
            out.writeByte(Mode.LEAD.ordinal)
            out.writeBoolean(false)
            out.writeBoolean(false)
        }
        assertEquals(120, Sessions.read(ByteArrayInputStream(bytes.toByteArray())).bpm)
    }
}
