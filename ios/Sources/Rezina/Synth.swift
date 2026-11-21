import Foundation

// The instruments and the master bus, one class per `Mode`; port of Android `Synth.kt`. They were chosen
// by ear on the comparison page docs/sound-lab.html, whose JavaScript is the reference: keep these
// per-sample formulas identical to it and to Kotlin. The master is the page's "juicy" one. Audio thread only.

let tau = 2 * Float.pi
private let semitone: Float = 0.05776227 // ln 2 / 12: 2^(x/12) == exp(x * semitone)

func glide(_ seconds: Float, _ sr: Float) -> Float { 1 - expf(-1 / (seconds * sr)) }
func decay(_ seconds: Float, _ sr: Float) -> Float { expf(-1 / (seconds * sr)) }
@inline(__always) func wrap(_ p: Float) -> Float { p >= 1 ? p - 1 : p }

/// Band-limited saw (polyBLEP).
@inline(__always) func saw(_ p: Float, _ dt: Float) -> Float {
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

/// Band-limited square, as the difference of two saws half a cycle apart.
@inline(__always) func sqr(_ p: Float, _ dt: Float) -> Float { 0.5 * (saw(p, dt) - saw(p >= 0.5 ? p - 0.5 : p + 0.5, dt)) }

/// xorshift: cheaper than a system random on the audio thread.
struct Noise {
    private var seed: Int32 = 22222
    mutating func next() -> Float {
        seed ^= seed << 13
        seed ^= Int32(bitPattern: UInt32(bitPattern: seed) >> 17)
        seed ^= seed << 5
        return Float(seed) / 2147483648
    }
}

/// Zavalishin TPT state-variable filter: `run` returns the low-pass; `bp` and `hp` hold the other outputs.
struct Svf {
    private let sr: Float
    private var a: Float = 0
    private var b: Float = 0
    private var g: Float = 0.1
    var k: Float = 1.4
    private(set) var bp: Float = 0
    private(set) var hp: Float = 0

    init(_ sr: Float) { self.sr = sr }

    mutating func set(_ fc: Float, _ k: Float) {
        g = tanf(Float.pi * min(max(fc, 10), sr * 0.45) / sr)
        self.k = k
    }

    @inline(__always) mutating func run(_ x: Float) -> Float {
        let a1 = 1 / (1 + g * (g + k))
        let v1 = a1 * (a + g * (x - b))
        let v2 = b + g * v1
        a = 2 * v1 - a
        b = 2 * v2 - b
        bp = v1
        hp = x - k * v1 - v2
        return v2
    }
}

/// A fixed-size float buffer for the audio thread (no array copy-on-write or bounds checks there).
final class FloatBuf {
    let n: Int
    let b: UnsafeMutablePointer<Float>
    init(_ n: Int) {
        self.n = max(n, 1)
        b = .allocate(capacity: self.n)
        b.initialize(repeating: 0, count: self.n)
    }
    deinit { b.deallocate() }
}

/// Ping-pong echo with a darkened feedback path; the delay time can change (tempo).
final class PingPong {
    private let l: FloatBuf
    private let r: FloatBuf
    private let fb: Float
    private let c: Float
    private var w = 0
    private var lp: Float = 0
    private(set) var outL: Float = 0
    private(set) var outR: Float = 0
    var len: Int { didSet { len = min(max(len, 1), l.n - 1) } }

    init(_ sr: Float, maxSeconds: Float, fb: Float, toneHz: Float) {
        l = FloatBuf(Int(maxSeconds * sr) + 1)
        r = FloatBuf(l.n)
        self.fb = fb
        c = glide(1 / (tau * toneHz), sr)
        len = l.n - 1
    }

    @inline(__always) func run(_ x: Float) {
        var ri = w - len
        if ri < 0 { ri += l.n }
        let yl = l.b[ri], yr = r.b[ri]
        lp += (yr - lp) * c
        l.b[w] = x + lp * fb
        r.b[w] = yl * fb
        w += 1
        if w == l.n { w = 0 }
        outL = yl
        outR = yr
    }
}

/// Small Freeverb: 4 combs + 2 allpasses per side.
final class Reverb {
    private final class Buf {
        let ring: FloatBuf
        var i = 0
        var f: Float = 0
        init(_ n: Int) { ring = FloatBuf(max(8, n)) }
    }

    private let fb: Float
    private let damp: Float
    private let cl: [Buf], cr: [Buf], al: [Buf], ar: [Buf]
    private(set) var outL: Float = 0
    private(set) var outR: Float = 0

    init(_ sr: Float, size: Float, fb: Float, damp: Float) {
        self.fb = fb
        self.damp = damp
        let s = sr / 44100 * size
        func bufs(_ ns: [Float], _ scale: Float) -> [Buf] { ns.map { Buf(Int(($0 * scale).rounded())) } }
        cl = bufs([1557, 1617, 1491, 1422], s)
        cr = bufs([1580, 1640, 1514, 1445], s)
        al = bufs([556, 441], s / size)
        ar = bufs([579, 464], s / size)
    }

    @inline(__always) private func comb(_ c: Buf, _ x: Float) -> Float {
        let y = c.ring.b[c.i]
        c.f = y * (1 - damp) + c.f * damp
        c.ring.b[c.i] = x + c.f * fb
        c.i += 1
        if c.i == c.ring.n { c.i = 0 }
        return y
    }

    @inline(__always) private func allpass(_ a: Buf, _ x: Float) -> Float {
        let y = a.ring.b[a.i]
        a.ring.b[a.i] = x + y * 0.5
        a.i += 1
        if a.i == a.ring.n { a.i = 0 }
        return y - x
    }

    func run(_ l: Float, _ r: Float) {
        let x = (l + r) * 0.08
        var yl: Float = 0, yr: Float = 0
        for j in 0..<4 {
            yl += comb(cl[j], x)
            yr += comb(cr[j], x)
        }
        for j in 0..<2 {
            yl = allpass(al[j], yl)
            yr = allpass(ar[j], yr)
        }
        outL = yl
        outR = yr
    }
}

/// Short delay line with a fractional read (Haas widening, chorus).
final class Line {
    private let buf: FloatBuf
    private let sr: Float
    private var i = 0
    init(_ sr: Float, maxSeconds: Float) {
        self.sr = sr
        buf = FloatBuf(Int((maxSeconds * sr).rounded()) + 2)
    }
    @inline(__always) func push(_ x: Float) {
        buf.b[i] = x
        i += 1
        if i == buf.n { i = 0 }
    }
    @inline(__always) func tap(_ seconds: Float) -> Float {
        var p = Float(i - 1) - seconds * sr
        while p < 0 { p += Float(buf.n) }
        let i0 = Int(p), f = p - Float(i0)
        return buf.b[i0] * (1 - f) + buf.b[(i0 + 1) % buf.n] * f
    }
}

/// Where a drum hit lands: 0 kick, 1 tom/snare, 2 hat; same edges as the grid in `BandView`.
/// How tilt and lift colour a drum kit, per block: `tone` -0.5…+0.5 (0 at level) moves the noise filters,
/// `click` 0.5…1.5 scales the kick's click, `tune` raises the pitched parts up to 3 semitones when upright.
struct DrumColour {
    var tone: Float = 0
    var click: Float = 1
    var tune: Float = 1
    mutating func set(_ c: Ctl) {
        let bright = (c.tiltX + 1) / 2
        tone = bright - 0.5
        click = 0.5 + bright
        tune = powf(2, c.tiltY * 3 / 12)
    }
}

/// Shaker colour from the band held on screen (`Ctl.held`): its length → brightness (the shaker filter
/// ×0.5…×2), its bend → grain (smooth "shh" at 0 … sparse rattles at 1). With no fingers: unchanged.
struct ShakerShape {
    private var env: Float = 0
    private var g: Float = 0
    private var p: Float = 0
    private let gd: Float
    /// Multiplier for the shaker filter's cutoff.
    private(set) var cutoff: Float = 1

    init(_ sr: Float) { gd = decay(0.003, sr) }

    mutating func set(_ c: Ctl, _ sr: Float) {
        g = c.held ? c.bend : 0
        cutoff = c.held ? powf(2, (c.tension - 0.5) * 2) : 1
        p = 3000 * powf(60 / 3000, g) / sr // grains per sample
    }

    /// Per sample: the shaker's level. Draws from the kit's own noise, in the same order as Kotlin and the page.
    @inline(__always) mutating func amp(_ noise: inout Noise) -> Float {
        if g <= 0 { return 1 }
        if noise.next() * 0.5 + 0.5 < p { env = 0.5 + 0.5 * abs(noise.next()) } else { env *= gd }
        return (1 - g) + g * env * 2.5
    }
}

let kickUpTo: Float = 0.33
let snareUpTo: Float = 0.66
func drumZone(_ tune: Float) -> Int { tune < kickUpTo ? 0 : tune < snareUpTo ? 1 : 2 }
/// 0...1 across the tom/snare zone.
func snareSpan(_ tune: Float) -> Float { (tune - kickUpTo) / (snareUpTo - kickUpTo) }

/// What an instrument gets once per block, from a `Frame`.
struct Ctl {
    var gate = false
    /// Fingers are on the band (the raw gate; drums get `gate` false but use this for the shaker).
    var held = false
    /// The finger just touched: gate rose in this block.
    var on = false
    var freq: Float = 110
    var tension: Float = 0
    var bend: Float = 0
    var tiltX: Float = 0
    var tiltY: Float = 0
    var shake: Float = 0
    var bpm = 100
}

typealias Out = UnsafeMutablePointer<Float>

/// One instrument. `render` ADDS `n` samples in stereo.
protocol Instrument: AnyObject {
    /// A drum hit; returns true for a kick, which the master ducks the other instruments to.
    func hit(_ tune: Float, _ vel: Float, _ bend: Float) -> Bool
    func render(_ l: Out, _ r: Out, _ n: Int, _ c: Ctl, _ gain: Float)
}

extension Instrument {
    func hit(_ tune: Float, _ vel: Float, _ bend: Float) -> Bool { false }
}

/// Pitch glide, amplitude, a per-note envelope, vibrato and shake wobble shared by the melodic voices.
class Melodic: Instrument {
    let sr: Float
    private let pg: Float, att: Float, rel: Float
    private var freq: Float = 0
    private var vp: Float = 0
    private var wp: Float = 0
    var amp: Float = 0
    var env: Float = 0
    var envD: Float = 0
    /// Samples since the voice went quiet; lets echo and reverb tails ring out, then the voice sleeps.
    private var quiet = 0

    init(_ sr: Float, pitchGlide: Float, attack: Float, release: Float) {
        self.sr = sr
        pg = glide(pitchGlide, sr)
        att = glide(attack, sr)
        rel = glide(release, sr)
    }

    /// One sample: glides pitch and amplitude toward the targets; returns the frequency with vibrato and wobble.
    @inline(__always) final func step(_ c: Ctl, _ targetAmp: Float, _ vibDepth: Float) -> Float {
        if freq == 0 { freq = c.freq }
        freq += (c.freq - freq) * pg
        amp += (targetAmp - amp) * (targetAmp > amp ? att : rel)
        env *= envD
        vp = wrap(vp + 5.5 / sr)
        wp = wrap(wp + 11 / sr)
        return freq * expf((vibDepth * sinf(tau * vp) + 1.5 * c.shake * sinf(tau * wp)) * semitone)
    }

    func render(_ l: Out, _ r: Out, _ n: Int, _ c: Ctl, _ gain: Float) {}

    /// True when nothing would be heard: not playing and the tail (`tailSeconds`) has run out.
    final func asleep(_ c: Ctl, _ n: Int, _ tailSeconds: Float) -> Bool {
        if c.gate || amp > 1e-5 {
            quiet = 0
            return false
        }
        if Float(quiet) > tailSeconds * sr { return true }
        quiet += n
        return false
    }
}

/// Bass "growl": three detuned saws → drive → resonant low-pass (+ a little band-pass "honk") → drive again;
/// a clean sine sub under it; the top above ~250 Hz widened by a Haas delay. Raising the phone to upright
/// makes the filter wobble in eighths of the loop tempo.
final class GrowlBass: Melodic {
    private static let detune: [Float] = [1, 1.0065, 0.9938]
    private var p0: Float = 0, p1: Float = 0.33, p2: Float = 0.67
    private var ps: Float = 0
    private var f: Svf
    private var lfo: Float = 0
    private var hlp: Float = 0
    private let hc: Float
    private let haas: FloatBuf
    private var hi = 0
    private let envDecay: Float

    init(_ sr: Float) {
        f = Svf(sr)
        hc = glide(1 / (tau * 250), sr)
        haas = FloatBuf(Int((0.011 * sr).rounded()))
        envDecay = decay(0.25, sr)
        super.init(sr, pitchGlide: 0.02, attack: 0.004, release: 0.06)
    }

    override func render(_ l: Out, _ r: Out, _ n: Int, _ c: Ctl, _ gain: Float) {
        if asleep(c, n, 0.05) { return }
        if c.on {
            env = 1
            envD = envDecay
        }
        let bright = (c.tiltX + 1) / 2
        let base = 110 * powf(2, bright * 4.2)
        // the phone is held at an angle while playing: only the last stretch toward upright wobbles
        let wub = min(max((c.tiltY - 0.8) / 0.2, 0), 1)
        let drv = 1.5 + 5 * c.bend
        let k = 0.95 - 0.55 * c.bend
        let ta: Float = c.gate ? 1 : 0
        let lfoStep = Float(c.bpm) / 60 * 2 / sr
        let d0 = GrowlBass.detune[0] / sr, d1 = GrowlBass.detune[1] / sr, d2 = GrowlBass.detune[2] / sr
        for i in 0..<n {
            let fr = step(c, ta, 0)
            lfo = wrap(lfo + lfoStep)
            let t0 = fr * d0, t1 = fr * d1, t2 = fr * d2
            p0 = wrap(p0 + t0)
            p1 = wrap(p1 + t1)
            p2 = wrap(p2 + t2)
            var x = saw(p0, t0) + saw(p1, t1) + saw(p2, t2)
            x = tanhf(x * 0.4 * drv)
            if i & 7 == 0 {
                let w = (0.5 - 0.5 * cosf(tau * lfo)) * wub * 3 - wub * 1.2
                f.set(base * (1 + 1.5 * env) * powf(2, w), k)
            }
            var y = f.run(x)
            y = tanhf((y + 0.3 * f.bp) * 1.5)
            ps = wrap(ps + fr / sr)
            let sub = 0.55 * sinf(tau * ps)
            hlp += (y - hlp) * hc
            let top = y - hlp
            let topLate = haas.b[hi]
            haas.b[hi] = top
            hi += 1
            if hi == haas.n { hi = 0 }
            l[i] += (y + sub) * amp * gain
            r[i] += (y - top + topLate + sub) * amp * gain
        }
    }
}

/// Lead "pluck": saw + square through a low-pass that snaps open on every touch and falls back, the level
/// dropping to a quieter sustain; a dotted-eighth ping-pong echo (follows the tempo) and a little reverb.
final class PluckLead: Melodic {
    private var p1: Float = 0
    private var p2: Float = 0.5
    private var f: Svf
    private var a2: Float = 0
    private let ad: Float
    private let echo: PingPong
    private let room: Reverb

    init(_ sr: Float) {
        f = Svf(sr)
        ad = decay(0.25, sr)
        echo = PingPong(sr, maxSeconds: 0.75 * 60 / 40, fb: 0.45, toneHz: 4000)
        room = Reverb(sr, size: 1, fb: 0.8, damp: 0.4)
        super.init(sr, pitchGlide: 0.015, attack: 0.002, release: 0.15)
    }

    override func render(_ l: Out, _ r: Out, _ n: Int, _ c: Ctl, _ gain: Float) {
        if asleep(c, n, 6) { return }
        if c.on {
            env = 1
            envD = decay(0.1 + 0.25 * c.bend, sr)
            a2 = 1
        }
        echo.len = Int((0.75 * 60 / Float(c.bpm) * sr).rounded())
        let bright = (c.tiltX + 1) / 2
        let base = 250 * powf(2, bright * 3.5)
        let k = 1 - 0.7 * c.bend
        let ta: Float = c.gate ? 1 : 0
        let drv = 1.2 + 2 * c.bend
        for i in 0..<n {
            let fr = step(c, ta, 0.45 * c.tiltY)
            a2 *= ad
            let d1 = fr / sr, d2 = fr * 1.005 / sr
            p1 = wrap(p1 + d1)
            p2 = wrap(p2 + d2)
            if i & 7 == 0 { f.set(base * powf(2, env * 4), k) }
            let osc = 0.6 * saw(p1, d1) + 0.5 * sqr(p2, d2)
            let y = tanhf(f.run(osc) * drv) * amp * (0.35 + 0.65 * a2)
            echo.run(y)
            room.run(y + 0.6 * echo.outL, y + 0.6 * echo.outR)
            l[i] += (y + 0.38 * echo.outL + 0.25 * room.outL) * gain
            r[i] += (y + 0.38 * echo.outR + 0.25 * room.outR) * gain
        }
    }
}

/// Drums "808": three voices, so a hat no longer cuts the kick. The zones are the ones on screen:
/// kick (tune < 1/3) — a sine with a falling pitch, a click and drive; tom/snare (1/3…2/3) — two tones
/// plus noise, more noise further out; hat (> 2/3) — six detuned squares, high-passed. Bend lengthens
/// the kick and opens the hat. Shaking adds a shaker.
final class Kit808: Instrument {
    private static let hatHz: [Float] = [205.3, 304.4, 369.6, 522.7, 540, 800]

    private let sr: Float
    private var noise = Noise()
    // kick
    private var kp: Float = 0, ke: Float = 0, kpe: Float = 0, kf0: Float = 50, kd: Float = 0, kcl: Float = 0
    private let pd: Float, cd: Float
    // tom / snare
    private var mp1: Float = 0, mp2: Float = 0, mte: Float = 0, mtd: Float = 0, mne: Float = 0, mnd: Float = 0
    private var mf: Float = 150, mu: Float = 0
    private var ms: Svf
    // hat
    private var hp: [Float] = [0, 0, 0, 0, 0, 0]
    private var hatStep: [Float]
    private var he: Float = 0, hd: Float = 0
    private var hs: Svf
    private var shs: Svf
    private var col = DrumColour()
    private var shape: ShakerShape

    init(_ sr: Float) {
        self.sr = sr
        pd = decay(0.028, sr)
        cd = decay(0.0025, sr)
        ms = Svf(sr)
        ms.set(1800, 0.8)
        hs = Svf(sr)
        hs.set(7500, 0.7)
        shs = Svf(sr)
        shs.set(5000, 1)
        shape = ShakerShape(sr)
        hatStep = Kit808.hatHz.map { $0 * 1.7 / sr }
    }

    func hit(_ tune: Float, _ vel: Float, _ bend: Float) -> Bool {
        let zone = drumZone(tune)
        if zone == 0 {
            kf0 = 48 * powf(2, tune * 1.5)
            kp = 0
            ke = vel
            kpe = 1
            kd = decay(0.38 * (1 + 1.5 * bend), sr)
            kcl = vel
            return true
        } else if zone == 1 {
            let u = snareSpan(tune)
            mu = u
            mf = 110 * powf(2, u * 1.3)
            mte = vel
            mtd = decay(0.2 * (1 - 0.5 * u) * (1 + bend), sr)
            mne = vel * u * u
            mnd = decay(0.13 + 0.15 * bend, sr)
            mp1 = 0
            mp2 = 0
        } else {
            he = vel
            hd = decay(0.045 + 0.35 * bend, sr)
        }
        return false
    }

    func render(_ l: Out, _ r: Out, _ n: Int, _ c: Ctl, _ gain: Float) {
        let shaker = 0.35 * c.shake * c.shake
        if ke <= 1e-4 && mte <= 1e-4 && mne <= 1e-4 && he <= 1e-4 && shaker <= 0 { return }
        col.set(c)
        ms.set(1800 * powf(2, col.tone * 2), 0.8)
        hs.set(7500 * powf(2, col.tone * 1.2), 0.7)
        shape.set(c, sr)
        shs.set(5000 * shape.cutoff, 1)
        let tune = col.tune, click = col.click
        for i in 0..<n {
            var left: Float = 0, right: Float = 0
            if ke > 1e-4 {
                kpe *= pd
                kp = wrap(kp + kf0 * tune * (1 + 4 * kpe) / sr)
                let y = tanhf((sinf(tau * kp) * ke + 0.4 * click * noise.next() * kcl) * 2.5) * 0.8
                ke *= kd
                kcl *= cd
                left += y
                right += y
            }
            if mte > 1e-4 || mne > 1e-4 {
                mp1 = wrap(mp1 + mf * tune / sr)
                mp2 = wrap(mp2 + mf * tune * 1.48 / sr)
                let tone = (0.75 * sinf(tau * mp1) + 0.35 * sinf(tau * mp2)) * mte
                _ = ms.run(noise.next())
                let nz = (0.7 * ms.hp + 0.5 * ms.bp) * mne
                let y = tanhf((tone + nz) * 1.6) * 0.75
                mte *= mtd
                mne *= mnd
                let pan = 0.5 - 0.35 * (1 - mu)
                left += y * (1 - pan) * 1.4
                right += y * pan * 1.4
            }
            if he > 1e-4 {
                var x: Float = 0
                for j in 0..<6 {
                    hp[j] = wrap(hp[j] + hatStep[j] * tune)
                    x += hp[j] < 0.5 ? 1 : -1
                }
                _ = hs.run(x / 6 * 0.8 + 0.3 * noise.next())
                let y = hs.hp * he * 0.6
                he *= hd
                left += y * 0.7
                right += y * 1.1
            }
            if shaker > 0 {
                _ = shs.run(noise.next())
                let y = shs.hp * shaker * shape.amp(&noise)
                left += y * 0.6
                right += y
            }
            l[i] += left * gain
            r[i] += right * gain
        }
    }
}

/// Bass "acid": one saw through a resonant low-pass that snaps open on every touch and falls back.
final class AcidBass: Melodic {
    private var f: Svf
    private var p: Float = 0
    private var ps: Float = 0

    init(_ sr: Float) {
        f = Svf(sr)
        super.init(sr, pitchGlide: 0.035, attack: 0.002, release: 0.04)
    }

    override func render(_ l: Out, _ r: Out, _ n: Int, _ c: Ctl, _ gain: Float) {
        if asleep(c, n, 0.05) { return }
        if c.on {
            env = 1
            envD = decay(0.14 + 0.5 * c.bend, sr)
        }
        let bright = (c.tiltX + 1) / 2
        let base = 80 * powf(2, bright * 3.5)
        let envOct = 2.5 + 3 * c.bend
        let k = 0.5 - 0.4 * c.bend
        let ta: Float = c.gate ? 1 : 0
        let drv = 2 + 4 * c.bend
        for i in 0..<n {
            let fr = step(c, ta, 0.3 * c.tiltY)
            let dt = fr / sr
            p = wrap(p + dt)
            ps = wrap(ps + dt)
            if i & 7 == 0 { f.set(base * powf(2, env * envOct), k) }
            let y = tanhf(f.run(saw(p, dt) * 1.2) * drv) * 0.8
            let s = (y + 0.35 * sinf(tau * ps)) * amp * (0.75 + 0.25 * env) * gain
            l[i] += s
            r[i] += s
        }
    }
}

/// Bass "FM": a sine phase-modulated by itself — a bark on the attack and mids a phone speaker can play.
final class FmBass: Melodic {
    private var pc: Float = 0, pm: Float = 0, pm2: Float = 0

    init(_ sr: Float) { super.init(sr, pitchGlide: 0.02, attack: 0.002, release: 0.05) }

    override func render(_ l: Out, _ r: Out, _ n: Int, _ c: Ctl, _ gain: Float) {
        if asleep(c, n, 0.05) { return }
        if c.on {
            env = 1
            envD = decay(0.11 + 0.3 * c.bend, sr)
        }
        let bright = (c.tiltX + 1) / 2
        let idx0 = 0.6 + 2.6 * c.bend + 2.2 * bright
        let ta: Float = c.gate ? 1 : 0
        for i in 0..<n {
            let fr = step(c, ta, 0.3 * c.tiltY)
            pc = wrap(pc + fr / sr)
            pm = wrap(pm + fr / sr)
            pm2 = wrap(pm2 + fr * 2 / sr)
            let idx = idx0 * (0.3 + 0.7 * env)
            let mod = sinf(tau * pm) + 0.35 * env * sinf(tau * pm2)
            let s = tanhf(sinf(tau * pc + idx * mod) * 1.7) * 0.85 * amp * gain
            l[i] += s
            r[i] += s
        }
    }
}

/// Lead "wide": seven detuned saws split left/right, a filter, a 3/16 ping-pong echo and a hall.
final class WideLead: Melodic {
    private static let offset: [Float] = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1]
    /// 1 = mostly left, 0 = mostly right.
    private static let side: [Float] = [1, 0, 1, 0.5, 0, 1, 0]
    private let p: FloatBuf
    private let rat: FloatBuf
    private let wl: FloatBuf, wr: FloatBuf
    private var fl: Svf, fr: Svf
    private let echo: PingPong
    private let room: Reverb
    private let envDecay: Float

    init(_ sr: Float) {
        p = FloatBuf(7)
        for j in 0..<7 { p.b[j] = (Float(j) * 0.618).truncatingRemainder(dividingBy: 1) }
        rat = FloatBuf(7)
        wl = FloatBuf(7)
        wr = FloatBuf(7)
        for j in 0..<7 {
            wl.b[j] = 0.25 + 0.75 * WideLead.side[j]
            wr.b[j] = 1 - 0.75 * WideLead.side[j]
        }
        fl = Svf(sr)
        fr = Svf(sr)
        echo = PingPong(sr, maxSeconds: 0.75 * 60 / 40, fb: 0.38, toneHz: 3500)
        room = Reverb(sr, size: 1.1, fb: 0.84, damp: 0.35)
        envDecay = decay(0.3, sr)
        super.init(sr, pitchGlide: 0.02, attack: 0.01, release: 0.12)
    }

    override func render(_ l: Out, _ r: Out, _ n: Int, _ c: Ctl, _ gain: Float) {
        if asleep(c, n, 6) { return }
        if c.on {
            env = 1
            envD = envDecay
        }
        echo.len = Int((0.75 * 60 / Float(c.bpm) * sr).rounded())
        let bright = (c.tiltX + 1) / 2
        let cents = 14 + 30 * c.bend
        for j in 0..<7 { rat.b[j] = powf(2, WideLead.offset[j] * cents / 1200) / sr }
        let k = 1.1 - 0.6 * c.bend
        let ta: Float = c.gate ? 0.5 + 0.5 * c.tension : 0
        for i in 0..<n {
            let f = step(c, ta, 0.5 * c.tiltY)
            var xl: Float = 0, xr: Float = 0
            for j in 0..<7 {
                let dt = f * rat.b[j]
                p.b[j] = wrap(p.b[j] + dt)
                let s = saw(p.b[j], dt)
                xl += s * wl.b[j]
                xr += s * wr.b[j]
            }
            if i & 15 == 0 {
                let fc = 400 * powf(2, bright * 4.5) * (1 + 1.5 * env)
                fl.set(fc, k)
                fr.set(fc, k)
            }
            let yl = tanhf(fl.run(xl * 0.22) * 1.3) * amp
            let yr = tanhf(fr.run(xr * 0.22) * 1.3) * amp
            echo.run((yl + yr) * 0.5)
            room.run(yl + 0.5 * echo.outL, yr + 0.5 * echo.outR)
            l[i] += (yl + 0.32 * echo.outL + 0.3 * room.outL) * gain
            r[i] += (yr + 0.32 * echo.outR + 0.3 * room.outR) * gain
        }
    }
}

