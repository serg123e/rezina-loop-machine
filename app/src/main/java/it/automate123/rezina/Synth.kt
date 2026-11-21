package it.automate123.rezina

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.tan
import kotlin.math.tanh

/*
 * The instruments and the master bus, one class per [Mode]. They were chosen by ear on the comparison
 * page docs/sound-lab.html, whose JavaScript is the reference: keep these per-sample formulas identical
 * to it (and to ios/). The master is the page's "juicy" one. Audio thread only.
 */

internal const val TAU = (2 * PI).toFloat()
private const val SEMITONE = 0.05776227f // ln 2 / 12: 2^(x/12) == exp(x * SEMITONE)

internal fun glide(seconds: Float, sr: Float) = 1f - exp(-1f / (seconds * sr))
internal fun decay(seconds: Float, sr: Float) = exp(-1f / (seconds * sr))
internal fun wrap(p: Float) = if (p >= 1f) p - 1f else p

/** Band-limited saw (polyBLEP). */
internal fun saw(p: Float, dt: Float): Float {
    var v = 2f * p - 1f
    if (p < dt) {
        val t = p / dt
        v -= t + t - t * t - 1f
    } else if (p > 1f - dt) {
        val t = (p - 1f) / dt
        v -= t * t + t + t + 1f
    }
    return v
}

/** Band-limited square, as the difference of two saws half a cycle apart. */
internal fun sqr(p: Float, dt: Float) = 0.5f * (saw(p, dt) - saw(if (p >= 0.5f) p - 0.5f else p + 0.5f, dt))

/** xorshift: cheaper than Random on the audio thread. */
internal class Noise(private var seed: Int = 22222) {
    fun next(): Float {
        seed = seed xor (seed shl 13)
        seed = seed xor (seed ushr 17)
        seed = seed xor (seed shl 5)
        return seed / 2147483648f
    }
}

/** Zavalishin TPT state-variable filter: [run] returns the low-pass; [bp] and [hp] hold the other outputs. */
internal class Svf(private val sr: Float) {
    private var a = 0f
    private var b = 0f
    private var g = 0.1f
    var k = 1.4f
    var bp = 0f
        private set
    var hp = 0f
        private set

    fun set(fc: Float, k: Float) {
        g = tan(PI.toFloat() * fc.coerceIn(10f, sr * 0.45f) / sr)
        this.k = k
    }

    fun run(x: Float): Float {
        val a1 = 1f / (1f + g * (g + k))
        val v1 = a1 * (a + g * (x - b))
        val v2 = b + g * v1
        a = 2f * v1 - a
        b = 2f * v2 - b
        bp = v1
        hp = x - k * v1 - v2
        return v2
    }
}

/** Ping-pong echo with a darkened feedback path; the delay time can change (tempo). */
internal class PingPong(sr: Float, maxSeconds: Float, private val fb: Float, toneHz: Float) {
    private val l = FloatArray((maxSeconds * sr).toInt() + 1)
    private val r = FloatArray(l.size)
    private var w = 0
    private var lp = 0f
    private val c = glide(1f / (TAU * toneHz), sr)
    var len = l.size - 1
        set(v) { field = v.coerceIn(1, l.size - 1) }
    var outL = 0f
        private set
    var outR = 0f
        private set

    fun run(x: Float) {
        var ri = w - len
        if (ri < 0) ri += l.size
        val yl = l[ri]
        val yr = r[ri]
        lp += (yr - lp) * c
        l[w] = x + lp * fb
        r[w] = yl * fb
        if (++w == l.size) w = 0
        outL = yl
        outR = yr
    }
}

/** Small Freeverb: 4 combs + 2 allpasses per side. */
internal class Reverb(sr: Float, size: Float, private val fb: Float, private val damp: Float) {
    private class Buf(n: Int) {
        val b = FloatArray(max(8, n))
        var i = 0
        var f = 0f
    }

    private val s = sr / 44100f * size
    private val cl = intArrayOf(1557, 1617, 1491, 1422).map { Buf((it * s).roundToInt()) }
    private val cr = intArrayOf(1580, 1640, 1514, 1445).map { Buf((it * s).roundToInt()) }
    private val al = intArrayOf(556, 441).map { Buf((it * s / size).roundToInt()) }
    private val ar = intArrayOf(579, 464).map { Buf((it * s / size).roundToInt()) }
    var outL = 0f
        private set
    var outR = 0f
        private set

    private fun comb(c: Buf, x: Float): Float {
        val y = c.b[c.i]
        c.f = y * (1f - damp) + c.f * damp
        c.b[c.i] = x + c.f * fb
        if (++c.i == c.b.size) c.i = 0
        return y
    }

    private fun allpass(a: Buf, x: Float): Float {
        val y = a.b[a.i]
        a.b[a.i] = x + y * 0.5f
        if (++a.i == a.b.size) a.i = 0
        return y - x
    }

