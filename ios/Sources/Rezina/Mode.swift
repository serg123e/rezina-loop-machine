import Foundation

/// What the band sounds like on a track. Same gestures, different instrument.
/// Stretch 0...1 maps to `octaves` octaves up from `base` Hz, exponentially like a real string.
/// Port of Android `Mode.kt`; the raw values are the Kotlin ordinals stored in session files.
enum Mode: Int, CaseIterable {
    case bass = 0 // A0 … ~310 Hz
    case drums = 1 // drum body: kick … high tom
    case lead = 2 // A2 … A6

    var title: String {
        switch self {
        case .bass: return "Bass"
        case .drums: return "Drums"
        case .lead: return "Lead"
        }
    }

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

    func next() -> Mode { Mode(rawValue: (rawValue + 1) % Mode.allCases.count)! }
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
