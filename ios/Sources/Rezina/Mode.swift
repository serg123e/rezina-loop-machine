import Foundation

/// Which instrument family a `Mode` belongs to: its pitch range and how the screen behaves (drums show
/// hit zones instead of note rings). Stretch 0...1 maps to `octaves` octaves up from `base` Hz,
/// exponentially like a real string. Port of Android `Kind` in `Mode.kt`.
enum Kind {
    case bass // A0 … ~310 Hz
    case drums // drum body: kick … high tom
    case lead // A2 … A6

    private var base: Float {
        switch self {
        case .bass: return 27.5
        case .drums: return 45
        case .lead: return 110
        }
    }

    private var octaves: Float {
        switch self {
        case .bass: return 3.5
        case .drums: return 3
        case .lead: return 4
        }
    }

    func freq(_ tension: Float) -> Float { base * powf(2, tension * octaves) }

    /// Inverse of `freq`: how far to stretch for `freq` Hz.
    func tension(_ freq: Float) -> Float { log2f(freq / base) / octaves }
}

/// What the band sounds like on a track. Same gestures, different instrument (`Synth.swift`).
/// Port of Android `Mode.kt`; the raw values are the Kotlin ordinals stored in session files, so only
/// ever APPEND cases. The first three are the sounds old files were saved with as plain Bass / Drums / Lead.
enum Mode: Int, CaseIterable {
    case bass = 0, drums = 1, lead = 2, acidBass = 3, fmBass = 4, hardDrums = 5, lofiDrums = 6, wideLead = 7, voiceLead = 8

    /// The Sound button: through the basses, then the drums, then the leads.
    private static let order: [Mode] = [.bass, .acidBass, .fmBass, .drums, .hardDrums, .lofiDrums, .lead, .wideLead, .voiceLead]

    /// On the Sound button and in the readout.
    var title: String {
        switch self {
        case .bass: return "Growl bass"
        case .acidBass: return "Acid bass"
        case .fmBass: return "FM bass"
        case .drums: return "808 drums"
        case .hardDrums: return "Hard drums"
        case .lofiDrums: return "Lo-fi drums"
        case .lead: return "Pluck lead"
        case .wideLead: return "Wide lead"
        case .voiceLead: return "Voice lead"
        }
    }

    /// Fits a track cell.
    var short: String {
        switch self {
        case .bass: return "Growl"
        case .acidBass: return "Acid"
        case .fmBass: return "FM"
        case .drums: return "808"
        case .hardDrums: return "Hard"
        case .lofiDrums: return "Lo-fi"
        case .lead: return "Pluck"
        case .wideLead: return "Wide"
        case .voiceLead: return "Voice"
        }
    }

    var kind: Kind {
        switch self {
        case .bass, .acidBass, .fmBass: return .bass
        case .drums, .hardDrums, .lofiDrums: return .drums
        case .lead, .wideLead, .voiceLead: return .lead
        }
    }

    var isDrums: Bool { kind == .drums }

    /// Matches the instruments in loudness, as on the comparison page; the same numbers as `Mode.gain` in Kotlin.
    var gain: Float {
        switch self {
        case .bass: return 0.323
        case .acidBass: return 0.521
        case .fmBass: return 0.391
        case .drums: return 0.47
        case .hardDrums: return 0.415
        case .lofiDrums: return 0.364
        case .lead: return 0.357
        case .wideLead: return 0.581
        case .voiceLead: return 0.331
        }
    }

    func freq(_ tension: Float) -> Float { kind.freq(tension) }

    func tension(_ freq: Float) -> Float { kind.tension(freq) }

    func next() -> Mode {
        let i = Mode.order.firstIndex(of: self)!
        return Mode.order[(i + 1) % Mode.order.count]
    }
}

/// One snapshot of the player's gesture, taken once per audio block (192 samples, 4 ms at 48 kHz).
/// A track is a flat Float buffer of these, so replaying it re-plays the gesture, not a recording of
/// sound — both for the ear (via `Voice`) and for the eye (the band's shape, drawn as a ghost).
/// Same layout as Android `Frame` (session files depend on it).
enum Frame {
    static let tension = 0
    static let bend = 1
    static let gate = 2
    static let tiltX = 3
    static let tiltY = 4
    static let shake = 5
    static let event = 6
    static let evA = 7
    static let evB = 8
    /// where the event happened, 0...1 of view width/height (for drawing)
    static let evX = 9
    static let evY = 10
    /// band shape for drawing: point count, then x,y pairs normalised to 0...1 of the view
    static let count = 11
    static let pts = 12
    static let maxPts = 6
    static let size = pts + 2 * maxPts
    /// count + x,y pairs: the part of a frame `Engine.shape` holds
    static let shapeSize = 1 + 2 * maxPts

    static let evNone: Float = 0
    /// drum hit: evA = tune 0...1, evB = loudness
    static let evHit: Float = 2
}
