// Linux sound check: renders the gestures of Android VoiceTest through the Swift synth and compares
// them with the same page numbers. Run: make soundcheck (in ios/).
import Foundation
func run(_ mode: Mode, _ tx: Float = 0, _ ty: Float = 0) -> (Double, Double) {
    let v = Voice(sampleRate: 48000)
    let n = 192
    let f = UnsafeMutablePointer<Float>.allocate(capacity: Frame.size); f.initialize(repeating: 0, count: Frame.size)
    let b = (0..<4).map { _ in UnsafeMutablePointer<Float>.allocate(capacity: n) }
    let hits: [Int: Float] = [0: 0.1, 60: 0.495, 120: 0.9]
    let freq: Float = mode.kind == .bass ? 55 : mode.kind == .lead ? 329.63 : 60
    var sum = 0.0, diff = 0.0; var pl: Float = 0, pr: Float = 0
    for blk in 0..<250 {
        f[Frame.gate] = mode.isDrums ? 0 : 1; f[Frame.tension] = mode.tension(freq); f[Frame.bend] = 0.3; f[Frame.tiltX] = tx; f[Frame.tiltY] = ty
        f[Frame.event] = Frame.evNone
        if mode.isDrums, let t = hits[blk] { f[Frame.event] = Frame.evHit; f[Frame.evA] = t; f[Frame.evB] = 1 }
        for x in b { x.update(repeating: 0, count: n) }
        _ = v.render(toneL: b[0], toneR: b[1], drumL: b[2], drumR: b[3], n, f, mode, bpm: 100)
        for i in 0..<n { let l = b[0][i] + b[2][i], r = b[1][i] + b[3][i]; sum += Double(l*l + r*r); diff += Double((l-pl)*(l-pl) + (r-pr)*(r-pr)); pl = l; pr = r }
    }
    return ((sum / Double(2 * 250 * n)).squareRoot(), (diff / Double(2 * 250 * n)).squareRoot())
}
let page: [(Mode, [Double])] = [(.bass, [0.2757, 0.00735, 0.2755, 0.01176]), (.acidBass, [0.1961, 0.00938, 0.1983, 0.01261]), (.fmBass, [0.2084, 0.00247, 0.2007, 0.00284]),
 (.lead, [0.1098, 0.01423, 0.1162, 0.01759]), (.wideLead, [0.1227, 0.01447, 0.1248, 0.02156]), (.voiceLead, [0.1209, 0.01296, 0.1496, 0.00901]),
 (.drums, [0.2349, 0.02597, 0.2345, 0.02694]), (.hardDrums, [0.2210, 0.03539, 0.2213, 0.03745]), (.lofiDrums, [0.2457, 0.01031, 0.1842, 0.01487])]
func shaken(_ mode: Mode, _ held: Bool) -> (Double, Double) {
    let v = Voice(sampleRate: 48000)
    let n = 192
    let f = UnsafeMutablePointer<Float>.allocate(capacity: Frame.size); f.initialize(repeating: 0, count: Frame.size)
    let b = (0..<4).map { _ in UnsafeMutablePointer<Float>.allocate(capacity: n) }
    var sum = 0.0, diff = 0.0; var pl: Float = 0, pr: Float = 0
    for _ in 0..<250 {
        f[Frame.gate] = held ? 1 : 0; f[Frame.tension] = held ? 0.8 : 0; f[Frame.bend] = held ? 0.6 : 0.3; f[Frame.shake] = 0.8
        for x in b { x.update(repeating: 0, count: n) }
        _ = v.render(toneL: b[0], toneR: b[1], drumL: b[2], drumR: b[3], n, f, mode, bpm: 100)
        for i in 0..<n { let l = b[0][i] + b[2][i], r = b[1][i] + b[3][i]; sum += Double(l*l + r*r); diff += Double((l-pl)*(l-pl) + (r-pr)*(r-pr)); pl = l; pr = r }
    }
    return ((sum / Double(2 * 250 * n)).squareRoot(), (diff / Double(2 * 250 * n)).squareRoot())
}
// shaking only: free, then with a held band (length 0.8, bend 0.6); the numbers of Android VoiceTest.shakerMatchesThePage
let shakerPage: [(Mode, [Double])] = [(.drums, [0.0482, 0.07284, 0.0451, 0.07150]), (.hardDrums, [0.0668, 0.10298, 0.0610, 0.09977]), (.lofiDrums, [0.0337, 0.02485, 0.0305, 0.02337])]
var failed = false
for (m, ref) in shakerPage {
    let a = shaken(m, false), b = shaken(m, true)
    let got = [a.0, a.1, b.0, b.1]
    let ok = (0..<4).allSatisfy { abs(got[$0] - ref[$0]) < ref[$0] * 0.005 + 1e-4 }
    if !ok { failed = true }
    print("shaker", m, got.map { String(format: "%.5f", $0) }.joined(separator: " "), ok ? "ok" : "MISMATCH")
}
for (m, ref) in page {
    let a = run(m), b = run(m, 0.6, 0.9)
    let got = [a.0, a.1, b.0, b.1]
    let ok = (0..<4).allSatisfy { abs(got[$0] - ref[$0]) < ref[$0] * 0.005 + 1e-4 }
    if !ok { failed = true }
    print(m, got.map { String(format: "%.5f", $0) }.joined(separator: " "), ok ? "ok" : "MISMATCH")
}
exit(failed ? 1 : 0)