/// Lead "voice": a saw through three vowel formants; tilt moves the vowel U-O-A-E-I, bend opens it toward A.
final class VoiceLead: Melodic {
    /// Formants in Hz: U, O, A, E, I (flattened, 3 per vowel).
    private static let vowels: [Float] = [325, 700, 2530, 450, 800, 2830, 800, 1150, 2900, 400, 1600, 2700, 300, 2300, 3000]
    private static let formantGain: [Float] = [1, 0.7, 0.35]
    private var noise = Noise()
    private var p: Float = 0
    private var bp0: Svf, bp1: Svf, bp2: Svf
    private var v: Float = 1
    private let vg: Float
    private let line: Line
    private var cp: Float = 0
    private let room: Reverb

    init(_ sr: Float) {
        bp0 = Svf(sr)
        bp1 = Svf(sr)
        bp2 = Svf(sr)
        vg = glide(0.05, sr)
        line = Line(sr, maxSeconds: 0.03)
        room = Reverb(sr, size: 1.2, fb: 0.85, damp: 0.3)
        super.init(sr, pitchGlide: 0.03, attack: 0.02, release: 0.12)
    }

    private func formant(_ a: Int, _ fr: Float, _ j: Int) -> Float {
        let lo = VoiceLead.vowels[a * 3 + j], hi = VoiceLead.vowels[(a + 1) * 3 + j]
        return lo * (1 - fr) + hi * fr
    }

