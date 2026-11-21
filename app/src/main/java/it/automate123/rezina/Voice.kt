package it.automate123.rezina

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.tan
import kotlin.math.tanh

/**
 * One instrument voice, driven by gesture frames ([Frame]). Audio thread only.
 *
 * Melodic modes: two detuned saws (+ sub for bass) → drive (bend) → resonant low-pass (tilt) → amp.
 * Drums: a pitch-swept sine body + high-passed noise per [Frame.EV_HIT]; shaking adds a shaker.
 */
class Voice(private val sr: Float) {
    private fun glide(seconds: Float) = 1f - exp(-1f / (seconds * sr))
    private fun decay(seconds: Float) = exp(-1f / (seconds * sr))

    private val pitchGlide = glide(0.012f)
    private val attack = glide(0.005f)
    private val release = glide(0.06f)
    private val paramGlide = glide(0.03f)
    private val sweepGlide = glide(0.03f)

    // tone
    private var freq = 110f
    private var amp = 0f
    private var cutoff = 1000f
    private var drive = 1f
    private var damping = 1.4f
    private var phase1 = 0f
    private var phase2 = 0f
    private var phaseSub = 0f
    private var vibPhase = 0f
    private var wobPhase = 0f

    // Zavalishin TPT state-variable filter
    private var ic1 = 0f
    private var ic2 = 0f
    private var g = 0.1f

    // drum
    private var drumTarget = 60f
    private var drumFreq = 60f
    private var drumPhase = 0f
    private var bodyEnv = 0f
    private var bodyDecay = 0f
    private var noiseEnv = 0f
    private var noiseDecay = 0f
    private var noiseLp = 0f
    private var seed = 22222

    /** Renders one block from the frame at [frames]`[off]` and ADDS it into [out]. */
    fun render(out: FloatArray, frames: FloatArray, off: Int, mode: Mode) {
        val t = frames[off + Frame.TENSION]
        val b = frames[off + Frame.BEND]
        val gate = frames[off + Frame.GATE] > 0.5f
        val tiltX = frames[off + Frame.TILT_X]
        val tiltY = frames[off + Frame.TILT_Y]
        val sh = frames[off + Frame.SHAKE]

        when (frames[off + Frame.EVENT]) {
            Frame.EV_HIT -> if (mode == Mode.DRUMS) hit(frames[off + Frame.EV_A], frames[off + Frame.EV_B], b)
        }

        val bass = mode == Mode.BASS
        val targetFreq = mode.freq(t)
        val targetAmp = when {
            !gate || mode == Mode.DRUMS -> 0f
            bass -> 0.5f + 0.5f * t
            else -> 0.25f + 0.75f * t
        }
        val bright = (tiltX + 1f) / 2f // 0 = left edge down, 1 = right edge down
        val targetCutoff = (if (bass) 60f * 2f.pow(bright * 5f) else 150f * 2f.pow(bright * 6f))
            .times(1f + 2f * sh).coerceAtMost(sr * 0.45f)
        val targetDrive = 1f + 5f * b
        val targetDamping = (if (bass) 1.4f - 0.9f * b else 1.4f - 1.25f * b) // lower = more resonance
        val vibDepth = 0.6f * tiltY // semitones
        val wobDepth = 1.5f * sh // semitones
        val noiseHp = 0.1f + 0.5f * bright // higher = thinner, brighter noise
        val shaker = if (mode == Mode.DRUMS) 0.3f * sh * sh else 0f
        val toneIdle = targetAmp == 0f && amp < 1e-4f

        for (i in out.indices) {
            var s = 0f

            if (!toneIdle) {
                freq += (targetFreq - freq) * pitchGlide
                amp += (targetAmp - amp) * (if (targetAmp > amp) attack else release)
                cutoff += (targetCutoff - cutoff) * paramGlide
                drive += (targetDrive - drive) * paramGlide
                damping += (targetDamping - damping) * paramGlide

                vibPhase = wrap(vibPhase + 5.5f / sr)
                wobPhase = wrap(wobPhase + 11f / sr)
                val semis = vibDepth * sin(TAU * vibPhase) + wobDepth * sin(TAU * wobPhase)
                val f = freq * 2f.pow(semis / 12f)

                val dt1 = f * 1.004f / sr
                val dt2 = f * 0.996f / sr
                phase1 = wrap(phase1 + dt1)
                phase2 = wrap(phase2 + dt2)
                var x = 0.5f * (saw(phase1, dt1) + saw(phase2, dt2))
                if (bass) {
                    phaseSub = wrap(phaseSub + f * 0.5f / sr)
                    x = 0.5f * x + 0.7f * sin(TAU * phaseSub)
                }
                x = tanh(x * drive) / tanh(drive).coerceAtLeast(0.5f)

                if (i and 31 == 0) g = tan(PI.toFloat() * cutoff / sr) // tan is costly
                val a1 = 1f / (1f + g * (g + damping))
                val v1 = a1 * (ic1 + g * (x - ic2))
                val v2 = ic2 + g * v1
                ic1 = 2f * v1 - ic1
                ic2 = 2f * v2 - ic2

                s += v2 * amp * (1f - 0.3f * sh * abs(sin(TAU * wobPhase)))
            }

            if (bodyEnv > 1e-4f || noiseEnv > 1e-4f || shaker > 0f) {
                drumFreq += (drumTarget - drumFreq) * sweepGlide
                drumPhase = wrap(drumPhase + drumFreq / sr)
                s += sin(TAU * drumPhase) * bodyEnv
                bodyEnv *= bodyDecay

                val n = noise()
                noiseLp += (n - noiseLp) * (1f - noiseHp)
                s += (n - noiseLp) * (0.6f * noiseEnv + shaker)
                noiseEnv *= noiseDecay
            }

            out[i] += s
        }
    }

    /** tune 0 = kick (low, no noise) … 1 = hat (high, mostly noise); bend lengthens the ring. */
    private fun hit(tune: Float, vel: Float, bend: Float) {
        drumTarget = Mode.DRUMS.freq(tune)
        drumFreq = drumTarget * 3f // the "thump": pitch falls from 3× to the body note
        bodyEnv = vel * (1f - 0.8f * tune)
        bodyDecay = decay(0.3f * (1f - 0.7f * tune) * (1f + 2f * bend))
        noiseEnv = vel * (0.1f + 0.9f * tune)
        noiseDecay = decay(0.04f + 0.12f * (1f - tune) + 0.2f * bend)
    }

    /** xorshift: cheaper than Random on the audio thread. */
    private fun noise(): Float {
        seed = seed xor (seed shl 13)
        seed = seed xor (seed ushr 17)
        seed = seed xor (seed shl 5)
        return seed / 2147483648f
    }

    companion object {
        private const val TAU = (2 * PI).toFloat()

        private fun wrap(p: Float) = if (p >= 1f) p - 1f else p

        /** Band-limited saw (polyBLEP) — a naive saw aliases badly at high stretch. */
        private fun saw(p: Float, dt: Float): Float {
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
    }
}
