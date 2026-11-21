import AVFoundation
import os

/// One looper track: a recorded gesture plus the sound it is played with.
final class Track {
    let frames: UnsafeMutablePointer<Float>
    /// floats in `frames`
    let capacity: Int
    private let rawMode: AtomicInt
    let hasContent = AtomicBool()
    let muted = AtomicBool()
    let recording = AtomicBool()
    /// 0...1 — what the track is playing right now, for the UI meter.
    let level = AtomicFloat()

    init(mode: Mode, capacity: Int) {
        self.capacity = capacity
        rawMode = AtomicInt(mode.rawValue)
        frames = .allocate(capacity: capacity)
        frames.initialize(repeating: 0, count: capacity)
    }

    deinit { frames.deallocate() }

    var mode: Mode {
        get { Mode(rawValue: rawMode.value) ?? .lead }
        set { rawMode.value = newValue.rawValue }
    }
}

/// Kotlin `Math.round(Float)`: half up.
@inline(__always) func roundK(_ x: Float) -> Int { Int((x + 0.5).rounded(.down)) }

/// Audio output + looper; port of Android `Engine.kt`. The live gesture (atomic fields written by the UI
/// and sensors) always sounds through a live voice with the selected track's `Mode`; while a track
/// records, that gesture is also written into it, one `Frame` per block.
///
/// Loop length is set by the first take (start → stop); every later take records exactly one loop
/// starting wherever the playhead is, then stops by itself. Clearing every track resets the length.
///
/// Metronome, while `metronome` is on: before the first loop — one bar of count-in clicks, recording
/// starts on the next downbeat, clicks go on while recording, and on stop the loop is rounded to whole
/// bars. Once a loop exists it clicks over the tracks on the loop's own grid (`loopBeats`).
///
/// Threads: the UI writes controls and selection directly; everything that changes looper state goes
/// through `commands` (a lock-free SPSC ring), so only the render thread mutates it.
///
/// Block size: the synth always runs in blocks of `Engine.block` = 192 samples at a fixed 48 kHz,
/// whatever buffer size iOS asks for in the render callback (the callback drains a one-block buffer).
/// So one frame = 4 ms on every iPhone, and session files match Android phones running at 48 kHz.
final class Engine {
    static let block = 192
    static let sampleRate: Double = 48000
    private static let maxSeconds: Float = 60
    private static let minLoopSeconds: Float = 0.5
    private static let defaultModes: [Mode] = [.bass, .drums, .lead, .lead]
    private static let log = Logger(subsystem: "it.automate123.rezina", category: "audio")

    let blocksPerSecond = Float(Engine.sampleRate) / Float(Engine.block)
    let maxBlocks: Int

    let tracks: [Track]
    let selected = AtomicInt()

    // live gesture
    let tension = AtomicFloat()
    let bend = AtomicFloat()
    let gate = AtomicBool()
    let tiltX = AtomicFloat()
    /// Extra tilt from where the band points (BandView); added to `tiltX` in the frame, so it is recorded.
    let aim = AtomicFloat()
    let tiltY = AtomicFloat()
    let shake = AtomicFloat()
    /// Band shape: count, then x,y pairs, 0...1 (`Frame.count` layout). Writer stores points before the count.
    let shape: [AtomicFloat] = (0..<Frame.shapeSize).map { _ in AtomicFloat() }

    // looper position, written by the audio thread, read by the UI
    /// Loop length in blocks; 0 until the first take is done.
    let loopLen = AtomicInt()
    let pos = AtomicInt()
    /// Blocks recorded in the current take.
    let recCount = AtomicInt()

    // metronome
    let metronome = AtomicBool(true)
    /// Beats per minute, 4/4. Changes are ignored while the metronome is ticking.
    let bpm = AtomicInt(100)
    /// Beats in the loop (whole bars × 4); 0 until the first take is done.
    let loopBeats = AtomicInt()
    /// Bar length in blocks for the first take being clicked; 0 otherwise.
    let barBlocks = AtomicInt()
    /// Blocks since the first count-in click; the UI derives the beat from it.
    let clickBlocks = AtomicInt()
    /// Track waiting for its count-in to end, or -1.
    let countingIn = AtomicInt(-1)

    var liveMode: Mode { tracks[selected.value].mode }

    private enum Command {
        static let toggleRecord: Float = 1
        static let clear: Float = 2
        static let load: Float = 3
    }

    private let commands = Ring(width: 2, capacity: 64)
    /// drum hits: kind, tune, velocity, x, y → copied as is into Frame.event...evY
    private let events = Ring(width: 5, capacity: 64)