    override func render(_ l: Out, _ r: Out, _ n: Int, _ c: Ctl, _ gain: Float) {
        if asleep(c, n, 4) { return }
        let bright = (c.tiltX + 1) / 2
        let tv = min(max(bright * 0.9 + 0.4 * c.bend, 0), 1) * 4
        let ta: Float = c.gate ? 0.6 + 0.4 * c.tension : 0
        let drv = 2 + 2 * c.bend
        let g0 = VoiceLead.formantGain[0], g1 = VoiceLead.formantGain[1], g2 = VoiceLead.formantGain[2]
        for i in 0..<n {
            let f = step(c, ta, 0.15 + 0.5 * c.tiltY)
            let dt = f / sr
            p = wrap(p + dt)
            v += (tv - v) * vg
            if i & 15 == 0 {
                let a = Int(min(max(v, 0), 3.999))
                let fr = v - Float(a)
                bp0.set(formant(a, fr, 0), 0.25)
                bp1.set(formant(a, fr, 1), 0.14)
                bp2.set(formant(a, fr, 2), 0.14)
            }
            let x = saw(p, dt) + 0.06 * noise.next()
            _ = bp0.run(x)
            _ = bp1.run(x)
            _ = bp2.run(x)
            var y = bp0.bp * bp0.k * g0 + bp1.bp * bp1.k * g1 + bp2.bp * bp2.k * g2
            y = tanhf(y * drv) * amp
            line.push(y)
            cp = wrap(cp + 0.6 / sr)
            let ch = line.tap(0.012 + 0.004 * sinf(tau * cp))
            room.run(y, ch)
            l[i] += (y + 0.3 * room.outL) * gain
            r[i] += (0.6 * y + 0.5 * ch + 0.3 * room.outR) * gain
        }
    }
}