    fun run(l: Float, r: Float) {
        val x = (l + r) * 0.08f
        var yl = 0f
        var yr = 0f
        for (j in 0 until 4) {
            yl += comb(cl[j], x)
            yr += comb(cr[j], x)
        }
        for (j in 0 until 2) {
            yl = allpass(al[j], yl)
            yr = allpass(ar[j], yr)
        }
        outL = yl
        outR = yr
    }
}

/** Short delay line with a fractional read (Haas widening, chorus). */
internal class Line(private val sr: Float, maxSeconds: Float) {
    private val b = FloatArray((maxSeconds * sr).roundToInt() + 2)
    private var i = 0

    fun push(x: Float) {
        b[i] = x
        if (++i == b.size) i = 0
    }

    fun tap(seconds: Float): Float {
        var p = i - 1 - seconds * sr
        while (p < 0) p += b.size
        val i0 = p.toInt()
        val f = p - i0
        return b[i0] * (1f - f) + b[(i0 + 1) % b.size] * f
    }
}

/** One instrument. [render] ADDS one block in stereo. */
internal interface Instrument {
    /** A drum hit; returns true for a kick, which the master ducks the other instruments to. */
    fun hit(tune: Float, vel: Float, bend: Float): Boolean = false

    fun render(l: FloatArray, r: FloatArray, c: Ctl, gain: Float)
}

/** Where a drum hit lands: 0 kick, 1 tom/snare, 2 hat; same edges as the grid in [BandView]. */
internal fun drumZone(tune: Float) = if (tune < KICK_UP_TO) 0 else if (tune < SNARE_UP_TO) 1 else 2

/** 0..1 across the tom/snare zone. */
internal fun snareSpan(tune: Float) = (tune - KICK_UP_TO) / (SNARE_UP_TO - KICK_UP_TO)

/**
 * How tilt and lift colour a drum kit, per block: [tone] -0.5…+0.5 (0 at level) moves the noise filters,
 * [click] 0.5…1.5 scales the kick's click, [tune] raises the pitched parts up to 3 semitones when upright.
 */
internal class DrumColour {
    var tone = 0f
    var click = 1f
    var tune = 1f
    fun set(c: Ctl) {
        val bright = (c.tiltX + 1f) / 2f
        tone = bright - 0.5f
        click = 0.5f + bright
        tune = 2f.pow(c.tiltY * 3f / 12f)
    }
}

/**
 * Shaker colour from the band held on screen ([Ctl.held]): its length → brightness (the shaker filter
 * ×0.5…×2), its bend → grain (smooth "shh" at 0 … sparse rattles at 1). With no fingers: unchanged.
 */
internal class ShakerShape(private val sr: Float, private val noise: Noise) {
    private var env = 0f
    private var g = 0f
    private var p = 0f
    private val gd = decay(0.003f, sr)
    /** Multiplier for the shaker filter's cutoff. */
    var cutoff = 1f
        private set

    fun set(c: Ctl) {
        g = if (c.held) c.bend else 0f
        cutoff = if (c.held) 2f.pow((c.tension - 0.5f) * 2f) else 1f
        p = 3000f * (60f / 3000f).pow(g) / sr // grains per sample
    }

    /** Per sample: the shaker's level. */
    fun amp(): Float {
        if (g <= 0f) return 1f
        if (noise.next() * 0.5f + 0.5f < p) env = 0.5f + 0.5f * abs(noise.next()) else env *= gd
        return (1f - g) + g * env * 2.5f
    }
}

internal const val KICK_UP_TO = 0.33f
internal const val SNARE_UP_TO = 0.66f

/** What an instrument gets once per block, from a [Frame]. */
internal class Ctl {
    var gate = false
    /** Fingers are on the band (the raw gate; drums get [gate] false but use this for the shaker). */
    var held = false
    /** The finger just touched: gate rose in this block. */
    var on = false
    var freq = 110f
    var tension = 0f
    var bend = 0f
    var tiltX = 0f
    var tiltY = 0f
    var shake = 0f
    var bpm = 100
}

/** Pitch glide, amplitude, a per-note envelope, vibrato and shake wobble shared by the melodic voices. */
internal abstract class Melodic(protected val sr: Float, pitchGlide: Float, attack: Float, release: Float) : Instrument {
    private val pg = glide(pitchGlide, sr)
    private val att = glide(attack, sr)
    private val rel = glide(release, sr)
    private var freq = 0f
    private var vp = 0f
    private var wp = 0f
    protected var amp = 0f
    protected var env = 0f
    protected var envD = 0f
    /** Samples since the voice went quiet; lets echo and reverb tails ring out, then the voice sleeps. */
    private var quiet = 0

