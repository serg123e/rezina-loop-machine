package it.automate123.rezina

/**
 * Grid: pulls drum hits and note starts toward the loop's sixteenths. Works on a copy: a track keeps its
 * raw frames (what was played) and plays `out`, so the grid can be switched off without loss.
 * Port of web/quantize.js; the Engine applies it after every take, on load, on a sound change and when
 * the grid is switched.
 */
object Quantize {
    /** How far toward the grid line: 1 = exactly on it. 0.7 keeps a little of the player's feel. */
    const val STRENGTH = 0.7
    /** Sixteenths. */
    const val DIVISION = 4

    /** Block [p] moved STRENGTH of the way to the nearest line of a grid of [step] blocks (may be ≥ len). */
    private fun toward(p: Int, step: Double): Int {
        // Math.round as in JavaScript: halves go up
        val line = Math.floor(p / step + 0.5) * step
        return Math.floor(p + STRENGTH * (line - p) + 0.5).toInt()
    }

    /**
     * Drums: every hit moves to its block on the grid (the hit's own bend goes with it). Two hits that land
     * on one block keep their order: the later one takes the next free block.
     */
    fun hits(raw: FloatArray, out: FloatArray, len: Int, step: Double) {
        val s = Frame.SIZE
        raw.copyInto(out, endIndex = len * s)
        for (b in 0 until len) out[b * s + Frame.EVENT] = Frame.EV_NONE
        val taken = BooleanArray(len)
        for (b in 0 until len) {
            val o = b * s
            if (raw[o + Frame.EVENT] != Frame.EV_HIT) continue
            var q = toward(b, step) % len
            var k = 0
            while (taken[q] && k < len) { q = (q + 1) % len; k++ }
            taken[q] = true
            val d = q * s
            out[d + Frame.EVENT] = Frame.EV_HIT
            for (f in intArrayOf(Frame.EV_A, Frame.EV_B, Frame.EV_X, Frame.EV_Y, Frame.BEND)) out[d + f] = raw[o + f]
        }
    }

    /**
     * Bass and lead: each note (a run of frames with the gate on) moves whole, so its slides, bends and
     * vibrato stay as played; only its start is pulled toward the grid. Notes never touch: one gate-off frame
     * stays between them, or the next note would not retrigger the filter. A note that cannot move that far
     * moves less. Frames a note leaves keep their tilt and shake, with the gate off.
     */
    fun notes(raw: FloatArray, out: FloatArray, len: Int, step: Double) {
        val s = Frame.SIZE
        raw.copyInto(out, endIndex = len * s)
        fun gate(b: Int) = raw[(b % len) * s + Frame.GATE] > 0.5f
        // count from `z`, the middle of the longest pause: no note wraps around it, and notes near the
        // loop's end can still move across it
        val on0 = (0 until len).firstOrNull { gate(it) } ?: return // no notes
        var best = 0
        var bestStart = 0
        var run = 0
        var runStart = 0
        for (k in 1..len) {
            val b = (on0 + k) % len
            if (gate(b)) { run = 0; continue }
            if (run++ == 0) runStart = b
            if (run > best) { best = run; bestStart = runStart }
        }
        if (best == 0) return // held through the whole loop: nothing to move
        val z = (bestStart + best / 2) % len
        val notes = ArrayList<IntArray>() // [start, end) counted from z
        var u = 1
        while (u < len) {
            if (!gate(z + u)) { u++; continue }
            var e = u
            while (e < len && gate(z + e)) e++
            notes.add(intArrayOf(u, e))
            u = e
        }
        for ((st, e) in notes) for (v in st until e) {
            val o = ((z + v) % len) * s
            out[o + Frame.GATE] = 0f
            out[o + Frame.COUNT] = 0f
        }
        var prevEnd = 0
        notes.forEachIndexed { i, (st, e) ->
            val n = e - st
            val at = (z + st) % len
            val lo = prevEnd + 1
            val hi = (if (i + 1 < notes.size) notes[i + 1][0] - 1 else len) - n
            val t = minOf(maxOf(st + (toward(at, step) - at), lo), hi) // st itself always fits between lo and hi
            for (k in 0 until n) {
                val from = ((z + st + k) % len) * s
                raw.copyInto(out, ((z + t + k) % len) * s, from, from + s)
            }
            prevEnd = t + n
        }
    }

    /** What a track plays: [raw] on the grid of a [len]-block, [beats]-beat loop, or a plain copy. */
    fun apply(raw: FloatArray, out: FloatArray, len: Int, beats: Int, drums: Boolean, on: Boolean) {
        val step = if (beats > 0) len.toDouble() / (beats * DIVISION) else 0.0
        when {
            !on || step < 1.0 -> raw.copyInto(out, endIndex = len * Frame.SIZE)
            drums -> hits(raw, out, len, step)
            else -> notes(raw, out, len, step)
        }
    }
}
