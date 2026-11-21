package it.automate123.rezina

import kotlin.math.log2
import kotlin.math.pow

/**
 * What the band sounds like on a track. Same gestures, different instrument.
 * Stretch 0..1 maps to [octaves] octaves up from [base] Hz, exponentially like a real string.
 */
enum class Mode(val title: String, private val base: Float, private val octaves: Float) {
    BASS("Bass", 27.5f, 3.5f), // A0 … ~310 Hz
    DRUMS("Drums", 45f, 3f), // drum body: kick … high tom
    LEAD("Lead", 110f, 4f); // A2 … A6

    fun freq(tension: Float): Float = base * 2f.pow(tension * octaves)

    /** Inverse of [freq]: how far to stretch for [freq] Hz. */
    fun tension(freq: Float): Float = log2(freq / base) / octaves

    fun next(): Mode = entries[(ordinal + 1) % entries.size]
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