    /** One sample: glides pitch and amplitude toward the targets; returns the frequency with vibrato and wobble. */
    protected fun step(c: Ctl, targetAmp: Float, vibDepth: Float): Float {
        if (freq == 0f) freq = c.freq
        freq += (c.freq - freq) * pg
        amp += (targetAmp - amp) * (if (targetAmp > amp) att else rel)
        env *= envD
        vp = wrap(vp + 5.5f / sr)
        wp = wrap(wp + 11f / sr)
        return freq * exp((vibDepth * sin(TAU * vp) + 1.5f * c.shake * sin(TAU * wp)) * SEMITONE)
    }

    /** True when nothing would be heard: not playing and the tail ([tailSeconds]) has run out. */
    protected fun asleep(c: Ctl, n: Int, tailSeconds: Float): Boolean {
        if (c.gate || amp > 1e-5f) {
            quiet = 0
            return false
        }
        if (quiet > tailSeconds * sr) return true
        quiet += n
        return false
    }

}

/**
 * Bass "growl" ([Mode.BASS]): three detuned saws → drive → resonant low-pass (+ a little band-pass "honk") → drive again;
 * a clean sine sub under it; the top above ~250 Hz widened by a Haas delay. Raising the phone to upright
 * makes the filter wobble in eighths of the loop tempo.
 */
internal class GrowlBass(sr: Float) : Melodic(sr, 0.02f, 0.004f, 0.06f) {
    private val p = floatArrayOf(0f, 0.33f, 0.67f)
    private var ps = 0f
    private val f = Svf(sr)
    private var lfo = 0f
    private var hlp = 0f
    private val hc = glide(1f / (TAU * 250f), sr)
    private val haas = FloatArray((0.011f * sr).roundToInt())
    private var hi = 0
    private val envDecay = decay(0.25f, sr)

    override fun render(l: FloatArray, r: FloatArray, c: Ctl, gain: Float) {
        if (asleep(c, l.size, 0.05f)) return
        if (c.on) {
            env = 1f
            envD = envDecay
        }
        val bright = (c.tiltX + 1f) / 2f
        val base = 110f * 2f.pow(bright * 4.2f)
        // the phone is held at an angle while playing: only the last stretch toward upright wobbles
        val wub = ((c.tiltY - 0.8f) / 0.2f).coerceIn(0f, 1f)
        val drv = 1.5f + 5f * c.bend
        val k = 0.95f - 0.55f * c.bend
        val ta = if (c.gate) 1f else 0f
        val lfoStep = c.bpm / 60f * 2f / sr
        for (i in l.indices) {
            val fr = step(c, ta, 0f)
            lfo = wrap(lfo + lfoStep)
            var x = 0f
            for (j in 0 until 3) {
                val dt = fr * DETUNE[j] / sr
                p[j] = wrap(p[j] + dt)
                x += saw(p[j], dt)
            }
            x = tanh(x * 0.4f * drv)
            if (i and 7 == 0) {
                val w = (0.5f - 0.5f * cos(TAU * lfo)) * wub * 3f - wub * 1.2f
                f.set(base * (1f + 1.5f * env) * 2f.pow(w), k)
            }
            var y = f.run(x)
            y = tanh((y + 0.3f * f.bp) * 1.5f)
            ps = wrap(ps + fr / sr)
            val sub = 0.55f * sin(TAU * ps)
            hlp += (y - hlp) * hc
            val top = y - hlp
            val topLate = haas[hi]
            haas[hi] = top
            if (++hi == haas.size) hi = 0
            l[i] += (y + sub) * amp * gain
            r[i] += (y - top + topLate + sub) * amp * gain
        }
    }

    private companion object {
        val DETUNE = floatArrayOf(1f, 1.0065f, 0.9938f)
    }
}

/**
 * Lead "pluck" ([Mode.LEAD]): saw + square through a low-pass that snaps open on every touch and falls back, the level
 * dropping to a quieter sustain; a dotted-eighth ping-pong echo (follows the tempo) and a little reverb.
 */
internal class PluckLead(sr: Float) : Melodic(sr, 0.015f, 0.002f, 0.15f) {
    private var p1 = 0f
    private var p2 = 0.5f
    private val f = Svf(sr)
    private var a2 = 0f
    private val ad = decay(0.25f, sr)
    private val echo = PingPong(sr, 0.75f * 60f / 40f, 0.45f, 4000f)
    private val room = Reverb(sr, 1f, 0.8f, 0.4f)

