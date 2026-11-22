package it.automate123.rezina

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The grid ([Quantize]), with the same cases and numbers as web/test/quantize.mjs. */
class QuantizeTest {
    private val s = Frame.SIZE
    private val len = 600 // one bar at 100 bpm; a sixteenth is 37.5 blocks
    private val step = 37.5

    private fun hitsAt(f: FloatArray) = (0 until len).filter { f[it * s + Frame.EVENT] == Frame.EV_HIT }
    private fun notesIn(f: FloatArray): List<List<Int>> {
        val n = ArrayList<List<Int>>()
        for (b in 0 until len) {
            val on = f[b * s + Frame.GATE] > 0.5f
            val prev = f[((b - 1 + len) % len) * s + Frame.GATE] > 0.5f
            if (on && !prev) { var e = b; while (e < len && f[e * s + Frame.GATE] > 0.5f) e++; n.add(listOf(b, e)) }
        }
        return n
    }

    @Test
    fun hitsArePulledTowardSixteenths() {
        val raw = FloatArray(len * s)
        val out = FloatArray(len * s)
        for ((b, tune) in listOf(40 to 0.1f, 70 to 0.5f, 148 to 0.9f, 151 to 0.9f, 599 to 0.1f)) {
            raw[b * s + Frame.EVENT] = Frame.EV_HIT
            raw[b * s + Frame.EV_A] = tune
        }
        Quantize.hits(raw, out, len, step)
        assertEquals(listOf(0, 38, 74, 149, 150), hitsAt(out))
        assertEquals(0.5f, out[74 * s + Frame.EV_A], 0f)
        assertEquals(listOf(40, 70, 148, 151, 599), hitsAt(raw))
    }

    @Test
    fun noteStartsMoveLengthsStay() {
        val raw = FloatArray(len * s)
        val out = FloatArray(len * s)
        fun note(a: Int, e: Int) { for (b in a until e) { raw[b * s + Frame.GATE] = 1f; raw[b * s + Frame.TENSION] = (b - a) / 100f } }
        note(80, 140); note(142, 180); note(300, 330)
        Quantize.notes(raw, out, len, step)
        assertEquals(listOf(listOf(77, 137), listOf(148, 186), listOf(300, 330)), notesIn(out))
        assertEquals(0.1f, out[(77 + 10) * s + Frame.TENSION], 0f)
        assertTrue(out[137 * s + Frame.GATE] == 0f && out[139 * s + Frame.GATE] == 0f)
    }

    @Test
    fun legatoNotesNeverTouch() {
        val raw = FloatArray(len * s)
        val out = FloatArray(len * s)
        for (b in (20 until 77) + (78 until 120)) raw[b * s + Frame.GATE] = 1f
        Quantize.notes(raw, out, len, step)
        val n = notesIn(out)
        assertTrue(n.size == 2 && n[1][0] > n[0][1])
        assertEquals(listOf(57, 42), n.map { it[1] - it[0] })
    }

    @Test
    fun aNoteAcrossTheLoopEndMoves() {
        val raw = FloatArray(len * s)
        val out = FloatArray(len * s)
        for (b in listOf(595, 596, 597, 598, 599, 0, 1, 2)) raw[b * s + Frame.GATE] = 1f
        Quantize.notes(raw, out, len, step)
        assertEquals(listOf(0, 1, 2, 3, 4, 5, 6, 599), (0 until len).filter { out[it * s + Frame.GATE] > 0.5f })
    }
}
