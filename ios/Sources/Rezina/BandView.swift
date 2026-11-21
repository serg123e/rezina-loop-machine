import UIKit

/// The whole screen: looper panel on top, the rubber band below. Port of Android `BandView.kt`.
///
/// Panel: tap a track — select it (tap the selected one — mute/unmute), hold — erase it;
/// «Rec» records the selected track; «Sound» switches its instrument (works on a recorded track too:
/// the gesture is replayed with the new sound); «−» «+» — tempo before the first loop, «♩» — metronome
/// on/off; «Save» writes the loop to a file, «Open» lists saved ones (tap — load, hold — delete).
///
/// Band: fingers are points it passes through — 1 finger: from the peg at the bottom to the finger;
/// 2+ fingers: the two farthest-apart are the ends, the rest bend it. Length → pitch, crookedness →
/// timbre. In drum mode every new finger is a hit.
///
/// Sizes: the Android code is in pixels of a ~1080 px wide phone; here every such constant goes
/// through `px()`, which scales it to this view's width, so the layout keeps its proportions.
final class BandView: UIView {
    private let engine: Engine

    /// Fingers on the band in the order they landed (Android keeps them in a LinkedHashMap).
    private var fingers: [(id: ObjectIdentifier, p: CGPoint)] = []
    private var band: [CGPoint] = []
    /// Touches that landed on the panel: where and when, resolved on lift (tap vs hold).
    private var panelTouches: [ObjectIdentifier: (p: CGPoint, t: TimeInterval)] = [:]

    // layout, set in layoutSubviews
    private var cells = [CGRect](repeating: .zero, count: 4)
    private var recButton = CGRect.zero
    private var modeButton = CGRect.zero
    private var saveButton = CGRect.zero
    private var openButton = CGRect.zero
    private var slowerButton = CGRect.zero
    private var tempoButton = CGRect.zero
    private var fasterButton = CGRect.zero
    private var progress = CGRect.zero
    private var panelBottom: CGFloat = 0
    private var scale: CGFloat = 1

    /// Saved sessions on show over the band, or nil when the list is closed.
    private var browser: [Sessions.Entry]?
    private var listTop: CGFloat { panelBottom + px(110) }
    /// Below the text readout; the note grid is clipped to start here.
    private var gridTop: CGFloat = 0

    private var toastText: String?
    private var toastUntil: CFTimeInterval = 0
    private var link: CADisplayLink?