    override fun render(l: FloatArray, r: FloatArray, c: Ctl, gain: Float) {
        if (asleep(c, l.size, 6f)) return
        if (c.on) {
            env = 1f
            envD = decay(0.1f + 0.25f * c.bend, sr)
            a2 = 1f
        }
        echo.len = (0.75f * 60f / c.bpm * sr).roundToInt()
        val bright = (c.tiltX + 1f) / 2f
        val base = 250f * 2f.pow(bright * 3.5f)
        val k = 1f - 0.7f * c.bend
        val ta = if (c.gate) 1f else 0f
        val drv = 1.2f + 2f * c.bend
        for (i in l.indices) {
            val fr = step(c, ta, 0.45f * c.tiltY)
            a2 *= ad
            val d1 = fr / sr
            val d2 = fr * 1.005f / sr
            p1 = wrap(p1 + d1)
            p2 = wrap(p2 + d2)
            if (i and 7 == 0) f.set(base * 2f.pow(env * 4f), k)
            val y = tanh(f.run(0.6f * saw(p1, d1) + 0.5f * sqr(p2, d2)) * drv) * amp * (0.35f + 0.65f * a2)
            echo.run(y)
            room.run(y + 0.6f * echo.outL, y + 0.6f * echo.outR)
            l[i] += (y + 0.38f * echo.outL + 0.25f * room.outL) * gain
            r[i] += (y + 0.38f * echo.outR + 0.25f * room.outR) * gain
        }
    }
}

/**
 * Drums "808" ([Mode.DRUMS]): three voices, so a hat no longer cuts the kick. Tilt and lift colour it ([DrumColour]). The zones are the ones on screen:
 * kick (tune < 1/3) — a sine with a falling pitch, a click and drive; tom/snare (1/3…2/3) — two tones
 * plus noise, more noise further out; hat (> 2/3) — six detuned squares, high-passed. Bend lengthens
 * the kick and opens the hat. Shaking adds a shaker.
 */
internal class Kit808(private val sr: Float) : Instrument {
    private val noise = Noise()
    // kick
    private var kp = 0f
    private var ke = 0f
    private var kpe = 0f
    private var kf0 = 50f
    private var kd = 0f
    private var kcl = 0f
    private val pd = decay(0.028f, sr)
    private val cd = decay(0.0025f, sr)
    // tom / snare
    private var mp1 = 0f
    private var mp2 = 0f
    private var mte = 0f
    private var mtd = 0f
    private var mne = 0f
    private var mnd = 0f
    private var mf = 150f
    private var mu = 0f
    private val ms = Svf(sr).apply { set(1800f, 0.8f) }
    // hat
    private val hp = FloatArray(6)
    private var he = 0f
    private var hd = 0f
    private val hs = Svf(sr).apply { set(7500f, 0.7f) }
    private val shs = Svf(sr).apply { set(5000f, 1f) }
    private val col = DrumColour()
    private val shape = ShakerShape(sr, noise)

    override fun hit(tune: Float, vel: Float, bend: Float): Boolean {
        when (drumZone(tune)) {
            0 -> {
                kf0 = 48f * 2f.pow(tune * 1.5f)
                kp = 0f
                ke = vel
                kpe = 1f
                kd = decay(0.38f * (1f + 1.5f * bend), sr)
                kcl = vel
                return true
            }
            1 -> {
                val u = snareSpan(tune)
                mu = u
                mf = 110f * 2f.pow(u * 1.3f)
                mte = vel
                mtd = decay(0.2f * (1f - 0.5f * u) * (1f + bend), sr)
                mne = vel * u * u
                mnd = decay(0.13f + 0.15f * bend, sr)
                mp1 = 0f
                mp2 = 0f
            }
            else -> {
                he = vel
                hd = decay(0.045f + 0.35f * bend, sr)
            }
        }
        return false
    }

    override fun render(l: FloatArray, r: FloatArray, c: Ctl, gain: Float) {
        val shaker = 0.35f * c.shake * c.shake
        if (ke <= 1e-4f && mte <= 1e-4f && mne <= 1e-4f && he <= 1e-4f && shaker <= 0f) return
        col.set(c)
        ms.set(1800f * 2f.pow(col.tone * 2f), 0.8f)
        hs.set(7500f * 2f.pow(col.tone * 1.2f), 0.7f)
        shape.set(c)
        shs.set(5000f * shape.cutoff, 1f)
        for (i in l.indices) {
            var left = 0f
            var right = 0f
            if (ke > 1e-4f) {
                kpe *= pd
                kp = wrap(kp + kf0 * col.tune * (1f + 4f * kpe) / sr)
                val y = tanh((sin(TAU * kp) * ke + 0.4f * col.click * noise.next() * kcl) * 2.5f) * 0.8f
                ke *= kd
                kcl *= cd
                left += y
                right += y
            }
            if (mte > 1e-4f || mne > 1e-4f) {
                mp1 = wrap(mp1 + mf * col.tune / sr)
                mp2 = wrap(mp2 + mf * col.tune * 1.48f / sr)
                val tone = (0.75f * sin(TAU * mp1) + 0.35f * sin(TAU * mp2)) * mte
                ms.run(noise.next())
                val nz = (0.7f * ms.hp + 0.5f * ms.bp) * mne
                val y = tanh((tone + nz) * 1.6f) * 0.75f
                mte *= mtd
                mne *= mnd
                val pan = 0.5f - 0.35f * (1f - mu)
                left += y * (1f - pan) * 1.4f
                right += y * pan * 1.4f
            }
            if (he > 1e-4f) {
                var x = 0f
                for (j in 0 until 6) {
                    hp[j] = wrap(hp[j] + HAT_HZ[j] * 1.7f * col.tune / sr)
                    x += if (hp[j] < 0.5f) 1f else -1f
                }
                hs.run(x / 6f * 0.8f + 0.3f * noise.next())
                val y = hs.hp * he * 0.6f
                he *= hd
                left += y * 0.7f
                right += y * 1.1f
            }
            if (shaker > 0f) {
                shs.run(noise.next())
                val y = shs.hp * shaker * shape.amp()
                left += y * 0.6f
                right += y
            }
            l[i] += left * gain
            r[i] += right * gain
        }
    }