/// Drums "hard": a heavily driven kick, a hand clap (three bursts and a tail) over a tom tone, a sharp hat.
final class KitHard: Instrument {
    private let sr: Float
    private var noise = Noise()
    private var kp: Float = 0, ke: Float = 0, kpe: Float = 0, kd: Float = 0, kcl: Float = 0
    private let pd: Float, cd: Float
    /// Samples since the clap started; past 2 s it is silent.
    private var mt = Int.max
    private var mv: Float = 0, mtail: Float = 0.15, mu: Float = 0, mp: Float = 0, mte: Float = 0, mtd: Float = 0, mf: Float = 100
    private var ms: Svf
    private let line: Line
    private var he: Float = 0, hd: Float = 0, hp: Float = 0
    private var hs: Svf
    private var shs: Svf
    private let burst: Float, burstDecay: Float
    private var col = DrumColour()
    private var shape: ShakerShape

    init(_ sr: Float) {
        self.sr = sr
        pd = decay(0.018, sr)
        cd = decay(0.002, sr)
        ms = Svf(sr)
        ms.set(1150, 0.55)
        line = Line(sr, maxSeconds: 0.02)
        hs = Svf(sr)
        hs.set(8500, 0.6)
        shs = Svf(sr)
        shs.set(6000, 1)
        shape = ShakerShape(sr)
        burst = 0.008 * sr
        burstDecay = 0.002 * sr
    }