    init(engine: Engine) {
        self.engine = engine
        super.init(frame: .zero)
        isMultipleTouchEnabled = true
        isOpaque = true
        contentMode = .redraw
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    private func px(_ v: CGFloat) -> CGFloat { v * scale }

    private var peg: CGPoint { CGPoint(x: bounds.width / 2, y: bounds.height * 0.94) }
    private var diagonal: CGFloat { hypot(bounds.width, bounds.height) }

    // MARK: frame clock

    override func didMoveToWindow() {
        super.didMoveToWindow()
        link?.invalidate()
        link = nil
        guard window != nil else { return }
        let l = CADisplayLink(target: Tick(self), selector: #selector(Tick.fire))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        l.add(to: .main, forMode: .common)
        link = l
    }

    /// Breaks the display link → view retain cycle.
    private final class Tick: NSObject {
        weak var view: BandView?
        init(_ v: BandView) { view = v }
        @objc func fire() { view?.setNeedsDisplay() }
    }

    // MARK: layout

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let w = bounds.width
        let h = bounds.height
        scale = w / 1080
        let pad = px(16)
        let top = max(window?.safeAreaInsets.top ?? safeAreaInsets.top, px(60))
        let cellH = h * 0.09
        let n = CGFloat(cells.count)
        let cellW = (w - pad * (n + 1)) / n
        for i in cells.indices {
            let x = pad + CGFloat(i) * (cellW + pad)
            cells[i] = CGRect(x: x, y: top, width: cellW, height: cellH)
        }
        progress = CGRect(x: pad, y: top + cellH + px(14), width: w - 2 * pad, height: px(12))
        let by = progress.maxY + px(14)
        let bh = h * 0.06
        // REC | − | ♩ | + | Sound, widths in shares of the row
        let shares: [CGFloat] = [0.32, 0.1, 0.16, 0.1, 0.32]
        let rowW = w - pad * CGFloat(shares.count + 1)
        var x = pad
        var rects: [CGRect] = []
        for s in shares {
            let r = CGRect(x: x, y: by, width: rowW * s, height: bh)
            rects.append(r)
            x = r.maxX + pad
        }
        recButton = rects[0]
        slowerButton = rects[1]
        tempoButton = rects[2]
        fasterButton = rects[3]
        modeButton = rects[4]
        let sy = recButton.maxY + pad
        saveButton = CGRect(x: pad, y: sy, width: w / 2 - pad / 2 - pad, height: h * 0.045)
        openButton = CGRect(x: w / 2 + pad / 2, y: sy, width: w / 2 - pad / 2 - pad, height: h * 0.045)
        panelBottom = saveButton.maxY + px(16)
    }

    // MARK: touches

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            let p = t.location(in: self)
            let id = ObjectIdentifier(t)
            if browser != nil || p.y < panelBottom {
                panelTouches[id] = (p, t.timestamp)
            } else {
                fingers.append((id, p))
                updateBand()
                if engine.liveMode == .drums {
                    engine.hit(tune: engine.tension.value, vel: 0.6 + 0.4 * engine.shake.value,
                               x: Float(p.x / bounds.width), y: Float(p.y / bounds.height))
                }
            }
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            let id = ObjectIdentifier(t)
            if let i = fingers.firstIndex(where: { $0.id == id }) { fingers[i].p = t.location(in: self) }
        }
        updateBand()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            let id = ObjectIdentifier(t)
            if let (p, start) = panelTouches.removeValue(forKey: id) {
                let hold = t.timestamp - start > BandView.holdSeconds
                if browser != nil { browserTap(p, hold) } else { panelTap(p, hold) }
            }
            if let i = fingers.firstIndex(where: { $0.id == id }) {
                fingers.remove(at: i)
                updateBand()
            }
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            let id = ObjectIdentifier(t)
            panelTouches[id] = nil
            fingers.removeAll { $0.id == id }
        }
        updateBand()
    }

    private func panelTap(_ p: CGPoint, _ hold: Bool) {
        let cell = cells.firstIndex { $0.contains(p) }
        if let c = cell {
            if hold {
                engine.clear(c)
            } else if c == engine.selected.value {
                engine.tracks[c].muted.value.toggle()
            } else {
                engine.selected.value = c
            }
        } else if recButton.contains(p) {
            engine.toggleRecord()
        } else if slowerButton.contains(p) {
            changeTempo(-BandView.tempoStep)
        } else if fasterButton.contains(p) {
            changeTempo(BandView.tempoStep)
        } else if tempoButton.contains(p) {
            engine.metronome.value.toggle()
        } else if modeButton.contains(p) {
            let t = engine.tracks[engine.selected.value]
            t.mode = t.mode.next()
        } else if saveButton.contains(p) {
            save()
        } else if openButton.contains(p) {
            openBrowser()
        }
    }

    private func save() {
        guard let session = engine.snapshot() else {
            return toast(engine.loopLen.value == 0 ? "Nothing to save" : "Finish recording first")
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try Sessions.save(session) }
            DispatchQueue.main.async {
                switch result {
                case let .success(f): self.toast("Saved: \(f.deletingPathExtension().lastPathComponent)")
                case .failure: self.toast("Could not save")
                }
            }
        }
    }

    /// Opens the saved-sessions list over the band; reading files happens off the main thread.
    private func openBrowser() {
        fingers.removeAll()
        updateBand()
        DispatchQueue.global(qos: .userInitiated).async {
            let entries = Sessions.list()
            DispatchQueue.main.async { self.browser = entries }
        }
    }

    private func browserTap(_ p: CGPoint, _ hold: Bool) {
        guard let entries = browser else { return }
        let i = Int(((p.y - listTop) / px(BandView.itemH)).rounded(.down))
        if p.y < listTop || !entries.indices.contains(i) {
            browser = nil // tap outside the list closes it
            return
        }
        let entry = entries[i]
        if hold {
            try? FileManager.default.removeItem(at: entry.file)
            browser = entries.filter { $0.file != entry.file }
            return
        }
        browser = nil
        DispatchQueue.global(qos: .userInitiated).async {
            let s = try? Sessions.load(entry.file)
            DispatchQueue.main.async {
                guard let s else { return self.toast("Could not open") }
                self.toast(self.engine.load(s) ? "Opened: \(entry.title)" : "Busy, try again")
            }
        }
    }

    private func toast(_ text: String) {
        toastText = text
        toastUntil = CACurrentMediaTime() + 2
    }

    private func changeTempo(_ delta: Int) {
        if engine.loopLen.value == 0 && engine.barBlocks.value == 0 {
            engine.bpm.value = min(max(engine.bpm.value + delta, BandView.minBpm), BandView.maxBpm)
        }
    }

    /// Rebuilds the band from the fingers and pushes tension/bend into the engine.
    private func updateBand() {
        band = shape(fingers.map { $0.p })
        let pts = band.prefix(Frame.maxPts)
        for (i, p) in pts.enumerated() {
            engine.shape[1 + 2 * i].value = Float(p.x / bounds.width)
            engine.shape[2 + 2 * i].value = Float(p.y / bounds.height)
        }
        engine.shape[0].value = Float(pts.count)
        if band.count < 2 {
            engine.gate.value = false
            return
        }
        var pathLen: CGFloat = 0
        for i in 1..<band.count { pathLen += dist(band[i - 1], band[i]) }
        let endDist = dist(band[0], band[band.count - 1])
        engine.tension.value = Float(min(max((pathLen - diagonal * BandView.rest) / (diagonal * BandView.span), 0), 1))
        engine.bend.value = pathLen > 1 ? Float(min(max((pathLen - endDist) / pathLen * 4, 0), 1)) : 0
        engine.gate.value = true
    }

    /// Orders points into a band: farthest pair are the ends, the rest sorted along the line between them.
    private func shape(_ pts: [CGPoint]) -> [CGPoint] {
        switch pts.count {
        case 0: return []
        case 1: return [peg, pts[0]]
        default:
            var ai = 0
            var bi = 1
            for p in pts.indices {
                for q in pts.indices where dist(pts[p], pts[q]) > dist(pts[ai], pts[bi]) {
                    ai = p
                    bi = q
                }
            }
            let a = pts[ai]
            let b = pts[bi]
            let dx = b.x - a.x
            let dy = b.y - a.y
            let middle = pts.indices.filter { $0 != ai && $0 != bi }.map { pts[$0] }
                .sorted { ($0.x - a.x) * dx + ($0.y - a.y) * dy < ($1.x - a.x) * dx + ($1.y - a.y) * dy }
            return [a] + middle + [b]
        }
    }

    // MARK: drawing

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        BandView.bg.setFill()
        ctx.fill(bounds)
        drawPanel(ctx)

        drawNoteGrid(ctx)
        circle(ctx, peg, px(18), .gray)
        drawGhosts(ctx)
        for f in fingers { circle(ctx, f.p, px(90), UIColor(white: 1, alpha: 70 / 255)) }

        let t = engine.tension.value
        drawBand(ctx, band, t, BandView.hot(t))

        let mode = engine.liveMode
        let sound: String
        if !engine.gate.value {
            sound = "—"
        } else if mode == .drums {
            sound = BandView.drumZones.first { t < $0.upTo }!.name
        } else {
            let f = mode.freq(t)
            sound = String(format: "%6.1f Hz  ", f) + BandView.noteName(f)
        }
        let lines = [
            "\(mode.title): \(sound)",
            String(format: "stretch %4.2f  bend %4.2f", t, engine.bend.value),
            String(format: "tilt ↔ %5.2f  ↕ %4.2f  shake %4.2f", engine.tiltX.value, engine.tiltY.value, engine.shake.value),
        ]
        let hud = UIFont.monospacedSystemFont(ofSize: px(36), weight: .regular)
        for (i, s) in lines.enumerated() {
            text(s, px(24), panelBottom + px(50) + CGFloat(i) * px(46), hud, .lightGray)
        }
        gridTop = panelBottom + px(50) + CGFloat(lines.count) * px(46)

        if let b = browser { drawBrowser(ctx, b) }
        drawToast(ctx)
    }

    /// Band length (from the peg, one finger) that gives `tension`.
    private func radius(_ tension: Float) -> CGFloat { diagonal * (BandView.rest + BandView.span * CGFloat(tension)) }

    /// Where to put one finger: rings around the peg. Melodic modes — a ring per semitone (C bright and
    /// labelled, other naturals labelled, sharps faint), the sounding note lit; drums — the three zones.
    /// With two or more fingers pitch is the distance between them, so the rings don't apply there.
    private func drawNoteGrid(_ ctx: CGContext) {
        let mode = engine.liveMode
        let c = peg
        ctx.saveGState()
        ctx.clip(to: CGRect(x: 0, y: gridTop, width: bounds.width, height: bounds.height - gridTop))
        let labelFont = UIFont.systemFont(ofSize: px(30))
        if mode == .drums {
            var inner: CGFloat = 0
            for (i, zone) in BandView.drumZones.enumerated() {
                let outer = radius(min(zone.upTo, 1))
                ring(ctx, c, (inner + outer) / 2, outer - inner, BandView.rgb(255, 150, 50, i % 2 == 0 ? 26 : 12))
                // near the inner edge (the outer zone runs off-screen); the first zone's clear of the peg
                labelRing(zone.name, i == 0 ? px(250) : inner + px(70), labelFont, UIColor(white: 1, alpha: 150 / 255))
                inner = outer
            }
        } else {
            let tension = engine.tension.value
            let playing = engine.gate.value && fingers.count == 1 ? roundK(BandView.midi(mode.freq(tension))) : -1
            let lo = Int(ceilf(BandView.midi(mode.freq(0))))
            let hi = Int(floorf(BandView.midi(mode.freq(1))))
            if lo <= hi {
                for m in lo...hi {
                    let r = radius(mode.tension(440 * powf(2, Float(m - 69) / 12)))
                    let name = BandView.notes[m % 12]
                    let natural = name.count == 1
                    if m == playing {
                        ring(ctx, c, r, px(6), BandView.rgb(255, 220, 120, 220))
                    } else if name == "C" {
                        ring(ctx, c, r, px(3), UIColor(white: 1, alpha: 110 / 255))
                    } else if natural {
                        ring(ctx, c, r, px(2), UIColor(white: 1, alpha: 45 / 255))
                    } else {
                        ring(ctx, c, r, px(1), UIColor(white: 1, alpha: 18 / 255))
                    }
                    if natural || m == playing {
                        let a: CGFloat = m == playing ? 255 : name == "C" ? 200 : 110
                        labelRing("\(name)\(m / 12 - 1)", r, labelFont, UIColor(white: 1, alpha: a / 255))
                    }
                }
            }
        }
        ctx.restoreGState()
    }

    /// Labels a ring where it meets the left edge — away from the band, which mostly runs up from the peg;
    /// rings too small to reach the edge get the label at their leftmost point.
    private func labelRing(_ s: String, _ r: CGFloat, _ font: UIFont, _ color: UIColor) {
        let labelX = px(BandView.labelX)
        let dx = peg.x - labelX
        let y = r > dx ? peg.y - (r * r - dx * dx).squareRoot() : peg.y
        let x = r > dx ? labelX : peg.x - r + px(8)
        text(s, x, y - px(8), font, color)
    }

    private func drawBrowser(_ ctx: CGContext, _ entries: [Sessions.Entry]) {
        BandView.rgb(16, 16, 22, 235).setFill()
        ctx.fill(CGRect(x: 0, y: panelBottom, width: bounds.width, height: bounds.height - panelBottom))
        let hud = UIFont.monospacedSystemFont(ofSize: px(36), weight: .regular)
        text("Saved loops: tap — open, hold — delete", px(24), panelBottom + px(60), hud, .white)
        if entries.isEmpty { text("Nothing saved yet", px(24), listTop + px(60), hud, .lightGray) }
        let itemH = px(BandView.itemH)
        for (i, entry) in entries.enumerated() {
            let top = listTop + CGFloat(i) * itemH
            if top + itemH > bounds.height { break }
            roundRect(ctx, CGRect(x: px(16), y: top, width: bounds.width - px(32), height: itemH - px(16)), BandView.rgb(42, 42, 52))
            text(entry.title, px(40), top + px(52), .systemFont(ofSize: px(40)), .white)
            text(entry.summary, px(40), top + px(98), .systemFont(ofSize: px(30)), UIColor(white: 1, alpha: 170 / 255))
        }
    }

    private func drawToast(_ ctx: CGContext) {
        guard let s = toastText, CACurrentMediaTime() < toastUntil else {
            toastText = nil
            return
        }
        let font = UIFont.systemFont(ofSize: px(38))
        let size = (s as NSString).size(withAttributes: [.font: font])
        let r = CGRect(x: (bounds.width - size.width) / 2 - px(36), y: bounds.height * 0.84,
                       width: size.width + px(72), height: size.height + px(36))
        let path = UIBezierPath(roundedRect: r, cornerRadius: r.height / 2)
        BandView.rgb(60, 60, 72, 240).setFill()
        path.fill()
        text(s, r.midX, r.minY + px(18) + font.ascender, font, .white, center: true)
    }

    private func drawPanel(_ ctx: CGContext) {
        let pulse = Int(CACurrentMediaTime() * 1000) % 600 < 300
        let label = UIFont.systemFont(ofSize: px(34))
        let small = UIFont.systemFont(ofSize: px(28))
        let sel = engine.selected.value
        let counting = engine.countingIn.value
        for (i, tr) in engine.tracks.enumerated() {
            let r = cells[i]
            let color: UIColor
            if tr.recording.value || counting == i {
                color = pulse ? BandView.rgb(200, 40, 40) : BandView.rgb(140, 30, 30)
            } else if !tr.hasContent.value {
                color = BandView.rgb(42, 42, 52)
            } else if tr.muted.value {
                color = BandView.rgb(30, 30, 34)
            } else {
                color = BandView.dim(BandView.trackColors[i])
            }
            roundRect(ctx, r, color)
            let level = CGFloat(tr.level.value)
            if level > 0 {
                UIColor(white: 1, alpha: 140 / 255).setFill()
                ctx.fill(CGRect(x: r.minX + px(10), y: r.maxY - px(16), width: (r.width - px(20)) * level, height: px(8)))
            }
            if i == sel {
                let p = UIBezierPath(roundedRect: r, cornerRadius: px(16))
                p.lineWidth = px(5)
                UIColor.white.setStroke()
                p.stroke()
            }
            let state: String
            if tr.recording.value { state = "● rec" }
            else if counting == i { state = "count-in" }
            else if !tr.hasContent.value { state = "empty" }
            else if tr.muted.value { state = "muted" }
            else { state = "playing" }
            text("\(i + 1) \(tr.mode.title)", r.midX, r.minY + r.height * 0.4, label, .white, center: true)
            text(state, r.midX, r.minY + r.height * 0.72, small, .white, center: true)
        }

        // metronome ticking: four beat cells, the current one lit; otherwise the loop's progress
        BandView.rgb(42, 42, 52).setFill()
        ctx.fill(progress)
        let loopLen = engine.loopLen.value
        let bar = engine.barBlocks.value
        let beat = bar > 0 ? engine.clickBlocks.value % bar * 4 / bar : -1
        if beat >= 0 {
            let cw = progress.width / 4
            (beat == 0 ? BandView.rgb(255, 210, 80) : BandView.rgb(90, 160, 255)).setFill()
            ctx.fill(CGRect(x: progress.minX + CGFloat(beat) * cw + px(4), y: progress.minY, width: cw - px(8), height: progress.height))
        } else if loopLen > 0 {
            BandView.rgb(90, 160, 255).setFill()
            ctx.fill(CGRect(x: progress.minX, y: progress.minY,
                            width: progress.width * CGFloat(engine.pos.value) / CGFloat(loopLen), height: progress.height))
            // bar lines, so the loop reads as bars of the metronome's grid
            BandView.bg.setFill()
            let bars = engine.loopBeats.value / 4
            if bars > 1 {
                for b in 1..<bars {
                    let x = progress.minX + progress.width * CGFloat(b) / CGFloat(bars)
                    ctx.fill(CGRect(x: x - px(3), y: progress.minY, width: px(6), height: progress.height))
                }
            }
        }

        let selected = engine.tracks[sel]
        let firstTake = loopLen == 0 && selected.recording.value
        let countingSel = counting == sel
        roundRect(ctx, recButton, selected.recording.value || countingSel ? BandView.rgb(170, 40, 40) : BandView.button)
        let font = UIFont.systemFont(ofSize: px(38))
        let recText: String
        if countingSel { recText = "Count-in… \(4 - beat)" }
        else if firstTake && bar > 0 { recText = "■ Stop · bar \(engine.recCount.value / bar + 1)" }
        else if firstTake { recText = String(format: "■ Stop · %.1f s", Float(engine.recCount.value) / engine.blocksPerSecond) }
        else if selected.recording.value { recText = "■ Stop" }
        else if loopLen == 0 { recText = "● Rec" }
        else { recText = String(format: "● Rec · %.1f s", Float(loopLen) / engine.blocksPerSecond) }
        buttonText(recText, recButton, font)

        // tempo can change only before the first loop exists; the metronome toggles any time
        roundRect(ctx, slowerButton, BandView.button)
        roundRect(ctx, fasterButton, BandView.button)
        let tempoColor = UIColor(white: 1, alpha: loopLen == 0 ? 1 : 110 / 255)
        buttonText("−", slowerButton, font, tempoColor)
        buttonText("+", fasterButton, font, tempoColor)
        let metronome = engine.metronome.value
        roundRect(ctx, tempoButton, metronome ? BandView.rgb(90, 80, 30) : BandView.button)
        buttonText(metronome ? "♩ \(engine.bpm.value)" : "♩ off", tempoButton, font)

        roundRect(ctx, modeButton, BandView.button)
        buttonText("Sound: \(selected.mode.title) ▸", modeButton, font)

        roundRect(ctx, saveButton, BandView.button)
        roundRect(ctx, openButton, BandView.button)
        buttonText("Save", saveButton, font)
        buttonText(browser != nil ? "Close" : "Open…", openButton, font)
    }

    /// Replays each audible track's recorded shapes at the playhead: the band as it was held,
    /// a burst where each drum hit landed.
    private func drawGhosts(_ ctx: CGContext) {
        let len = engine.loopLen.value
        if len == 0 { return }
        let now = (engine.pos.value - 1 + len) % len // the block being heard
        let lookBack = min(len, Int(BandView.burstSeconds * engine.blocksPerSecond))
        for (ti, tr) in engine.tracks.enumerated() {
            if !tr.hasContent.value || tr.muted.value || tr.recording.value { continue }
            let f = tr.frames
            let color = BandView.trackColors[ti]
            let o = now * Frame.size
            if f[o + Frame.gate] > 0.5 {
                drawBand(ctx, ghostShape(f + o), f[o + Frame.tension], color, BandView.ghostAlpha)
            }
            for k in 0..<lookBack {
                let e = ((now - k + len) % len) * Frame.size
                if f[e + Frame.event] != Frame.evHit { continue }
                let p = 1 - CGFloat(k) / CGFloat(engine.blocksPerSecond) / CGFloat(BandView.burstSeconds)
                circle(ctx, CGPoint(x: CGFloat(f[e + Frame.evX]) * bounds.width, y: CGFloat(f[e + Frame.evY]) * bounds.height),
                       px(40) + px(120) * (1 - p), color.withAlphaComponent(p * BandView.ghostAlpha))
            }
        }
    }

    private func ghostShape(_ f: UnsafePointer<Float>) -> [CGPoint] {
        let n = min(max(Int(f[Frame.count]), 0), Frame.maxPts)
        return (0..<n).map { i in
            CGPoint(x: CGFloat(f[Frame.pts + 2 * i]) * bounds.width, y: CGFloat(f[Frame.pts + 2 * i + 1]) * bounds.height)
        }
    }

    /// Smooth curve through the points; thinner as it stretches, like real rubber.
    private func drawBand(_ ctx: CGContext, _ pts: [CGPoint], _ tension: Float, _ color: UIColor, _ alpha: CGFloat = 1) {
        if pts.count < 2 { return }
        let path = UIBezierPath()
        path.move(to: pts[0])
        if pts.count > 2 {
            for i in 1..<(pts.count - 1) {
                let p = pts[i]
                let q = pts[i + 1]
                path.addQuadCurve(to: CGPoint(x: (p.x + q.x) / 2, y: (p.y + q.y) / 2), controlPoint: p)
            }
        }
        path.addLine(to: pts[pts.count - 1])
        path.lineWidth = px(36) * (1 - 0.75 * CGFloat(tension))
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        color.withAlphaComponent(alpha).setStroke()
        path.stroke()
    }

    // MARK: drawing helpers

    private func circle(_ ctx: CGContext, _ c: CGPoint, _ r: CGFloat, _ color: UIColor) {
        color.setFill()
        ctx.fillEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
    }

    private func ring(_ ctx: CGContext, _ c: CGPoint, _ r: CGFloat, _ width: CGFloat, _ color: UIColor) {
        color.setStroke()
        ctx.setLineWidth(width)
        ctx.strokeEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
    }

    private func roundRect(_ ctx: CGContext, _ r: CGRect, _ color: UIColor) {
        color.setFill()
        UIBezierPath(roundedRect: r, cornerRadius: px(16)).fill()
    }

    /// Text with its baseline at `y` (as Android `drawText`).
    private func text(_ s: String, _ x: CGFloat, _ y: CGFloat, _ font: UIFont, _ color: UIColor, center: Bool = false) {
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        let str = s as NSString
        let w = center ? str.size(withAttributes: attrs).width : 0
        str.draw(at: CGPoint(x: x - w / 2, y: y - font.ascender), withAttributes: attrs)
    }

    private func buttonText(_ s: String, _ r: CGRect, _ font: UIFont, _ color: UIColor = .white) {
        text(s, r.midX, r.midY + px(13), font, color, center: true)
    }

    private func dist(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }

    // MARK: constants

    private static let holdSeconds: TimeInterval = 0.6
    private static let itemH: CGFloat = 140
    /// Band length at zero stretch and per full stretch, in screen diagonals.
    private static let rest: CGFloat = 0.05
    private static let span: CGFloat = 0.8
    private static let labelX: CGFloat = 20
    /// Drum sound by stretch: up to this tension → this name.
    private static let drumZones: [(upTo: Float, name: String)] = [(0.33, "kick"), (0.66, "tom / snare"), (1.01, "hat")]
    private static let tempoStep = 5
    private static let minBpm = 40
    private static let maxBpm = 200
    private static let burstSeconds: Float = 0.3
    private static let ghostAlpha: CGFloat = 0.6

    private static func rgb(_ r: Int, _ g: Int, _ b: Int, _ a: Int = 255) -> UIColor {
        UIColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: CGFloat(a) / 255)
    }

    private static let bg = rgb(16, 16, 22)
    private static let button = rgb(60, 60, 72)

    /// Track colours: ghost bands and the panel cells share them.
    private static let trackColors = [rgb(70, 210, 120), rgb(255, 150, 50), rgb(80, 150, 255), rgb(200, 100, 255)]

    /// The live band: yellow when slack, red when stretched.
    private static func hot(_ tension: Float) -> UIColor {
        UIColor(hue: CGFloat(40 - 40 * tension) / 360, saturation: 0.85, brightness: 1, alpha: 1)
    }

    private static func dim(_ c: UIColor) -> UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        c.getRed(&r, green: &g, blue: &b, alpha: &a)
        return UIColor(red: r * 2 / 5, green: g * 2 / 5, blue: b * 2 / 5, alpha: 1)
    }

    private static let notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

    private static func midi(_ freq: Float) -> Float { 69 + 12 * log2f(freq / 440) }

    private static func noteName(_ freq: Float) -> String {
        let m = midi(freq)
        let n = roundK(m)
        let cents = Int(((m - Float(n)) * 100).rounded(.towardZero))
        return "\(notes[(n % 12 + 12) % 12])\(n / 12 - 1) \(cents >= 0 ? "+" : "")\(cents)¢"
    }
}
