package it.automate123.rezina

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Renders a fixed gesture through [Voice] in every [Mode], once level and once tilted (tilt 0.6, lift 0.9),
 * and compares two numbers with the same gestures rendered by the JavaScript of docs/sound-lab.html:
 * the RMS (loudness) and the RMS of the sample-to-sample difference (how bright it is).
 * Gesture: 192-sample blocks, bend 0.3, 100 bpm; a held A1 for basses, E4 for leads; kick, snare and
 * hat hits for drums. A mismatch means the port no longer sounds like the page.
 */
class VoiceTest {
    private fun measure(mode: Mode, tiltX: Float, tiltY: Float): DoubleArray {
        val v = Voice(48000f)
        val f = FloatArray(Frame.SIZE)
        val n = Engine.BLOCK
        val tl = FloatArray(n); val tr = FloatArray(n); val dl = FloatArray(n); val dr = FloatArray(n)
        // the page's snare is at tune 0.5 of its 0.3–0.7 zone; 0.495 is the same spot in the app's 0.33–0.66
        val hits = mapOf(0 to 0.1f, 60 to 0.495f, 120 to 0.9f)
        val freq = when (mode.kind) { Kind.BASS -> 55f; Kind.LEAD -> 329.63f; Kind.DRUMS -> 60f }
        var sum = 0.0
        var diff = 0.0
        var pl = 0f
        var pr = 0f
        val blocks = 250
        for (b in 0 until blocks) {
            f[Frame.GATE] = if (mode.drums) 0f else 1f
            f[Frame.TENSION] = mode.tension(freq)
            f[Frame.BEND] = 0.3f
            f[Frame.TILT_X] = tiltX
            f[Frame.TILT_Y] = tiltY
            f[Frame.EVENT] = Frame.EV_NONE
            if (mode.drums) hits[b]?.let { f[Frame.EVENT] = Frame.EV_HIT; f[Frame.EV_A] = it; f[Frame.EV_B] = 1f }
            tl.fill(0f); tr.fill(0f); dl.fill(0f); dr.fill(0f)
            v.render(tl, tr, dl, dr, f, 0, mode, 100)
            for (i in 0 until n) {
                val l = tl[i] + dl[i]
                val r = tr[i] + dr[i]
                assertTrue(l.isFinite() && r.isFinite() && abs(l) < 1f && abs(r) < 1f)
                sum += l * l + r * r
                diff += (l - pl) * (l - pl) + (r - pr) * (r - pr)
                pl = l
                pr = r
            }
        }
        val count = 2.0 * blocks * n
        return doubleArrayOf(sqrt(sum / count), sqrt(diff / count))
    }

    @Test
    fun matchesThePage() {
        // level rms, level brightness, tilted rms, tilted brightness
        val page = mapOf(
            Mode.BASS to doubleArrayOf(0.2757, 0.00735, 0.2755, 0.01176),
            Mode.ACID_BASS to doubleArrayOf(0.1961, 0.00938, 0.1983, 0.01261),
            Mode.FM_BASS to doubleArrayOf(0.2084, 0.00247, 0.2007, 0.00284),
            Mode.LEAD to doubleArrayOf(0.1098, 0.01423, 0.1162, 0.01759),
            Mode.WIDE_LEAD to doubleArrayOf(0.1227, 0.01447, 0.1248, 0.02156),
            Mode.VOICE_LEAD to doubleArrayOf(0.1209, 0.01296, 0.1496, 0.00901),
            Mode.DRUMS to doubleArrayOf(0.2349, 0.02597, 0.2345, 0.02694),
            Mode.HARD_DRUMS to doubleArrayOf(0.2210, 0.03539, 0.2213, 0.03745),
            Mode.LOFI_DRUMS to doubleArrayOf(0.2457, 0.01031, 0.1842, 0.01487),
        )
        assertEquals(Mode.entries.toSet(), page.keys)
        for ((mode, ref) in page) {
            val got = measure(mode, 0f, 0f) + measure(mode, 0.6f, 0.9f)
            println("LEVEL $mode ${got.joinToString { "%.5f".format(it) }}")
            for (k in 0 until 4) assertTrue("$mode #$k: ${got[k]} vs page ${ref[k]}", abs(got[k] - ref[k]) < ref[k] * 0.005 + 1e-4)
        }
    }

    /** Shaking only, no hits: free, then with a held band (length 0.8, bend 0.6) shaping the shaker. */
    private fun shaken(mode: Mode, held: Boolean): DoubleArray {
        val v = Voice(48000f)
        val f = FloatArray(Frame.SIZE)
        val n = Engine.BLOCK
        val tl = FloatArray(n); val tr = FloatArray(n); val dl = FloatArray(n); val dr = FloatArray(n)
        var sum = 0.0
        var diff = 0.0
        var pl = 0f
        var pr = 0f
        val blocks = 250
        for (b in 0 until blocks) {
            f[Frame.GATE] = if (held) 1f else 0f
            f[Frame.TENSION] = if (held) 0.8f else 0f
            f[Frame.BEND] = if (held) 0.6f else 0.3f
            f[Frame.SHAKE] = 0.8f
            tl.fill(0f); tr.fill(0f); dl.fill(0f); dr.fill(0f)
            v.render(tl, tr, dl, dr, f, 0, mode, 100)
            for (i in 0 until n) {
                val l = tl[i] + dl[i]
                val r = tr[i] + dr[i]
                sum += l * l + r * r
                diff += (l - pl) * (l - pl) + (r - pr) * (r - pr)
                pl = l
                pr = r
            }
        }
        val count = 2.0 * blocks * n
        return doubleArrayOf(sqrt(sum / count), sqrt(diff / count))
    }

    @Test
    fun shakerMatchesThePage() {
        // free rms, free brightness, held rms, held brightness
        val page = mapOf(
            Mode.DRUMS to doubleArrayOf(0.0482, 0.07284, 0.0451, 0.07150),
            Mode.HARD_DRUMS to doubleArrayOf(0.0668, 0.10298, 0.0610, 0.09977),
            Mode.LOFI_DRUMS to doubleArrayOf(0.0337, 0.02485, 0.0305, 0.02337),
        )
        for ((mode, ref) in page) {
            val got = shaken(mode, false) + shaken(mode, true)
            println("SHAKER $mode ${got.joinToString { "%.5f".format(it) }}")
            for (k in 0 until 4) assertTrue("$mode #$k: ${got[k]} vs page ${ref[k]}", abs(got[k] - ref[k]) < ref[k] * 0.005 + 1e-4)
        }
    }

    @Test
    fun soundButtonVisitsEveryMode() {
        val seen = generateSequence(Mode.BASS) { it.next() }.take(Mode.entries.size).toSet()
        assertEquals(Mode.entries.toSet(), seen)
    }
}