    private companion object {
        val HAT_HZ = floatArrayOf(205.3f, 304.4f, 369.6f, 522.7f, 540f, 800f)
    }
}

/** Bass "acid": one saw through a resonant low-pass that snaps open on every touch and falls back. */
internal class AcidBass(sr: Float) : Melodic(sr, 0.035f, 0.002f, 0.04f) {
    private val f = Svf(sr)
    private var p = 0f
    private var ps = 0f

    override fun render(l: FloatArray, r: FloatArray, c: Ctl, gain: Float) {
        if (asleep(c, l.size, 0.05f)) return
        if (c.on) {
            env = 1f
            envD = decay(0.14f + 0.5f * c.bend, sr)
        }
        val bright = (c.tiltX + 1f) / 2f
        val base = 80f * 2f.pow(bright * 3.5f)
        val envOct = 2.5f + 3f * c.bend
        val k = 0.5f - 0.4f * c.bend
        val ta = if (c.gate) 1f else 0f
        val drv = 2f + 4f * c.bend
        for (i in l.indices) {
            val fr = step(c, ta, 0.3f * c.tiltY)
            val dt = fr / sr
            p = wrap(p + dt)
            ps = wrap(ps + dt)
            if (i and 7 == 0) f.set(base * 2f.pow(env * envOct), k)
            val y = tanh(f.run(saw(p, dt) * 1.2f) * drv) * 0.8f
            val s = (y + 0.35f * sin(TAU * ps)) * amp * (0.75f + 0.25f * env) * gain
            l[i] += s
            r[i] += s
        }
    }
}

/** Bass "FM": a sine phase-modulated by itself — a bark on the attack and mids a phone speaker can play. */
internal class FmBass(sr: Float) : Melodic(sr, 0.02f, 0.002f, 0.05f) {
    private var pc = 0f
    private var pm = 0f
    private var pm2 = 0f

    override fun render(l: FloatArray, r: FloatArray, c: Ctl, gain: Float) {
        if (asleep(c, l.size, 0.05f)) return
        if (c.on) {
            env = 1f
            envD = decay(0.11f + 0.3f * c.bend, sr)
        }
        val bright = (c.tiltX + 1f) / 2f
        val idx0 = 0.6f + 2.6f * c.bend + 2.2f * bright
        val ta = if (c.gate) 1f else 0f
        for (i in l.indices) {
            val fr = step(c, ta, 0.3f * c.tiltY)
            pc = wrap(pc + fr / sr)
            pm = wrap(pm + fr / sr)
            pm2 = wrap(pm2 + fr * 2f / sr)
            val idx = idx0 * (0.3f + 0.7f * env)
            val mod = sin(TAU * pm) + 0.35f * env * sin(TAU * pm2)
            val s = tanh(sin(TAU * pc + idx * mod) * 1.7f) * 0.85f * amp * gain
            l[i] += s
            r[i] += s
        }
    }
}

/** Lead "wide": seven detuned saws split left/right, a filter, a 3/16 ping-pong echo and a hall. */
internal class WideLead(sr: Float) : Melodic(sr, 0.02f, 0.01f, 0.12f) {
    private val p = FloatArray(7) { (it * 0.618f) % 1f }
    private val rat = FloatArray(7)
    private val fl = Svf(sr)
    private val fr = Svf(sr)
    private val echo = PingPong(sr, 0.75f * 60f / 40f, 0.38f, 3500f)
    private val room = Reverb(sr, 1.1f, 0.84f, 0.35f)
    private val envDecay = decay(0.3f, sr)