    func hit(_ tune: Float, _ vel: Float, _ bend: Float) -> Bool {
        switch drumZone(tune) {
        case 0:
            kp = 0
            ke = vel
            kpe = 1
            kd = decay(0.42 * (1 + bend), sr)
            kcl = vel
            return true
        case 1:
            let u = snareSpan(tune)
            mt = 0
            mu = u
            mv = vel
            mtail = 0.12 + 0.2 * bend
            mf = 95 * powf(2, u * 1.1)
            mte = vel * (1 - u)
            mtd = decay(0.22, sr)
            mp = 0
        default:
            he = vel
            hd = decay(0.03 + 0.3 * bend, sr)
        }
        return false
    }

    func render(_ l: Out, _ r: Out, _ n: Int, _ c: Ctl, _ gain: Float) {
        let sh = 0.4 * c.shake * c.shake
        let clapLen = Int(2 * sr)
        if ke <= 1e-4 && mt > clapLen && he <= 1e-4 && sh <= 0 { return }
        col.set(c)
        ms.set(1150 * powf(2, col.tone * 1.6), 0.55)
        hs.set(8500 * powf(2, col.tone), 0.6)
        shape.set(c, sr)
        shs.set(6000 * shape.cutoff, 1)
        let tune = col.tune, click = col.click
        for i in 0..<n {
            var left: Float = 0, right: Float = 0
            if ke > 1e-4 {
                kpe *= pd
                kp = wrap(kp + 46 * tune * (1 + 7 * kpe) / sr)
                let y = tanhf((sinf(tau * kp) * ke + 0.5 * click * kcl * sinf(tau * kp * 37)) * 7) * 0.55
                ke *= kd
                kcl *= cd
                left += y
                right += y
            }
            var clap: Float = 0
            if mt < clapLen {
                let t = Float(mt)
                mt += 1
                let env = t < 3 * burst ? expf(-t.truncatingRemainder(dividingBy: burst) / burstDecay)
                                        : expf(-(t - 3 * burst) / (mtail * sr))
                _ = ms.run(noise.next())
                clap = ms.bp * env * mv * (0.3 + 0.7 * mu) * 1.6
                mp = wrap(mp + mf * tune * (1 + 0.5 * mte) / sr)
                clap += sinf(tau * mp) * mte
                mte *= mtd
            }
            line.push(clap)
            left += clap
            right += 0.6 * clap + 0.5 * line.tap(0.009)
            if sh > 0 {
                _ = shs.run(noise.next())
                let y = shs.hp * sh * shape.amp(&noise)
                left += y * 0.8
                right += y
            }
            if he > 1e-4 {
                hp = wrap(hp + 3970 * tune / sr)
                _ = hs.run(noise.next() * (hp < 0.5 ? 1 : -0.4))
                let y = hs.hp * he * 0.55
                he *= hd
                left += y * 0.8
                right += y
            }
            l[i] += tanhf(left * 1.3) * gain
            r[i] += tanhf(right * 1.3) * gain
        }
    }
}

