import Foundation

/// One instrument voice, driven by gesture frames (`Frame`). Audio thread only; port of Android `Voice.kt`.
///
/// Melodic modes: two detuned saws (+ sub for bass) → drive (bend) → resonant low-pass (tilt) → amp.
/// Drums: a pitch-swept sine body + high-passed noise per `Frame.evHit`; shaking adds a shaker.
final class Voice {
    private let sr: Float
    private let pitchGlide: Float
    private let attack: Float
    private let release: Float
    private let paramGlide: Float
    private let sweepGlide: Float

    // tone
    private var freq: Float = 110
    private var amp: Float = 0
    private var cutoff: Float = 1000
    private var drive: Float = 1
    private var damping: Float = 1.4
    private var phase1: Float = 0
    private var phase2: Float = 0
    private var phaseSub: Float = 0
    private var vibPhase: Float = 0
    private var wobPhase: Float = 0

    // Zavalishin TPT state-variable filter
    private var ic1: Float = 0
    private var ic2: Float = 0
    private var g: Float = 0.1

    // drum
    private var drumTarget: Float = 60
    private var drumFreq: Float = 60
    private var drumPhase: Float = 0
    private var bodyEnv: Float = 0
    private var bodyDecay: Float = 0
    private var noiseEnv: Float = 0
    private var noiseDecay: Float = 0
    private var noiseLp: Float = 0
    private var seed: Int32 = 22222

    init(sampleRate: Float) {
        sr = sampleRate
        func glide(_ seconds: Float) -> Float { 1 - expf(-1 / (seconds * sampleRate)) }
        pitchGlide = glide(0.012)
        attack = glide(0.005)
        release = glide(0.06)
        paramGlide = glide(0.03)
        sweepGlide = glide(0.03)
    }

    private func decay(_ seconds: Float) -> Float { expf(-1 / (seconds * sr)) }

    /// Renders `count` samples from the frame at `f` and ADDS them into `out`.
    func render(_ out: UnsafeMutablePointer<Float>, _ count: Int, _ f: UnsafePointer<Float>, _ mode: Mode) {
        let t = f[Frame.tension]
        let b = f[Frame.bend]
        let gate = f[Frame.gate] > 0.5
        let tiltX = f[Frame.tiltX]
        let tiltY = f[Frame.tiltY]
        let sh = f[Frame.shake]

        if f[Frame.event] == Frame.evHit && mode == .drums { hit(f[Frame.evA], f[Frame.evB], b) }

        let bass = mode == .bass
        let targetFreq = mode.freq(t)
        let targetAmp: Float = !gate || mode == .drums ? 0 : bass ? 0.5 + 0.5 * t : 0.25 + 0.75 * t
        let bright = (tiltX + 1) / 2 // 0 = left edge down, 1 = right edge down
        let baseCutoff: Float = bass ? 60 * powf(2, bright * 5) : 150 * powf(2, bright * 6)
        let targetCutoff = min(baseCutoff * (1 + 2 * sh), sr * 0.45)
        let targetDrive = 1 + 5 * b
        let targetDamping: Float = bass ? 1.4 - 0.9 * b : 1.4 - 1.25 * b // lower = more resonance
        let vibDepth = 0.6 * tiltY // semitones
        let wobDepth = 1.5 * sh // semitones
        let noiseHp = 0.1 + 0.5 * bright // higher = thinner, brighter noise
        let shaker: Float = mode == .drums ? 0.3 * sh * sh : 0
        let toneIdle = targetAmp == 0 && amp < 1e-4

        for i in 0..<count {
            var s: Float = 0

            if !toneIdle {
                freq += (targetFreq - freq) * pitchGlide
                amp += (targetAmp - amp) * (targetAmp > amp ? attack : release)
                cutoff += (targetCutoff - cutoff) * paramGlide
                drive += (targetDrive - drive) * paramGlide
                damping += (targetDamping - damping) * paramGlide

                vibPhase = Voice.wrap(vibPhase + 5.5 / sr)
                wobPhase = Voice.wrap(wobPhase + 11 / sr)
                let semis = vibDepth * sinf(Voice.tau * vibPhase) + wobDepth * sinf(Voice.tau * wobPhase)
                let fr = freq * powf(2, semis / 12)

                let dt1 = fr * 1.004 / sr
                let dt2 = fr * 0.996 / sr
                phase1 = Voice.wrap(phase1 + dt1)
                phase2 = Voice.wrap(phase2 + dt2)
                var x = 0.5 * (Voice.saw(phase1, dt1) + Voice.saw(phase2, dt2))
                if bass {
                    phaseSub = Voice.wrap(phaseSub + fr * 0.5 / sr)
                    x = 0.5 * x + 0.7 * sinf(Voice.tau * phaseSub)
                }
                x = tanhf(x * drive) / max(tanhf(drive), 0.5)

                if i & 31 == 0 { g = tanf(Float.pi * cutoff / sr) } // tan is costly
                let a1 = 1 / (1 + g * (g + damping))
                let v1 = a1 * (ic1 + g * (x - ic2))
                let v2 = ic2 + g * v1
                ic1 = 2 * v1 - ic1
                ic2 = 2 * v2 - ic2

                s += v2 * amp * (1 - 0.3 * sh * abs(sinf(Voice.tau * wobPhase)))
            }

            if bodyEnv > 1e-4 || noiseEnv > 1e-4 || shaker > 0 {
                drumFreq += (drumTarget - drumFreq) * sweepGlide
                drumPhase = Voice.wrap(drumPhase + drumFreq / sr)
                s += sinf(Voice.tau * drumPhase) * bodyEnv
                bodyEnv *= bodyDecay

                let n = noise()
                noiseLp += (n - noiseLp) * (1 - noiseHp)
                s += (n - noiseLp) * (0.6 * noiseEnv + shaker)
                noiseEnv *= noiseDecay
            }

            out[i] += s
        }
    }

    /// tune 0 = kick (low, no noise) … 1 = hat (high, mostly noise); bend lengthens the ring.
    private func hit(_ tune: Float, _ vel: Float, _ bend: Float) {
        drumTarget = Mode.drums.freq(tune)
        drumFreq = drumTarget * 3 // the "thump": pitch falls from 3× to the body note
        bodyEnv = vel * (1 - 0.8 * tune)
        bodyDecay = decay(0.3 * (1 - 0.7 * tune) * (1 + 2 * bend))
        noiseEnv = vel * (0.1 + 0.9 * tune)
        noiseDecay = decay(0.04 + 0.12 * (1 - tune) + 0.2 * bend)
    }

    /// xorshift, as in Kotlin (Int shifts wrap, `ushr` is a logical shift).
    private func noise() -> Float {
        seed ^= seed &<< 13
        seed ^= Int32(bitPattern: UInt32(bitPattern: seed) >> 17)
        seed ^= seed &<< 5
        return Float(seed) / 2147483648
    }

    private static let tau = 2 * Float.pi

    private static func wrap(_ p: Float) -> Float { p >= 1 ? p - 1 : p }

    /// Band-limited saw (polyBLEP) — a naive saw aliases badly at high stretch.
    private static func saw(_ p: Float, _ dt: Float) -> Float {
        var v = 2 * p - 1
        if p < dt {
            let t = p / dt
            v -= t + t - t * t - 1
        } else if p > 1 - dt {
            let t = (p - 1) / dt
            v -= t * t + t + t + 1
        }
        return v
    }
}