    override fun render(l: FloatArray, r: FloatArray, c: Ctl, gain: Float) {
        if (asleep(c, l.size, 6f)) return
        if (c.on) {
            env = 1f
            envD = envDecay
        }
        echo.len = (0.75f * 60f / c.bpm * sr).roundToInt()
        val bright = (c.tiltX + 1f) / 2f
        val cents = 14f + 30f * c.bend
        for (j in 0 until 7) rat[j] = 2f.pow(OFFSET[j] * cents / 1200f) / sr
        val k = 1.1f - 0.6f * c.bend
        val ta = if (c.gate) 0.5f + 0.5f * c.tension else 0f
        for (i in l.indices) {
            val f = step(c, ta, 0.5f * c.tiltY)
            var xl = 0f
            var xr = 0f
            for (j in 0 until 7) {
                val dt = f * rat[j]
                p[j] = wrap(p[j] + dt)
                val s = saw(p[j], dt)
                xl += s * (0.25f + 0.75f * SIDE[j])
                xr += s * (1f - 0.75f * SIDE[j])
            }
            if (i and 15 == 0) {
                val fc = 400f * 2f.pow(bright * 4.5f) * (1f + 1.5f * env)
                fl.set(fc, k)
                fr.set(fc, k)
            }
            val yl = tanh(fl.run(xl * 0.22f) * 1.3f) * amp
            val yr = tanh(fr.run(xr * 0.22f) * 1.3f) * amp
            echo.run((yl + yr) * 0.5f)
            room.run(yl + 0.5f * echo.outL, yr + 0.5f * echo.outR)
            l[i] += (yl + 0.32f * echo.outL + 0.3f * room.outL) * gain
            r[i] += (yr + 0.32f * echo.outR + 0.3f * room.outR) * gain
        }
    }

    private companion object {
        val OFFSET = floatArrayOf(-1f, -0.66f, -0.33f, 0f, 0.33f, 0.66f, 1f)
        /** 1 = mostly left, 0 = mostly right. */
        val SIDE = floatArrayOf(1f, 0f, 1f, 0.5f, 0f, 1f, 0f)
    }
}

/** Lead "voice": a saw through three vowel formants; tilt moves the vowel U-O-A-E-I, bend opens it toward A. */
internal class VoiceLead(sr: Float) : Melodic(sr, 0.03f, 0.02f, 0.12f) {
    private val noise = Noise()
    private var p = 0f
    private val bp = Array(3) { Svf(sr) }
    private var v = 1f
    private val vg = glide(0.05f, sr)
    private val line = Line(sr, 0.03f)
    private var cp = 0f
    private val room = Reverb(sr, 1.2f, 0.85f, 0.3f)

    override fun render(l: FloatArray, r: FloatArray, c: Ctl, gain: Float) {
        if (asleep(c, l.size, 4f)) return
        val bright = (c.tiltX + 1f) / 2f
        val tv = (bright * 0.9f + 0.4f * c.bend).coerceIn(0f, 1f) * 4f
        val ta = if (c.gate) 0.6f + 0.4f * c.tension else 0f
        val drv = 2f + 2f * c.bend
        for (i in l.indices) {
            val f = step(c, ta, 0.15f + 0.5f * c.tiltY)
            val dt = f / sr
            p = wrap(p + dt)
            v += (tv - v) * vg
            if (i and 15 == 0) {
                val a = v.coerceIn(0f, 3.999f).toInt()
                val fr = v - a
                for (j in 0 until 3) bp[j].set(VOWELS[a][j] * (1f - fr) + VOWELS[a + 1][j] * fr, if (j == 0) 0.25f else 0.14f)
            }
            val x = saw(p, dt) + 0.06f * noise.next()
            var y = 0f
            for (j in 0 until 3) {
                bp[j].run(x)
                y += bp[j].bp * bp[j].k * FORMANT_GAIN[j]
            }
            y = tanh(y * drv) * amp
            line.push(y)
            cp = wrap(cp + 0.6f / sr)
            val ch = line.tap(0.012f + 0.004f * sin(TAU * cp))
            room.run(y, ch)
            l[i] += (y + 0.3f * room.outL) * gain
            r[i] += (0.6f * y + 0.5f * ch + 0.3f * room.outR) * gain
        }
    }

    private companion object {
        /** Formants in Hz: U, O, A, E, I. */
        val VOWELS = arrayOf(
            floatArrayOf(325f, 700f, 2530f), floatArrayOf(450f, 800f, 2830f), floatArrayOf(800f, 1150f, 2900f),
            floatArrayOf(400f, 1600f, 2700f), floatArrayOf(300f, 2300f, 3000f),
        )
        val FORMANT_GAIN = floatArrayOf(1f, 0.7f, 0.35f)
    }
}

/** Drums "hard": a heavily driven kick, a hand clap (three bursts and a tail) over a tom tone, a sharp hat. */
internal class KitHard(private val sr: Float) : Instrument {
    private val noise = Noise()
    private var kp = 0f
    private var ke = 0f
    private var kpe = 0f
    private var kd = 0f
    private var kcl = 0f
    private val pd = decay(0.018f, sr)
    private val cd = decay(0.002f, sr)
    /** Samples since the clap started; past 2 s it is silent. */
    private var mt = Int.MAX_VALUE
    private var mv = 0f
    private var mtail = 0.15f
    private var mu = 0f
    private var mp = 0f
    private var mte = 0f
    private var mtd = 0f
    private var mf = 100f
    private val ms = Svf(sr).apply { set(1150f, 0.55f) }
    private val line = Line(sr, 0.02f)
    private var he = 0f
    private var hd = 0f
    private var hp = 0f
    private val hs = Svf(sr).apply { set(8500f, 0.6f) }
    private val burst = 0.008f * sr
    private val burstDecay = 0.002f * sr
    private val col = DrumColour()
    private val shs = Svf(sr).apply { set(6000f, 1f) }
    private val shape = ShakerShape(sr, noise)