/// Drums "lo-fi": a soft, warm kit through a gentle "old sampler" — 12 bit at half the sample rate,
/// two soft low-passes at 8 kHz, tape-style saturation — and a small room.
final class KitLofi: Instrument {
    private let sr: Float
    private var noise = Noise()
    private var kp: Float = 0, ke: Float = 0, kpe: Float = 0, kd: Float = 0, kcl: Float = 0
    private let pd: Float, cd: Float
    private var mp: Float = 0, mte: Float = 0, mtd: Float = 0, mne: Float = 0, mnd: Float = 0, mf: Float = 185
    private var ms: Svf
    private var he: Float = 0, hd: Float = 0
    private var hs: Svf, shs: Svf
    private var lpA: Float = 0
    private var col = DrumColour()
    private var shape: ShakerShape
    private var hc = 0
    private var hl: Float = 0, hr: Float = 0, l1: Float = 0, l2: Float = 0, r1: Float = 0, r2: Float = 0
    private let room: Reverb
    /// Samples since the last sound; lets the room ring out, then the kit sleeps.
    private var quiet = Int.max / 2

    init(_ sr: Float) {
        self.sr = sr
        pd = decay(0.04, sr)
        cd = decay(0.004, sr)
        ms = Svf(sr)
        ms.set(2200, 1)
        hs = Svf(sr)
        hs.set(7000, 1.2)
        shs = Svf(sr)
        shs.set(4000, 1.2)
        shape = ShakerShape(sr)
        room = Reverb(sr, size: 0.5, fb: 0.72, damp: 0.5)
    }

