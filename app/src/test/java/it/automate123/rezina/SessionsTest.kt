package it.automate123.rezina

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.DataOutputStream
import java.io.File
import java.util.zip.GZIPOutputStream

/** .rez files: v2 (with the sample rate) round trip, and v1 files from older versions still open. */
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
}
