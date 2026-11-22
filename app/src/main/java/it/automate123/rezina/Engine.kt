package it.automate123.rezina

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.util.Log
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.sin

/**
 * One looper track: a recorded gesture plus the sound it is played with. [raw] is the take as recorded
 * (what Save writes); [frames] is what plays and what the ghosts show: [raw] on the grid, or a copy.
 */
class Track(@Volatile var mode: Mode, val frames: FloatArray, val raw: FloatArray) {
    @Volatile var hasContent = false
    @Volatile var muted = false
    @Volatile var recording = false
    /** 0..1 — what the track is playing right now, for the UI meter. */
    @Volatile var level = 0f
}

/**
 * Audio thread + looper. The live gesture (the @Volatile controls, written by UI and sensors) always
 * sounds through a live voice with the selected track's [Mode]; while a track records, that gesture
 * is also written into it, one [Frame] per block.
 *
 * Loop length is set by the first take (start → stop); every later take waits for the next bar line,
 * records exactly one loop, then stops by itself. Clearing every track resets the length.
 *
 * A take records into [Track.raw] shifted back by [comp] blocks: what the player hears is late by the
 * output latency and their touch reaches us late too, so everything they play lands late by both.
 *
 * Metronome, while [metronome] is on: before the first loop — one bar of count-in clicks, recording starts
 * on the next downbeat, clicks go on while recording, and on stop the loop is rounded to whole bars.
 * Once a loop exists it clicks over the tracks on the loop's own grid ([loopBeats]).
 *
 * Threads: UI writes controls and selection directly, everything that changes looper state goes
 * through [commands] so only the audio thread mutates it.
 */
