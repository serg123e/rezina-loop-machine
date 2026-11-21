import Foundation

/// One track's (or the live) sound, driven by gesture frames (`Frame`). Audio thread only; port of Android `Voice.kt`.
///
/// Every voice holds one instrument per `Mode` (see `Synth.swift`); the frame's gesture goes to the one
/// matching the track's mode, the others get a closed gate and ring out, then sleep. So switching a
/// recorded track's mode just switches which instrument plays the gesture.
final class Voice {
    private static let modes = Mode.allCases
    private let instruments: [Instrument]
    private var c = Ctl()
    private var wasGate = false

    init(sampleRate sr: Float) {
        instruments = Mode.allCases.map { m -> Instrument in
            switch m {
            case .bass: return GrowlBass(sr)
            case .acidBass: return AcidBass(sr)
            case .fmBass: return FmBass(sr)
            case .drums: return Kit808(sr)
            case .hardDrums: return KitHard(sr)
            case .lofiDrums: return KitLofi(sr)
            case .lead: return PluckLead(sr)
            case .wideLead: return WideLead(sr)
            case .voiceLead: return VoiceLead(sr)
            }
        }
    }

    /// Renders `n` samples from the frame at `f` and ADDS them in stereo: melodic modes into `toneL`/`toneR`,
    /// drums into `drumL`/`drumR` (the master ducks the first under kicks). Returns true when this block hit a kick.
    func render(toneL: Out, toneR: Out, drumL: Out, drumR: Out, _ n: Int,
                _ f: UnsafePointer<Float>, _ mode: Mode, bpm: Int) -> Bool {
        let gate = f[Frame.gate] > 0.5
        let on = gate && !wasGate
        wasGate = gate
        let tension = f[Frame.tension]
        let shake = f[Frame.shake]
        c.tension = tension
        c.bend = f[Frame.bend]
        c.tiltX = f[Frame.tiltX]
        c.tiltY = f[Frame.tiltY]
        c.bpm = bpm

        var kicked = false
        if mode.isDrums && f[Frame.event] == Frame.evHit {
            kicked = instruments[mode.rawValue].hit(f[Frame.evA], f[Frame.evB], c.bend)
        }
        for i in 0..<instruments.count {
            let m = Voice.modes[i]
            let active = m == mode
            c.held = gate && active
            c.gate = c.held && !m.isDrums
            c.on = on && active
            c.shake = active ? shake : 0
            c.freq = m.freq(tension)
            if m.isDrums {
                instruments[i].render(drumL, drumR, n, c, m.gain)
            } else {
                instruments[i].render(toneL, toneR, n, c, m.gain)
            }
        }
        return kicked
    }
}