    // session being loaded: filled by the UI, copied by the audio thread on the Load command
    private let stageFrames: UnsafeMutablePointer<Float>
    private var stageMode = [Int](repeating: 0, count: 4)
    private var stageMuted = [Bool](repeating: false, count: 4)
    private var stageHas = [Bool](repeating: false, count: 4)
    private var stageCount = 0
    private var stageLoopLen = 0
    private var stageLoopBeats = 0
    private var stageBpm = 0
    private let loadBusy = AtomicBool()

    // audio-thread state
    private let liveVoice: Voice
    private let voices: [Voice]
    private let live: UnsafeMutablePointer<Float>
    /// Bus buffers for one block: melodic voices, drums, and the master's stereo output.
    private let toneL: UnsafeMutablePointer<Float>, toneR: UnsafeMutablePointer<Float>
    private let drumL: UnsafeMutablePointer<Float>, drumR: UnsafeMutablePointer<Float>
    private let mixL: UnsafeMutablePointer<Float>, mixR: UnsafeMutablePointer<Float>
    private let master: Master
    private let cmd: UnsafeMutablePointer<Float>
    private var mixPos = Engine.block
    private let click: Click

    private var audio: AVAudioEngine?
    private var running = false

    init() {
        let blocks = Int(Engine.maxSeconds * Float(Engine.sampleRate) / Float(Engine.block))
        maxBlocks = blocks
        tracks = Engine.defaultModes.map { Track(mode: $0, capacity: blocks * Frame.size) }
        stageFrames = .allocate(capacity: Engine.defaultModes.count * blocks * Frame.size)
        let sr = Float(Engine.sampleRate)
        liveVoice = Voice(sampleRate: sr)
        voices = tracks.map { _ in Voice(sampleRate: sr) }
        live = .allocate(capacity: Frame.size)
        live.initialize(repeating: 0, count: Frame.size)
        func buffer() -> UnsafeMutablePointer<Float> {
            let b = UnsafeMutablePointer<Float>.allocate(capacity: Engine.block)
            b.initialize(repeating: 0, count: Engine.block)
            return b
        }
        toneL = buffer(); toneR = buffer(); drumL = buffer(); drumR = buffer(); mixL = buffer(); mixR = buffer()
        master = Master(sr)
        cmd = .allocate(capacity: commands.width)
        click = Click(sr: sr)

        let nc = NotificationCenter.default
        nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] _ in
            self?.restart("config change")
        }
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let type = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            if type == .ended { self?.restart("interruption ended") }
        }
    }

    // MARK: UI side

    func toggleRecord() { commands.push([Command.toggleRecord, Float(selected.value)]) }
    func clear(_ track: Int) { commands.push([Command.clear, Float(track)]) }

    /// Replaces everything with `s` (applied on the audio thread). Main thread. False while a load is pending.
    @discardableResult
    func load(_ s: Session) -> Bool {
        if loadBusy.value { return false }
        loadBusy.value = true
        stageCount = min(s.tracks.count, tracks.count)
        for i in 0..<stageCount {
            let d = s.tracks[i]
            stageMode[i] = d.mode.rawValue
            stageMuted[i] = d.muted
            stageHas[i] = d.frames != nil
            if let f = d.frames {
                let n = min(f.count, maxBlocks * Frame.size)
                f.withUnsafeBufferPointer { stageFrames.advanced(by: i * maxBlocks * Frame.size).update(from: $0.baseAddress!, count: n) }
            }
        }
        stageLoopLen = s.loopLen
        stageLoopBeats = s.loopBeats
        stageBpm = s.bpm
        if !commands.push([Command.load, 0]) {
            loadBusy.value = false
            return false
        }
        return true
    }

    /// Copy of the current loop for saving, or nil when there is nothing to save or a take is in
    /// progress (the audio thread would be writing the frames being copied).
    func snapshot() -> Session? {
        let len = loopLen.value
        if len == 0 || countingIn.value >= 0 || tracks.contains(where: { $0.recording.value }) { return nil }
        return Session(loopLen: len, loopBeats: loopBeats.value, bpm: bpm.value, tracks: tracks.map { t in
            Session.TrackData(mode: t.mode, muted: t.muted.value,
                              frames: t.hasContent.value ? Array(UnsafeBufferPointer(start: t.frames, count: len * Frame.size)) : nil)
        })
    }

    /// Drum hit, `tune` 0 = kick … 1 = hat, at (`x`, `y`) 0...1 of the view.
    func hit(tune: Float, vel: Float, x: Float, y: Float) { events.push([Frame.evHit, tune, vel, x, y]) }

    func start() {
        if running { return }
        running = true
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default)
            try session.setPreferredSampleRate(Engine.sampleRate)
            try session.setPreferredIOBufferDuration(0.005)
            try session.setActive(true)
        } catch {
            Engine.log.error("audio session: \(error.localizedDescription)")
        }
        let engine = audio ?? makeAudioEngine()
        audio = engine
        do {
            try engine.start()
        } catch {
            Engine.log.error("engine start: \(error.localizedDescription)")
        }
        Engine.log.info("hw sr=\(session.sampleRate) io=\(session.ioBufferDuration * 1000) ms out=\(session.outputLatency * 1000) ms")
    }

    func stop() {
        running = false
        audio?.stop()
    }

    private func restart(_ why: String) {
        guard running, let engine = audio, !engine.isRunning else { return }
        Engine.log.info("restart after \(why)")
        try? engine.start()
    }

    private func makeAudioEngine() -> AVAudioEngine {
        let engine = AVAudioEngine()
        // standard format = non-interleaved: buffers[0] is left, buffers[1] right
        let format = AVAudioFormat(standardFormatWithSampleRate: Engine.sampleRate, channels: 2)!
        let node = AVAudioSourceNode(format: format) { [unowned self] _, _, frameCount, abl in
            let buffers = UnsafeMutableAudioBufferListPointer(abl)
            guard let l = buffers[0].mData else { return noErr }
            let r = buffers.count > 1 ? buffers[1].mData : nil
            self.render(l.assumingMemoryBound(to: Float.self), r?.assumingMemoryBound(to: Float.self), Int(frameCount))
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        return engine
    }

    // MARK: audio thread

    /// Render callback: serves any buffer size from whole 192-sample blocks.
    private func render(_ outL: UnsafeMutablePointer<Float>, _ outR: UnsafeMutablePointer<Float>?, _ count: Int) {
        var n = 0
        while n < count {
            if mixPos == Engine.block {
                processBlock()
                mixPos = 0
            }
            let k = min(Engine.block - mixPos, count - n)
            (outL + n).update(from: mixL + mixPos, count: k)
            outR.map { ($0 + n).update(from: mixR + mixPos, count: k) }
            mixPos += k
            n += k
        }
    }

    private func processBlock() {
        while commands.pop(into: cmd) { apply() }
        let ci = countingIn.value
        if ci >= 0 && clickBlocks.value == barBlocks.value {
            startRecording(tracks[ci])
            countingIn.value = -1
        }

        live[Frame.tension] = tension.value
        live[Frame.bend] = bend.value
        live[Frame.gate] = gate.value ? 1 : 0
        live[Frame.tiltX] = min(max(tiltX.value + aim.value, -1), 1)
        live[Frame.tiltY] = tiltY.value
        live[Frame.shake] = shake.value
        for i in 0..<Frame.shapeSize { live[Frame.count + i] = shape[i].value }
        live[Frame.event] = Frame.evNone
        _ = events.pop(into: live + Frame.event)

        toneL.update(repeating: 0, count: Engine.block) // no array literal here: the render thread must not allocate
        toneR.update(repeating: 0, count: Engine.block)
        drumL.update(repeating: 0, count: Engine.block)
        drumR.update(repeating: 0, count: Engine.block)
        let tempo = bpm.value
        var kicked = liveVoice.render(toneL: toneL, toneR: toneR, drumL: drumL, drumR: drumR, Engine.block,
                                      live, tracks[selected.value].mode, bpm: tempo)

        let writeAt = (loopLen.value == 0 ? recCount.value : pos.value) * Frame.size
        for i in 0..<tracks.count {
            let t = tracks[i]
            if t.recording.value {
                (t.frames + writeAt).update(from: live, count: Frame.size)
                t.level.value = levelOf(live)
            } else if t.hasContent.value && loopLen.value > 0 {
                let f = t.frames + pos.value * Frame.size
                let muted = t.muted.value
                t.level.value = muted ? 0 : levelOf(f)
                if !muted && voices[i].render(toneL: toneL, toneR: toneR, drumL: drumL, drumR: drumR, Engine.block,
                                              f, t.mode, bpm: tempo) {
                    kicked = true
                }
            } else {
                t.level.value = 0
            }
        }

        let bar = barBlocks.value
        if bar > 0 {
            let c = clickBlocks.value
            clickBlocks.value = c + 1
            click.tick(from: c * Engine.block, beat: Float(bar * Engine.block) / 4)
        } else if metronome.value && loopLen.value > 0 {
            click.tick(from: pos.value * Engine.block, beat: Float(loopLen.value) * Float(Engine.block) / Float(loopBeats.value))
        }
        master.render(toneL: toneL, toneR: toneR, drumL: drumL, drumR: drumR, Engine.block, kicked: kicked,
                      outL: mixL, outR: mixR)
        click.render(mixL, mixR, Engine.block)

        if loopLen.value > 0 { pos.value = (pos.value + 1) % loopLen.value }
        for t in tracks where t.recording.value {
            recCount.value += 1
            let limit = loopLen.value == 0 ? maxBlocks : loopLen.value
            if recCount.value >= limit { stopRecording(t) }
            break
        }

    }

    private func apply() {
        switch cmd[0] {
        case Command.toggleRecord:
            let t = tracks[Int(cmd[1])]
            if t.recording.value {
                stopRecording(t)
            } else if countingIn.value >= 0 {
                stopClicks() // second tap during count-in cancels it
            } else {
                for o in tracks where o.recording.value { stopRecording(o) }
                if loopLen.value == 0 && metronome.value {
                    barBlocks.value = roundK(4 * 60 / Float(bpm.value) * blocksPerSecond)
                    clickBlocks.value = 0
                    countingIn.value = Int(cmd[1])
                } else {
                    startRecording(t)
                }
            }
        case Command.load:
            stopClicks()
            for (i, t) in tracks.enumerated() {
                t.recording.value = false
                if i < stageCount {
                    t.mode = Mode(rawValue: stageMode[i]) ?? t.mode
                    t.muted.value = stageMuted[i]
                    t.hasContent.value = stageHas[i]
                    if stageHas[i] {
                        let n = min(stageLoopLen, maxBlocks) * Frame.size
                        t.frames.update(from: stageFrames + i * maxBlocks * Frame.size, count: n)
                    }
                } else {
                    t.muted.value = false
                    t.hasContent.value = false
                }
            }
            loopLen.value = min(stageLoopLen, maxBlocks)
            loopBeats.value = stageLoopBeats
            bpm.value = stageBpm
            pos.value = 0
            loadBusy.value = false
        case Command.clear:
            let i = Int(cmd[1])
            let t = tracks[i]
            if countingIn.value == i { stopClicks() }
            t.recording.value = false
            t.hasContent.value = false
            if !tracks.contains(where: { $0.hasContent.value || $0.recording.value }) {
                loopLen.value = 0
                loopBeats.value = 0
                pos.value = 0
            }
        default:
            break
        }
    }

    private func startRecording(_ t: Track) {
        recCount.value = 0
        t.recording.value = true
    }

    private func stopRecording(_ t: Track) {
        t.recording.value = false
        if loopLen.value == 0 {
            let bar = barBlocks.value
            stopClicks()
            let rec = recCount.value
            // the first take sets the loop; a too-short one is a mis-tap, drop it
            if Float(rec) < blocksPerSecond * Engine.minLoopSeconds { return }
            if bar > 0 {
                let bars = min(max(roundK(Float(rec) / Float(bar)), 1), maxBlocks / bar)
                // rounded up → the tail was never played: silence, not leftovers of an old take
                if bars * bar > rec {
                    (t.frames + rec * Frame.size).update(repeating: 0, count: (bars * bar - rec) * Frame.size)
                }
                loopLen.value = bars * bar
                loopBeats.value = bars * 4
            } else {
                // free take: fit whole bars near the chosen tempo, so the metronome can still click over it
                loopLen.value = rec
                loopBeats.value = 4 * max(roundK(Float(rec) / (4 * 60 / Float(bpm.value) * blocksPerSecond)), 1)
            }
            bpm.value = roundK(Float(loopBeats.value) * 60 * blocksPerSecond / Float(loopLen.value))
            pos.value = 0
        }
        t.hasContent.value = true
    }

    private func stopClicks() {
        countingIn.value = -1
        barBlocks.value = 0
    }

    private func levelOf(_ f: UnsafePointer<Float>) -> Float {
        f[Frame.gate] > 0.5 ? 0.2 + 0.8 * f[Frame.tension] : 0
    }

    /// Metronome tick: a short sine blip, higher on the downbeat.
    private final class Click {
        private let sr: Float
        private var startIn = -1
        private var freq: Float = 0
        private var phase: Float = 0
        private var env: Float = 0
        private let decay: Float

        init(sr: Float) {
            self.sr = sr
            decay = expf(-1 / (0.03 * sr))
        }

        /// Schedules the beat (if any) that falls in the block starting at sample `from` of a grid of `beat` samples.
        func tick(from: Int, beat: Float) {
            // beats fall on exact samples of the grid, not on block edges
            var k = Int(ceilf(Float(from) / beat))
            while Float(k) * beat < Float(from + Engine.block) {
                startIn = Int(Float(k) * beat - Float(from))
                freq = k % 4 == 0 ? 2000 : 1300
                k += 1
            }
        }

        /// Adds the click into both channels, after the master.
        func render(_ outL: UnsafeMutablePointer<Float>, _ outR: UnsafeMutablePointer<Float>, _ count: Int) {
            for i in 0..<count {
                if i == startIn {
                    env = 0.35
                    phase = 0
                    startIn = -1
                }
                if env < 1e-4 { continue }
                phase += freq / sr
                let s = sinf(2 * Float.pi * phase) * env
                outL[i] += s
                outR[i] += s
                env *= decay
            }
            startIn = -1
        }
    }
}