    func hit(_ tune: Float, _ vel: Float, _ bend: Float) -> Bool {
        let v = vel * (0.9 + 0.1 * noise.next())
        quiet = 0
        switch drumZone(tune) {
        case 0:
            kp = 0
            ke = v
            kpe = 1
            kd = decay(0.32 * (1 + bend), sr)
            kcl = v
            return true
        case 1:
            let u = snareSpan(tune)
            mf = 150 * powf(2, u * 0.8)
            mte = v * (1 - 0.3 * u)
            mtd = decay(0.09 * (1 + bend), sr)
            mne = v * (0.35 + 0.65 * u)
            mnd = decay(0.16 * (1 + bend), sr)
            mp = 0
        default:
            he = v * 0.7
            hd = decay(0.04 + 0.25 * bend, sr)
        }
        return false
    }

    func render(_ l: Out, _ r: Out, _ n: Int, _ c: Ctl, _ gain: Float) {
        let shaker = 0.3 * c.shake * c.shake
        if shaker > 0 { quiet = 0 }
        if Float(quiet) > 2 * sr { return }
        quiet += n
        col.set(c)
        lpA = glide(1 / (tau * 8000 * powf(2, col.tone * 2)), sr)
        ms.set(2200 * powf(2, col.tone * 1.4), 1)
        hs.set(7000 * powf(2, col.tone), 1.2)
        shape.set(c, sr)
        shs.set(4000 * shape.cutoff, 1.2)
        let tune = col.tune, click = col.click
        for i in 0..<n {
            var x: Float = 0, top: Float = 0
            if ke > 1e-4 {
                kpe *= pd
                kp = wrap(kp + 52 * tune * (1 + 1.5 * kpe) / sr)
                x += tanhf((sinf(tau * kp) * ke + 0.25 * click * noise.next() * kcl) * 1.3)
                ke *= kd
                kcl *= cd
            }
            if mte > 1e-4 || mne > 1e-4 {
                mp = wrap(mp + mf * tune / sr)
                let lp = ms.run(noise.next())
                x += sinf(tau * mp) * mte * 0.8 + (0.9 * ms.bp + 0.2 * lp) * mne
                mte *= mtd
                mne *= mnd
            }
            if he > 1e-4 {
                _ = hs.run(noise.next())
                top += hs.hp * he * 0.5
                he *= hd
            }
            if shaker > 0 {
                _ = shs.run(noise.next())
                top += shs.hp * shaker * shape.amp(&noise)
            }
            let sl = x + 0.8 * top, sR = x + 1.1 * top
            hc += 1
            if hc >= 2 {
                hc = 0
                hl = (sl * 2048 + 0.5).rounded(.down) / 2048 // Math.round, as on the page and in Kotlin
                hr = (sR * 2048 + 0.5).rounded(.down) / 2048
            }
            l1 += (hl - l1) * lpA
            l2 += (l1 - l2) * lpA
            r1 += (hr - r1) * lpA
            r2 += (r1 - r2) * lpA
            let ol = tanhf(l2 * 1.4), or = tanhf(r2 * 1.4)
            room.run(ol, or)
            l[i] += (ol + 0.3 * room.outL) * gain
            r[i] += (or + 0.3 * room.outR) * gain
        }
    }
}

