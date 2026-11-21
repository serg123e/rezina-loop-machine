package it.automate123.rezina

import kotlin.math.log2
import kotlin.math.pow

/**
 * Which instrument family a [Mode] belongs to: its pitch range and how the screen behaves (drums show
 * hit zones instead of note rings). Stretch 0..1 maps to [octaves] octaves up from [base] Hz,
 * exponentially like a real string.
 */
enum class Kind(private val base: Float, private val octaves: Float) {
    BASS(27.5f, 3.5f), // A0 … ~310 Hz
    DRUMS(45f, 3f), // drum body: kick … high tom
    LEAD(110f, 4f); // A2 … A6

    fun freq(tension: Float): Float = base * 2f.pow(tension * octaves)

    /** Inverse of [freq]: how far to stretch for [freq] Hz. */
    fun tension(freq: Float): Float = log2(freq / base) / octaves
}

/**
 * What the band sounds like on a track. Same gestures, different instrument ([Synth.kt]).
 * The ordinal is stored in session files: only ever APPEND entries. The first three are the sounds
 * old files were saved with as plain Bass / Drums / Lead.
 *
 * [gain] matches the instruments in loudness, as on the comparison page (docs/sound-lab.html):
 * 0.14 / the variant's RMS there × 0.9 (bass), 1 (drums) or 0.65 (lead) × 1.5.
 */
/** [short] fits a track cell; [title] goes on the Sound button and in the readout. */
enum class Mode(val title: String, val short: String, val kind: Kind, val gain: Float) {
    BASS("Growl bass", "Growl", Kind.BASS, 0.323f),
    DRUMS("808 drums", "808", Kind.DRUMS, 0.47f),
    LEAD("Pluck lead", "Pluck", Kind.LEAD, 0.357f),
    ACID_BASS("Acid bass", "Acid", Kind.BASS, 0.521f),
    FM_BASS("FM bass", "FM", Kind.BASS, 0.391f),
    HARD_DRUMS("Hard drums", "Hard", Kind.DRUMS, 0.415f),
    LOFI_DRUMS("Lo-fi drums", "Lo-fi", Kind.DRUMS, 0.364f),
    WIDE_LEAD("Wide lead", "Wide", Kind.LEAD, 0.581f),
    VOICE_LEAD("Voice lead", "Voice", Kind.LEAD, 0.331f);

    val drums get() = kind == Kind.DRUMS

    fun freq(tension: Float): Float = kind.freq(tension)

    fun tension(freq: Float): Float = kind.tension(freq)

    /** The Sound button: through the basses, then the drums, then the leads. */
    fun next(): Mode = ORDER[(ORDER.indexOf(this) + 1) % ORDER.size]

    private companion object {
        val ORDER = listOf(BASS, ACID_BASS, FM_BASS, DRUMS, HARD_DRUMS, LOFI_DRUMS, LEAD, WIDE_LEAD, VOICE_LEAD)
    }
}

/**
 * One snapshot of the player's gesture, taken once per audio block (~4 ms).
 * A track is a flat FloatArray of these, so replaying it re-plays the gesture, not a recording of sound —
 * both for the ear (via [Voice]) and for the eye (the band's shape, drawn as a ghost).
 */
object Frame {
    const val TENSION = 0
    const val BEND = 1
    const val GATE = 2
    const val TILT_X = 3
    const val TILT_Y = 4
    const val SHAKE = 5
    const val EVENT = 6
    const val EV_A = 7
    const val EV_B = 8
    /** where the event happened, 0..1 of view width/height (for drawing) */
    const val EV_X = 9
    const val EV_Y = 10
    /** band shape for drawing: point count, then x,y pairs normalised to 0..1 of the view */
    const val COUNT = 11
    const val PTS = 12
    const val MAX_PTS = 6
    const val SIZE = PTS + 2 * MAX_PTS

    const val EV_NONE = 0f
    /** drum hit: EV_A = tune 0..1, EV_B = loudness */
    const val EV_HIT = 2f
}
