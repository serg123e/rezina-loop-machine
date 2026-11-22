package it.automate123.rezina

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The looper rules on [Engine.renderBlock], without an AudioTrack: the same cases as web/test/looper.mjs. */
class EngineTest {
    private val e = Engine(burst = 192, sampleRate = 48000)
    private val bar = Math.round(4 * 60f / 100 * e.blocksPerSecond) // 100 bpm: 600 blocks
    private fun run(blocks: Int) = repeat(blocks) { e.renderBlock() }
    private fun hitsIn(f: FloatArray, len: Int) = (0 until len).filter { f[it * Frame.SIZE + Frame.EVENT] == Frame.EV_HIT }

    private fun firstTake() {
        e.gate = true
        e.tension = 0.5f
        e.toggleRecord()
        run(1)
        assertEquals(0, e.countingIn)
        run(bar)
        assertTrue(e.tracks[0].recording)
        run(Math.round(bar * 1.4f))
        e.toggleRecord()
        run(1)
        assertEquals(bar, e.loopLen)
    }

    @Test
    fun laterTakesWaitForTheBarLine() {
        e.setGrid(false)
        firstTake()
        e.selected = 1
        e.setMode(1, Mode.HARD_DRUMS)
        run(100 - 1) // the playhead in the middle of the one-bar loop
        e.toggleRecord()
        run(1)
        assertEquals(1, e.armed)
        assertEquals(0, e.armedAt)
        run(bar - e.pos) // the playhead is back on the line: the take starts with the next block
        assertFalse(e.tracks[1].recording)
        run(1)
        assertTrue(e.tracks[1].recording)
        assertEquals(0, e.recStart)
        e.toggleRecord() // stop by hand
        e.toggleRecord() // armed again
        e.toggleRecord() // a second tap cancels
        run(1)
        assertEquals(-1, e.armed)
    }

    @Test
    fun erasingTheLoopEndsTheWait() {
        firstTake()
        e.selected = 2
        e.toggleRecord()
        run(1)
        assertEquals(2, e.armed)
        e.clear(0)
        run(1)
        assertEquals(0, e.loopLen)
        assertEquals(-1, e.armed)
    }

    @Test
    fun takesAreShiftedBackByTheLatencyAndPutOnTheGrid() {
        e.setGrid(false)
        e.metronome = false
        e.comp = 10
        e.gate = true
        e.toggleRecord()
        run(500) // the command is taken at the start of the next block
        e.toggleRecord()
        run(1)
        assertEquals(500, e.loopLen)
        assertEquals(0f, e.tracks[0].raw[495 * Frame.SIZE + Frame.GATE], 0f) // the last comp blocks: silence
        assertEquals(1f, e.tracks[0].raw[489 * Frame.SIZE + Frame.GATE], 0f)
        e.gate = false
        e.selected = 1
        e.setMode(1, Mode.DRUMS)
        e.toggleRecord() // waits for the line at block 0
        run(500 - e.pos + 1)
        assertTrue(e.tracks[1].recording)
        run(149)
        e.hit(0.1f, 1f, 0f, 0f) // played at block 150 of the take
        run(500)
        assertEquals(listOf(140), hitsIn(e.tracks[1].raw, 500))
        e.setGrid(true)
        run(1)
        val q = hitsIn(e.tracks[1].frames, 500)
        assertEquals(1, q.size)
        assertTrue(q[0] != 140)
        assertEquals(listOf(140), hitsIn(e.tracks[1].raw, 500))
    }

    @Test
    fun saveWritesTheRawTake() {
        e.metronome = false
        e.comp = 0
        e.selected = 1
        e.setMode(1, Mode.DRUMS)
        e.toggleRecord()
        run(40)
        e.hit(0.1f, 1f, 0f, 0f) // block 40: the grid moves it, the file keeps it
        run(560)
        e.toggleRecord()
        run(1)
        val s = e.snapshot()!!
        assertEquals(listOf(40), hitsIn(s.tracks[1].frames!!, s.loopLen))
        assertTrue(hitsIn(e.tracks[1].frames, e.loopLen) != listOf(40))
    }
}
