package it.automate123.rezina

/**
 * One track's (or the live) sound, driven by gesture frames ([Frame]). Audio thread only.
 *
 * Every voice holds one instrument per [Mode] (see Synth.kt); the frame's gesture goes to the one
 * matching the track's mode, the others get a closed gate and ring out, then sleep. So switching a
 * recorded track's mode just switches which instrument plays the gesture.
 */
class Voice(sr: Float) {
    private val instruments: Array<Instrument> = Mode.entries.map { m ->
        when (m) {
            Mode.BASS -> GrowlBass(sr)
            Mode.ACID_BASS -> AcidBass(sr)
            Mode.FM_BASS -> FmBass(sr)
            Mode.DRUMS -> Kit808(sr)
            Mode.HARD_DRUMS -> KitHard(sr)
            Mode.LOFI_DRUMS -> KitLofi(sr)
            Mode.LEAD -> PluckLead(sr)
            Mode.WIDE_LEAD -> WideLead(sr)
            Mode.VOICE_LEAD -> VoiceLead(sr)
        }
    }.toTypedArray()
    private val c = Ctl()
    private var wasGate = false

    /**
     * Renders one block from the frame at [frames]`[off]` and ADDS it in stereo: melodic modes into
     * [toneL]/[toneR], drums into [drumL]/[drumR] (the master ducks the first under kicks).
     * Returns true when this block hit a kick.
     */
    fun render(
        toneL: FloatArray, toneR: FloatArray, drumL: FloatArray, drumR: FloatArray,
        frames: FloatArray, off: Int, mode: Mode, bpm: Int,
    ): Boolean {
        val gate = frames[off + Frame.GATE] > 0.5f
        val on = gate && !wasGate
        wasGate = gate
        val tension = frames[off + Frame.TENSION]
        val shake = frames[off + Frame.SHAKE]
        c.tension = tension
        c.bend = frames[off + Frame.BEND]
        c.tiltX = frames[off + Frame.TILT_X]
        c.tiltY = frames[off + Frame.TILT_Y]
        c.bpm = bpm

        var kicked = false
        if (mode.drums && frames[off + Frame.EVENT] == Frame.EV_HIT) {
            kicked = instruments[mode.ordinal].hit(frames[off + Frame.EV_A], frames[off + Frame.EV_B], c.bend)
        }
        for (i in MODES.indices) { // an index loop: no iterator allocated on the audio thread
            val m = MODES[i]
            val active = m == mode
            c.held = gate && active
            c.gate = c.held && !m.drums
            c.on = on && active
            c.shake = if (active) shake else 0f
            c.freq = m.freq(tension)
            if (m.drums) instruments[m.ordinal].render(drumL, drumR, c, m.gain)
            else instruments[m.ordinal].render(toneL, toneR, c, m.gain)
        }
        return kicked
    }

    private companion object {
        val MODES = Mode.entries.toTypedArray()
    }
}