    override fun hit(tune: Float, vel: Float, bend: Float): Boolean {
        when (drumZone(tune)) {
            0 -> {
                kp = 0f
                ke = vel
                kpe = 1f
                kd = decay(0.42f * (1f + bend), sr)
                kcl = vel
                return true
            }
            1 -> {
                val u = snareSpan(tune)
                mt = 0
                mu = u
                mv = vel
                mtail = 0.12f + 0.2f * bend
                mf = 95f * 2f.pow(u * 1.1f)
                mte = vel * (1f - u)
                mtd = decay(0.22f, sr)
                mp = 0f
            }
            else -> {
                he = vel
                hd = decay(0.03f + 0.3f * bend, sr)
            }
        }
        return false
    }

    override fun render(l: FloatArray, r: FloatArray, c: Ctl, gain: Float) {
        val sh = 0.4f * c.shake * c.shake
        if (ke <= 1e-4f && mt > 2 * sr && he <= 1e-4f && sh <= 0f) return
        col.set(c)
        ms.set(1150f * 2f.pow(col.tone * 1.6f), 0.55f)
        hs.set(8500f * 2f.pow(col.tone), 0.6f)
        shape.set(c)
        shs.set(6000f * shape.cutoff, 1f)
        for (i in l.indices) {
            var left = 0f
            var right = 0f
            if (ke > 1e-4f) {
                kpe *= pd
                kp = wrap(kp + 46f * col.tune * (1f + 7f * kpe) / sr)
                val y = tanh((sin(TAU * kp) * ke + 0.5f * col.click * kcl * sin(TAU * kp * 37f)) * 7f) * 0.55f
                ke *= kd
                kcl *= cd
                left += y
                right += y
            }
            var clap = 0f
            if (mt < 2 * sr) {
                val t = mt++.toFloat()
                val env = if (t < 3 * burst) exp(-(t % burst) / burstDecay) else exp(-(t - 3 * burst) / (mtail * sr))
                ms.run(noise.next())
                clap = ms.bp * env * mv * (0.3f + 0.7f * mu) * 1.6f
                mp = wrap(mp + mf * col.tune * (1f + 0.5f * mte) / sr)
                clap += sin(TAU * mp) * mte
                mte *= mtd
            }
            line.push(clap)
            left += clap
            right += 0.6f * clap + 0.5f * line.tap(0.009f)
            if (sh > 0f) {
                shs.run(noise.next())
                val y = shs.hp * sh * shape.amp()
                left += y * 0.8f
                right += y
            }
            if (he > 1e-4f) {
                hp = wrap(hp + 3970f * col.tune / sr)
                hs.run(noise.next() * (if (hp < 0.5f) 1f else -0.4f))
                val y = hs.hp * he * 0.55f
                he *= hd
                left += y * 0.8f
                right += y
            }
            l[i] += tanh(left * 1.3f) * gain
            r[i] += tanh(right * 1.3f) * gain
        }
    }
}

/**
 * Drums "lo-fi": a soft, warm kit through a gentle "old sampler" — 12 bit at half the sample rate,
 * two soft low-passes at 8 kHz, tape-style saturation — and a small room.
 */
internal class KitLofi(private val sr: Float) : Instrument {
    private val noise = Noise()
    private var kp = 0f
    private var ke = 0f
    private var kpe = 0f
    private var kd = 0f
    private var kcl = 0f
    private val pd = decay(0.04f, sr)
    private val cd = decay(0.004f, sr)
    private var mp = 0f
    private var mte = 0f
    private var mtd = 0f
    private var mne = 0f
    private var mnd = 0f
    private var mf = 185f
    private val ms = Svf(sr).apply { set(2200f, 1f) }
    private var he = 0f
    private var hd = 0f
    private val hs = Svf(sr).apply { set(7000f, 1.2f) }
    private val shs = Svf(sr).apply { set(4000f, 1.2f) }
    private var lpA = 0f
    private val col = DrumColour()
    private val shape = ShakerShape(sr, noise)
    private var hc = 0
    private var hl = 0f
    private var hr = 0f
    private var l1 = 0f
    private var l2 = 0f
    private var r1 = 0f
    private var r2 = 0f
    private val room = Reverb(sr, 0.5f, 0.72f, 0.5f)
    /** Samples since the last sound; lets the room ring out, then the kit sleeps. */
    private var quiet = Int.MAX_VALUE / 2