class Engine(
    /** The device's native audio burst (AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER). */
    private val burst: Int,
    val sampleRate: Int = AudioTrack.getNativeOutputSampleRate(AudioManager.STREAM_MUSIC),
) {
    val blocksPerSecond = sampleRate.toFloat() / BLOCK
    private val maxBlocks = (MAX_SECONDS * blocksPerSecond).toInt()

    val tracks = DEFAULT_MODES.map { Track(it, FloatArray(maxBlocks * Frame.SIZE), FloatArray(maxBlocks * Frame.SIZE)) }
    @Volatile var selected = 0

    // live gesture
    @Volatile var tension = 0f
    @Volatile var bend = 0f
    @Volatile var gate = false
    @Volatile var tiltX = 0f
    /** Extra tilt from where the band points (BandView); added to [tiltX] in the frame, so it is recorded. */
    @Volatile var aim = 0f
    @Volatile var tiltY = 0f
    @Volatile var shake = 0f
    /** Band shape: [Frame.COUNT]-style layout (count, then x,y pairs, 0..1). Replaced whole, never mutated. */
    @Volatile var shape = FloatArray(1 + 2 * Frame.MAX_PTS)

    // looper position, written by the audio thread, read by the UI
    /** Loop length in blocks; 0 until the first take is done. */
    @Volatile var loopLen = 0
        private set
    @Volatile var pos = 0
        private set
    /** Blocks recorded in the current take. */
    @Volatile var recCount = 0
        private set

    // metronome
    @Volatile var metronome = true
    /** Beats per minute, 4/4. Changes are ignored while the metronome is ticking. */
    @Volatile var bpm = 100
    /** Beats in the loop (whole bars × 4); 0 until the first take is done. */
    @Volatile var loopBeats = 0
        private set
    /** Bar length in blocks for the first take being clicked; 0 otherwise. */
    @Volatile var barBlocks = 0
        private set
    /** Blocks since the first count-in click; the UI derives the beat from it. */
    @Volatile var clickBlocks = 0
        private set
    /** Track waiting for its count-in to end, or -1. */
    @Volatile var countingIn = -1
        private set
    /** Once a loop exists, Rec waits for the next bar line: the track waiting, or -1, and that line's block. */
    @Volatile var armed = -1
        private set
    @Volatile var armedAt = 0
        private set
    /** Block where the current later take started, for the red recorded part on screen. */
    @Volatile var recStart = 0
        private set

    /** Pull hits and note starts toward the sixteenths ([Quantize]); change it with [setGrid]. */
    @Volatile var grid = true
        private set
    /**
     * Blocks a take is shifted back by: [outputLatency] + our block + [TOUCH_S]. Set by the audio thread
     * from the measured latency; tests set it directly.
     */
    @Volatile var comp = 0
    /** Seconds from a sample written to the speaker (AudioTrack.getTimestamp), or -1 until known. */
    @Volatile var outputLatency = -1f
        private set
    /** Share of real time spent rendering, over the last second (1 = the whole budget: crackles). */
    @Volatile var cpu = 0f
        private set
    /** The longest single block render in the last second, ms. */
    @Volatile var peakMs = 0f
        private set

    val liveMode get() = tracks[selected].mode

    private sealed interface Command
    private data class ToggleRecord(val track: Int) : Command
    private data class Clear(val track: Int) : Command
    private class Load(val session: Session) : Command
    private data class SetMode(val track: Int, val mode: Mode) : Command
    private data class SetGrid(val on: Boolean) : Command

    private val commands = ConcurrentLinkedQueue<Command>()
    private val events = ConcurrentLinkedQueue<FloatArray>()

    @Volatile private var running = false
    private var thread: Thread? = null

    fun toggleRecord() = commands.add(ToggleRecord(selected))
    fun clear(track: Int) = commands.add(Clear(track))

    /** Replaces everything with [session] (applied on the audio thread), converted to this phone's rate. */
    fun load(session: Session) = commands.add(Load(session.atRate(sampleRate)))

    /** A track's sound; a recorded track is replayed with it (and put on the grid of its kind). */
    fun setMode(track: Int, mode: Mode) = commands.add(SetMode(track, mode))

    fun setGrid(on: Boolean) {
        grid = on // shown at once; the tracks are rebuilt on the audio thread
        commands.add(SetGrid(on))
    }

    /**
     * Copy of the current loop for saving, or null when there is nothing to save or a take is in
     * progress (the audio thread would be writing the frames being copied).
     */
    fun snapshot(): Session? {
        val len = loopLen
        if (len == 0 || countingIn >= 0 || tracks.any { it.recording }) return null
        return Session(sampleRate, len, loopBeats, bpm, tracks.map { t ->
            Session.TrackData(t.mode, t.muted, if (t.hasContent) t.raw.copyOf(len * Frame.SIZE) else null)
        })
    }

    /** Drum hit, [tune] 0 = kick … 1 = hat, at ([x], [y]) 0..1 of the view. */
    fun hit(tune: Float, vel: Float, x: Float, y: Float) = events.add(floatArrayOf(Frame.EV_HIT, tune, vel, x, y))

    fun start() {
        if (running) return
        running = true
        thread = Thread(::run, "engine").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }
    }

    fun stop() {
        running = false
        thread?.join()
        thread = null
    }

    private fun run() {
        val minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_FLOAT)
        val out = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                    .build()
            )
            .setBufferSizeInBytes(minBuf * 2) // capacity: room for the tuner below to grow into
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        // Latency = how much audio sits queued in the buffer, so start from the smallest that holds
        // one of our blocks plus one device burst, and grow a burst at a time only on underruns.
        out.setBufferSizeInFrames(BLOCK + burst)
        var underruns = 0
        out.play()
        Log.i(TAG, "sr=$sampleRate burst=$burst minBuf=${minBuf / 4} capacity=${out.bufferCapacityInFrames} " +
            "size=${out.bufferSizeInFrames} perf=${out.performanceMode}")

        val ts = AudioTimestamp()
        var written = 0L
        var busyNs = 0L
        var peakNs = 0L
        var measured = 0
        while (running) {
            val t0 = System.nanoTime()
            renderBlock()
            val took = System.nanoTime() - t0
            busyNs += took
            peakNs = maxOf(peakNs, took)
            out.write(mix, 0, mix.size, AudioTrack.WRITE_BLOCKING)
            written += BLOCK
            if (out.underrunCount > underruns) {
                underruns = out.underrunCount
                val size = out.setBufferSizeInFrames(out.bufferSizeInFrames + burst)
                Log.i(TAG, "underrun #$underruns → buffer $size frames")
            }
            if (++measured >= blocksPerSecond) {
                cpu = busyNs / 1e9f
                peakMs = peakNs / 1e6f
                busyNs = 0
                peakNs = 0
                measured = 0
                // what is written but not yet heard: our buffer plus the device's own path to the speaker
                if (out.getTimestamp(ts)) {
                    val heard = ts.framePosition + (System.nanoTime() - ts.nanoTime) * sampleRate / 1_000_000_000L
                    outputLatency = ((written - heard).coerceAtLeast(0) / sampleRate.toFloat())
                }
                // until the timestamp is known, our own buffer is the best guess
                val heardLate = if (outputLatency >= 0) outputLatency else out.bufferSizeInFrames / sampleRate.toFloat()
                comp = Math.round((heardLate + BLOCK / sampleRate.toFloat() + TOUCH_S) * blocksPerSecond)
            }
        }
        out.stop()
        out.release()
    }

    // audio thread state
    private val sr = sampleRate.toFloat()
    private val liveVoice = Voice(sr)
    private val voices = tracks.map { Voice(sr) }
    private val live = FloatArray(Frame.SIZE)
    private val toneL = FloatArray(BLOCK)
    private val toneR = FloatArray(BLOCK)
    private val drumL = FloatArray(BLOCK)
    private val drumR = FloatArray(BLOCK)
    /** The last rendered block, interleaved stereo. */
    val mix = FloatArray(2 * BLOCK)
    private val master = Master(sr)
    private val click = Click(sr)

    /** One block into [mix]: commands, the looper step, the voices. Audio thread only (or a test). */
    fun renderBlock() {
        while (true) apply(commands.poll() ?: break)
        if (countingIn >= 0 && clickBlocks == barBlocks) {
            startRecording(tracks[countingIn])
            countingIn = -1
        }
        if (armed >= 0 && pos == armedAt) {
            startRecording(tracks[armed])
            recStart = pos
            armed = -1
        }

        live[Frame.TENSION] = tension
        live[Frame.BEND] = bend
        live[Frame.GATE] = if (gate) 1f else 0f
        live[Frame.TILT_X] = (tiltX + aim).coerceIn(-1f, 1f)
        live[Frame.TILT_Y] = tiltY
        live[Frame.SHAKE] = shake
        shape.copyInto(live, Frame.COUNT)
        live[Frame.EVENT] = Frame.EV_NONE
        events.poll()?.copyInto(live, Frame.EVENT)

        toneL.fill(0f)
        toneR.fill(0f)
        drumL.fill(0f)
        drumR.fill(0f)
        val tempo = bpm
        var kicked = liveVoice.render(toneL, toneR, drumL, drumR, live, 0, tracks[selected].mode, tempo)

        // the take is shifted back by `comp` blocks; on the first take the earliest ones fall before its start
        val writeBlock = if (loopLen == 0) recCount - comp else ((pos - comp % loopLen) + loopLen) % loopLen
        tracks.forEachIndexed { i, t ->
            when {
                t.recording -> {
                    if (writeBlock >= 0) System.arraycopy(live, 0, t.raw, writeBlock * Frame.SIZE, Frame.SIZE)
                    t.level = levelOf(live, 0)
                }
                t.hasContent && loopLen > 0 -> {
                    val o = pos * Frame.SIZE
                    t.level = if (t.muted) 0f else levelOf(t.frames, o)
                    if (!t.muted && voices[i].render(toneL, toneR, drumL, drumR, t.frames, o, t.mode, tempo)) kicked = true
                }
                else -> t.level = 0f
            }
        }

        when {
            barBlocks > 0 -> click.tick(clickBlocks++.toLong() * BLOCK, barBlocks * BLOCK / 4f)
            metronome && loopLen > 0 -> click.tick(pos.toLong() * BLOCK, loopLen.toFloat() * BLOCK / loopBeats)
        }
        master.render(toneL, toneR, drumL, drumR, kicked, mix)
        click.render(mix)

        if (loopLen > 0) pos = (pos + 1) % loopLen
        tracks.firstOrNull { it.recording }?.let { t ->
            recCount++
            val limit = if (loopLen == 0) maxBlocks else loopLen
            if (recCount >= limit) stopRecording(t)
        }
    }

    private fun apply(c: Command) {
        when (c) {
            is ToggleRecord -> {
                val t = tracks[c.track]
                when {
                    t.recording -> stopRecording(t)
                    countingIn >= 0 || armed >= 0 -> stopClicks() // a second tap while waiting cancels
                    else -> {
                        tracks.filter { it.recording }.forEach(::stopRecording)
                        when {
                            loopLen == 0 && metronome -> {
                                barBlocks = Math.round(4 * 60f / bpm * blocksPerSecond)
                                clickBlocks = 0
                                countingIn = c.track
                            }
                            // a take over a loop starts on the next bar line and lasts one loop
                            loopLen > 0 -> {
                                armed = c.track
                                armedAt = nextBar(pos)
                            }
                            else -> startRecording(t)
                        }
                    }
                }
            }
            is Load -> {
                val s = c.session
                stopClicks()
                tracks.forEachIndexed { i, t ->
                    val d = s.tracks.getOrNull(i)
                    t.recording = false
                    t.mode = d?.mode ?: t.mode
                    t.muted = d?.muted ?: false
                    t.hasContent = d?.frames != null
                    d?.frames?.let { f -> f.copyInto(t.raw, endIndex = minOf(f.size, t.raw.size)) }
                }
                loopLen = minOf(s.loopLen, maxBlocks)
                loopBeats = s.loopBeats
                bpm = s.bpm
                pos = 0
                tracks.forEach(::applyGrid)
            }
            is Clear -> {
                val t = tracks[c.track]
                if (countingIn == c.track || armed == c.track) stopClicks()
                t.recording = false
                t.hasContent = false
                if (tracks.none { it.hasContent || it.recording }) {
                    stopClicks() // no loop, no bar line to wait for
                    loopLen = 0
                    loopBeats = 0
                    pos = 0
                }
            }
            is SetMode -> {
                tracks[c.track].mode = c.mode
                applyGrid(tracks[c.track])
            }
            is SetGrid -> tracks.forEach(::applyGrid)
        }
    }

    /** The first bar line at or after block [p] (bars are whole parts of the loop). */
    private fun nextBar(p: Int): Int {
        val bars = maxOf(1, Math.round(loopBeats / 4f))
        for (k in 0 until bars) {
            val b = Math.round(k.toLong() * loopLen / bars.toFloat())
            if (b >= p) return b
        }
        return 0 // past the last line: the loop's start
    }

    /** Rebuilds what [t] plays from its raw take: on the grid, or a plain copy. */
    private fun applyGrid(t: Track) {
        if (t.hasContent && loopLen > 0) Quantize.apply(t.raw, t.frames, loopLen, loopBeats, t.mode.drums, grid)
    }

    private fun startRecording(t: Track) {
        recCount = 0
        t.recording = true
    }

    private fun stopRecording(t: Track) {
        t.recording = false
        if (loopLen == 0) {
            val bar = barBlocks
            stopClicks()
            // the last `comp` blocks were never written (the take is shifted back by them): silence
            t.raw.fill(0f, maxOf(0, recCount - comp) * Frame.SIZE, recCount * Frame.SIZE)
            // the first take sets the loop; a too-short one is a mis-tap, drop it
            if (recCount < blocksPerSecond * MIN_LOOP_SECONDS) return
            if (bar > 0) {
                val bars = Math.round(recCount.toFloat() / bar).coerceIn(1, maxBlocks / bar)
                // rounded up → the tail was never played: silence, not leftovers of an old take
                if (bars * bar > recCount) t.raw.fill(0f, recCount * Frame.SIZE, bars * bar * Frame.SIZE)
                loopLen = bars * bar
                loopBeats = bars * 4
            } else {
                // free take: fit whole bars near the chosen tempo, so the metronome can still click over it
                loopLen = recCount
                loopBeats = 4 * Math.round(recCount / (4 * 60f / bpm * blocksPerSecond)).coerceAtLeast(1)
            }
            bpm = Math.round(loopBeats * 60f * blocksPerSecond / loopLen)
            pos = 0
        }
        t.hasContent = true
        applyGrid(t)
    }

    /** Cancels any wait for a take: the count-in, or a take armed for the next bar line. */
    private fun stopClicks() {
        countingIn = -1
        barBlocks = 0
        armed = -1
    }

    private fun levelOf(f: FloatArray, o: Int) =
        if (f[o + Frame.GATE] > 0.5f) 0.2f + 0.8f * f[o + Frame.TENSION] else 0f

    /** Metronome tick: a short sine blip, higher on the downbeat. */
    private class Click(private val sr: Float) {
        private var startIn = -1
        private var freq = 0f
        private var phase = 0f
        private var env = 0f
        private val decay = exp(-1f / (0.03f * sr))

        /** Schedules the beat (if any) that falls in the block starting at sample [from] of a grid of [beat] samples. */
        fun tick(from: Long, beat: Float) {
            // beats fall on exact samples of the grid, not on block edges
            var k = ceil(from / beat).toLong()
            while (k * beat < from + BLOCK) {
                startIn = (k * beat - from).toInt()
                freq = if (k % 4 == 0L) 2000f else 1300f
                k++
            }
        }

        /** Adds the click into interleaved stereo [out], after the master. */
        fun render(out: FloatArray) {
            for (i in 0 until BLOCK) {
                if (i == startIn) {
                    env = 0.35f
                    phase = 0f
                    startIn = -1
                }
                if (env < 1e-4f) continue
                phase += freq / sr
                val s = sin(2f * PI.toFloat() * phase) * env
                out[2 * i] += s
                out[2 * i + 1] += s
                env *= decay
            }
            startIn = -1
        }
    }

    companion object {
        /** Frames per audio block: ~4 ms, also the time resolution of recorded gestures. */
        const val BLOCK = 192
        private const val TAG = "rezina"
        private const val MAX_SECONDS = 60
        private const val MIN_LOOP_SECONDS = 0.5f
        /** Touch to our event: a frame or two of the touch screen (an estimate: Android does not report it). */
        private const val TOUCH_S = 0.02f
        private val DEFAULT_MODES = listOf(Mode.BASS, Mode.DRUMS, Mode.LEAD, Mode.LEAD)
    }
}