/// Master "juicy": bass and lead duck under every kick (the loop "pumps"), the drums get a small room,
/// a bus compressor glues everything, tanh limits the peaks.
final class Master {
    private static let threshold: Float = 0.3
    private static let ratio: Float = 4
    private let room: Reverb
    private let duckAtt: Float, duckRel: Float, compAtt: Float, compRel: Float
    private var duck: Float = 0
    private var rising = false
    private var env: Float = 0

    init(_ sr: Float) {
        room = Reverb(sr, size: 0.7, fb: 0.75, damp: 0.45)
        duckAtt = glide(0.004, sr)
        duckRel = decay(0.16, sr)
        compAtt = glide(0.008, sr)
        compRel = glide(0.15, sr)
    }

    func render(toneL: Out, toneR: Out, drumL: Out, drumR: Out, _ n: Int, kicked: Bool, outL: Out, outR: Out) {
        if kicked { rising = true }
        let th = Master.threshold
        for i in 0..<n {
            if rising {
                duck += (1 - duck) * duckAtt
                if duck > 0.98 { rising = false }
            } else {
                duck *= duckRel
            }
            let g = 1 - 0.45 * duck
            room.run(drumL[i] * 0.5, drumR[i] * 0.5)
            let l = toneL[i] * g + drumL[i] + 0.22 * room.outL
            let r = toneR[i] * g + drumR[i] + 0.22 * room.outR
            let x = max(abs(l), abs(r))
            env += (x - env) * (x > env ? compAtt : compRel)
            let cg: Float = env > th ? (th + (env - th) / Master.ratio) / env : 1
            outL[i] = tanhf(l * cg * 1.8)
            outR[i] = tanhf(r * cg * 1.8)
        }
    }
}