    override fun hit(tune: Float, vel: Float, bend: Float): Boolean {
        val v = vel * (0.9f + 0.1f * noise.next())
        quiet = 0
        when (drumZone(tune)) {
            0 -> {
                kp = 0f
                ke = v
                kpe = 1f
                kd = decay(0.32f * (1f + bend), sr)
                kcl = v
                return true
            }
            1 -> {
                val u = snareSpan(tune)
                mf = 150f * 2f.pow(u * 0.8f)
                mte = v * (1f - 0.3f * u)
                mtd = decay(0.09f * (1f + bend), sr)
                mne = v * (0.35f + 0.65f * u)
                mnd = decay(0.16f * (1f + bend), sr)
                mp = 0f
            }
            else -> {
                he = v * 0.7f
                hd = decay(0.04f + 0.25f * bend, sr)
            }
        }
        return false
    }

    override fun render(l: FloatArray, r: FloatArray, c: Ctl, gain: Float) {
        val shaker = 0.3f * c.shake * c.shake
        if (shaker > 0f) quiet = 0
        if (quiet > 2 * sr) return
        quiet += l.size
        col.set(c)
        lpA = glide(1f / (TAU * 8000f * 2f.pow(col.tone * 2f)), sr)
        ms.set(2200f * 2f.pow(col.tone * 1.4f), 1f)
        hs.set(7000f * 2f.pow(col.tone), 1.2f)
        shape.set(c)
        shs.set(4000f * shape.cutoff, 1.2f)
        for (i in l.indices) {
            var x = 0f
            var top = 0f
            if (ke > 1e-4f) {
                kpe *= pd
                kp = wrap(kp + 52f * col.tune * (1f + 1.5f * kpe) / sr)
                x += tanh((sin(TAU * kp) * ke + 0.25f * col.click * noise.next() * kcl) * 1.3f)
                ke *= kd
                kcl *= cd
            }
            if (mte > 1e-4f || mne > 1e-4f) {
                mp = wrap(mp + mf * col.tune / sr)
                val lp = ms.run(noise.next())
                x += sin(TAU * mp) * mte * 0.8f + (0.9f * ms.bp + 0.2f * lp) * mne
                mte *= mtd
                mne *= mnd
            }
            if (he > 1e-4f) {
                hs.run(noise.next())
                top += hs.hp * he * 0.5f
                he *= hd
            }
            if (shaker > 0f) {
                shs.run(noise.next())
                top += shs.hp * shaker * shape.amp()
            }
            val sl = x + 0.8f * top
            val sR = x + 1.1f * top
            if (++hc >= 2) {
                hc = 0
                hl = (sl * 2048f).roundToInt() / 2048f
                hr = (sR * 2048f).roundToInt() / 2048f
            }
            l1 += (hl - l1) * lpA
            l2 += (l1 - l2) * lpA
            r1 += (hr - r1) * lpA
            r2 += (r1 - r2) * lpA
            val ol = tanh(l2 * 1.4f)
            val or = tanh(r2 * 1.4f)
            room.run(ol, or)
            l[i] += (ol + 0.3f * room.outL) * gain
            r[i] += (or + 0.3f * room.outR) * gain
        }
    }
}

/**
 * Master "juicy": bass and lead duck under every kick (the loop "pumps"), the drums get a small room,
 * a bus compressor glues everything, tanh limits the peaks. Writes interleaved stereo.
 */
internal class Master(sr: Float) {
    private val room = Reverb(sr, 0.7f, 0.75f, 0.45f)
    private val duckAtt = glide(0.004f, sr)
    private val duckRel = decay(0.16f, sr)
    private val compAtt = glide(0.008f, sr)
    private val compRel = glide(0.15f, sr)
    private var duck = 0f
    private var rising = false
    private var env = 0f

    fun render(toneL: FloatArray, toneR: FloatArray, drumL: FloatArray, drumR: FloatArray, kicked: Boolean, out: FloatArray) {
        if (kicked) rising = true
        for (i in toneL.indices) {
            if (rising) {
                duck += (1f - duck) * duckAtt
                if (duck > 0.98f) rising = false
            } else {
                duck *= duckRel
            }
            val g = 1f - 0.45f * duck
            room.run(drumL[i] * 0.5f, drumR[i] * 0.5f)
            val l = toneL[i] * g + drumL[i] + 0.22f * room.outL
            val r = toneR[i] * g + drumR[i] + 0.22f * room.outR
            val x = max(abs(l), abs(r))
            env += (x - env) * (if (x > env) compAtt else compRel)
            val cg = if (env > THRESHOLD) (THRESHOLD + (env - THRESHOLD) / RATIO) / env else 1f
            out[2 * i] = tanh(l * cg * 1.8f)
            out[2 * i + 1] = tanh(r * cg * 1.8f)
        }
    }

    private companion object {
        const val THRESHOLD = 0.3f
        const val RATIO = 4f
    }
}
