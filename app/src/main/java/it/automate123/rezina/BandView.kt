package it.automate123.rezina

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import android.graphics.Typeface
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.widget.Toast
import java.io.File
import kotlin.concurrent.thread
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log2
import kotlin.math.pow
import kotlin.math.hypot
import kotlin.math.sqrt

/**
 * The whole screen: looper panel on top, the rubber band below.
 *
 * Panel: tap a track — select it (tap the selected one — mute/unmute), hold — erase it;
 * «Rec» records the selected track; «Sound» switches its instrument (works on a recorded track too:
 * the gesture is replayed with the new sound); «−» «+» — tempo before the first loop, «♩» — metronome on/off;
 * «Save» writes the loop to a file, «Open» lists saved ones (tap — load, hold — delete).
 *
 * Band: fingers are points it passes through — 1 finger: from the peg at the bottom to the finger;
 * 2+ fingers: the two farthest-apart are the ends, the rest bend it. Length → pitch, crookedness →
 * timbre. In drum mode every new finger is a hit.
 *
 * Every playing track shows as a ghost band in its own colour, moving exactly as it was played;
 * drum tracks flash where each hit landed.
 */
@SuppressLint("ViewConstructor")
class BandView(context: Context, private val engine: Engine) : View(context) {
    private val fingers = LinkedHashMap<Int, PointF>()
    private var band: List<PointF> = emptyList()

    /** Pointers that landed on the panel: id → where and when, resolved on lift (tap vs hold). */
    private val panelTouches = HashMap<Int, Triple<Float, Float, Long>>()


    // layout, set in onSizeChanged
    private val cells = List(engine.tracks.size) { RectF() }
    private val recButton = RectF()
    private val modeButton = RectF()
    private val saveButton = RectF()
    private val openButton = RectF()
    private val slowerButton = RectF()
    private val tempoButton = RectF()
    private val fasterButton = RectF()
    private val progress = RectF()
    private var panelBottom = 0f

    /** Saved sessions on show over the band, or null when the list is closed. */
    private var browser: List<Sessions.Entry>? = null
    /** Tune of the last drum hit, for the readout. */
    private var lastHit = 0f
    private val sessionsDir = File(context.filesDir, "sessions")
    private val listTop get() = panelBottom + 110f
    /** Below the text readout; the note grid is clipped to start here. */
    private var gridTop = 0f

    private val bandPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 5f
        color = Color.WHITE
    }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 40f
        textAlign = Paint.Align.CENTER
    }
    private val hud = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.LTGRAY
        textSize = 36f
        typeface = Typeface.MONOSPACE
    }
    private val path = Path()
    private val grid = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val gridLabel = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 30f
    }

    private val peg get() = PointF(width / 2f, height * 0.94f)
    private val diagonal get() = hypot(width.toFloat(), height.toFloat())

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val pad = 16f
        val top = 60f
        val cellH = h * 0.09f
        val cellW = (w - pad * (cells.size + 1)) / cells.size
        cells.forEachIndexed { i, r ->
            val x = pad + i * (cellW + pad)
            r.set(x, top, x + cellW, top + cellH)
        }
        progress.set(pad, top + cellH + 14f, w - pad, top + cellH + 26f)
        val by = progress.bottom + 14f
        val bh = h * 0.06f
        // REC | − | ♩ | + | Sound, widths in shares of the row
        val shares = floatArrayOf(0.32f, 0.1f, 0.16f, 0.1f, 0.32f)
        val buttons = listOf(recButton, slowerButton, tempoButton, fasterButton, modeButton)
        val rowW = w - pad * (buttons.size + 1)
        var x = pad
        buttons.forEachIndexed { i, r ->
            r.set(x, by, x + rowW * shares[i], by + bh)
            x = r.right + pad
        }
        val sy = recButton.bottom + pad
        saveButton.set(pad, sy, w / 2f - pad / 2, sy + h * 0.045f)
        openButton.set(w / 2f + pad / 2, sy, w - pad, sy + h * 0.045f)
        panelBottom = saveButton.bottom + 16f
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        val i = e.actionIndex
        val id = e.getPointerId(i)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val x = e.getX(i)
                val y = e.getY(i)
                if (browser != null || y < panelBottom) {
                    panelTouches[id] = Triple(x, y, e.eventTime)
                } else {
                    fingers[id] = PointF(x, y)
                    updateBand()
                    if (engine.liveMode.drums) {
                        // each finger hits by its own distance from the peg, as if it were alone:
                        // the band's tension with several fingers is the distance between them
                        val p = PointF(x, y)
                        engine.aim = aim(listOf(peg, p))
                        lastHit = tensionAt(p)
                        engine.hit(lastHit, 0.6f + 0.4f * engine.shake, x / width, y / height)
                    }
                }
            }
            MotionEvent.ACTION_MOVE -> {
                for (p in 0 until e.pointerCount) fingers[e.getPointerId(p)]?.set(e.getX(p), e.getY(p))
                updateBand()
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
                panelTouches.remove(id)?.let { (x, y, t) ->
                    val hold = e.eventTime - t > HOLD_MS
                    if (browser != null) browserTap(x, y, hold) else panelTap(x, y, hold)
                }
                if (fingers.remove(id) != null) updateBand()
            }
            MotionEvent.ACTION_CANCEL -> {
                fingers.clear()
                panelTouches.clear()
                updateBand()
            }
        }
        return true
    }

    private fun panelTap(x: Float, y: Float, hold: Boolean) {
        val cell = cells.indexOfFirst { it.contains(x, y) }
        when {
            cell >= 0 && hold -> engine.clear(cell)
            cell >= 0 && cell == engine.selected -> engine.tracks[cell].let { it.muted = !it.muted }
            cell >= 0 -> engine.selected = cell
            recButton.contains(x, y) -> engine.toggleRecord()
            slowerButton.contains(x, y) -> changeTempo(-TEMPO_STEP)
            fasterButton.contains(x, y) -> changeTempo(TEMPO_STEP)
            tempoButton.contains(x, y) -> engine.metronome = !engine.metronome
            modeButton.contains(x, y) -> engine.tracks[engine.selected].let { it.mode = it.mode.next() }
            saveButton.contains(x, y) -> save()
            openButton.contains(x, y) -> openBrowser()
        }
    }

    private fun save() {
        val session = engine.snapshot()
            ?: return toast(if (engine.loopLen == 0) "Nothing to save" else "Finish recording first")
        thread {
            val f = Sessions.save(sessionsDir, session)
            post { toast("Saved: ${f.nameWithoutExtension}") }
        }
    }

    /** Opens the saved-sessions list over the band; reading files happens off the UI thread. */
    private fun openBrowser() {
        fingers.clear()
        updateBand()
        thread {
            val entries = Sessions.list(sessionsDir)
            post { browser = entries }
        }
    }

    private fun browserTap(x: Float, y: Float, hold: Boolean) {
        val entries = browser ?: return
        val i = ((y - listTop) / ITEM_H).toInt()
        if (y < listTop || i !in entries.indices) {
            browser = null // tap outside the list closes it
            return
        }
        val entry = entries[i]
        if (hold) {
            entry.file.delete()
            browser = entries - entry
            return
        }
        browser = null
        thread {
            val s = Sessions.load(entry.file)
            engine.load(s)
            post { toast("Opened: ${entry.title}") }
        }
    }

    private fun toast(text: String) = Toast.makeText(context, text, Toast.LENGTH_SHORT).show()

    private fun changeTempo(delta: Int) {
        if (engine.loopLen == 0 && engine.barBlocks == 0) engine.bpm = (engine.bpm + delta).coerceIn(MIN_BPM, MAX_BPM)
    }

    /** Rebuilds the band from the fingers and pushes tension/bend into the engine. */
    private fun updateBand() {
        band = shape(fingers.values.toList())
        engine.shape = FloatArray(1 + 2 * Frame.MAX_PTS).also { s ->
            val pts = band.take(Frame.MAX_PTS)
            s[0] = pts.size.toFloat()
            pts.forEachIndexed { i, p ->
                s[1 + 2 * i] = p.x / width
                s[2 + 2 * i] = p.y / height
            }
        }
        if (band.size < 2) {
            engine.gate = false
            return
        }
        val pathLen = band.zipWithNext { a, b -> dist(a, b) }.sum()
        val endDist = dist(band.first(), band.last())
        engine.tension = ((pathLen - diagonal * REST) / (diagonal * SPAN)).coerceIn(0f, 1f)
        engine.bend = if (pathLen > 1f) ((pathLen - endDist) / pathLen * 4f).coerceIn(0f, 1f) else 0f
        engine.aim = aim(band)
        engine.gate = true
    }

    /** The tension one finger at [p] would give: its distance from the peg. */
    private fun tensionAt(p: PointF) = ((dist(peg, p) - diagonal * REST) / (diagonal * SPAN)).coerceIn(0f, 1f)

    /**
     * Where the band points, as extra tilt: the angle of its far end (from the peg) off straight up,
     * 45° left = -0.5 … 45° right = +0.5. Playing left of centre sounds like tilting the phone left.
     */
    private fun aim(band: List<PointF>): Float {
        val p = peg
        val far = if (dist(p, band.first()) > dist(p, band.last())) band.first() else band.last()
        return atan2(far.x - p.x, p.y - far.y) / (PI.toFloat() / 2f)
    }

    /** Orders points into a band: farthest pair are the ends, the rest sorted along the line between them. */
    private fun shape(pts: List<PointF>): List<PointF> = when (pts.size) {
        0 -> emptyList()
        1 -> listOf(peg, pts[0])
        else -> {
            var a = pts[0]
            var b = pts[1]
            for (p in pts) for (q in pts) if (dist(p, q) > dist(a, b)) { a = p; b = q }
            val dx = b.x - a.x
            val dy = b.y - a.y
            val middle = pts.filter { it !== a && it !== b }.sortedBy { (it.x - a.x) * dx + (it.y - a.y) * dy }
            listOf(a) + middle + b
        }
    }

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(Color.rgb(16, 16, 22))
        drawPanel(canvas)

        drawNoteGrid(canvas)
        fill.color = Color.GRAY
        canvas.drawCircle(peg.x, peg.y, 18f, fill)
        drawGhosts(canvas)
        fill.color = Color.argb(70, 255, 255, 255)
        for (p in fingers.values) canvas.drawCircle(p.x, p.y, 90f, fill)

        drawBand(canvas, band, engine.tension, hot(engine.tension))

        val mode = engine.liveMode
        val t = engine.tension
        val sound = if (!engine.gate) {
            "—"
        } else if (mode.drums) {
            DRUM_ZONES.first { lastHit < it.first }.second // the last finger's zone, not the band's length
        } else {
            val f = mode.freq(t)
            "%6.1f Hz  %s".format(f, noteName(f))
        }
        val lines = listOf(
            "${mode.title}: $sound",
            "stretch %4.2f  bend %4.2f".format(t, engine.bend),
            "tilt ↔ %5.2f  ↕ %4.2f  shake %4.2f".format((engine.tiltX + engine.aim).coerceIn(-1f, 1f), engine.tiltY, engine.shake),
        )
        lines.forEachIndexed { i, s -> canvas.drawText(s, 24f, panelBottom + 50f + i * 46f, hud) }
        gridTop = panelBottom + 50f + lines.size * 46f

        browser?.let { drawBrowser(canvas, it) }

        postInvalidateOnAnimation()
    }

    /** Band length (from the peg, one finger) that gives [tension]. */
    private fun radius(tension: Float) = diagonal * (REST + SPAN * tension)

    /**
     * Where to put one finger: rings around the peg. Melodic modes — a ring per semitone (C bright and
     * labelled, other naturals labelled, sharps faint), the sounding note lit; drums — the three zones.
     * With two or more fingers pitch is the distance between them, so the rings don't apply there.
     */
    private fun drawNoteGrid(canvas: Canvas) {
        val mode = engine.liveMode
        val c = peg
        canvas.save()
        canvas.clipRect(0f, gridTop, width.toFloat(), height.toFloat())
        if (mode.drums) {
            var inner = 0f
            DRUM_ZONES.forEachIndexed { i, (upTo, name) ->
                val outer = radius(upTo.coerceAtMost(1f))
                grid.strokeWidth = outer - inner
                grid.color = Color.argb(if (i % 2 == 0) 26 else 12, 255, 150, 50)
                canvas.drawCircle(c.x, c.y, (inner + outer) / 2, grid)
                gridLabel.alpha = 150
                // near the inner edge (the outer zone runs off-screen); the first zone's clear of the peg
                labelRing(canvas, name, if (i == 0) 250f else inner + 70f)
                inner = outer
            }
        } else {
            val playing = if (engine.gate && fingers.size == 1) Math.round(midi(mode.freq(engine.tension))) else -1
            val lo = ceil(midi(mode.freq(0f))).toInt()
            val hi = floor(midi(mode.freq(1f))).toInt()
            for (m in lo..hi) {
                val r = radius(mode.tension(440f * 2f.pow((m - 69) / 12f)))
                val name = NOTES[m % 12]
                val natural = name.length == 1
                when {
                    m == playing -> grid.stroke(6f, Color.argb(220, 255, 220, 120))
                    name == "C" -> grid.stroke(3f, Color.argb(110, 255, 255, 255))
                    natural -> grid.stroke(2f, Color.argb(45, 255, 255, 255))
                    else -> grid.stroke(1f, Color.argb(18, 255, 255, 255))
                }
                canvas.drawCircle(c.x, c.y, r, grid)
                if (natural || m == playing) {
                    gridLabel.alpha = if (m == playing) 255 else if (name == "C") 200 else 110
                    labelRing(canvas, "$name${m / 12 - 1}", r)
                }
            }
        }
        canvas.restore()
    }

    /**
     * Labels a ring where it meets the left edge — away from the band, which mostly runs up from the peg;
     * rings too small to reach the edge get the label at their leftmost point.
     */
    private fun labelRing(canvas: Canvas, text: String, r: Float) {
        val dx = peg.x - LABEL_X
        val y = if (r > dx) peg.y - sqrt(r * r - dx * dx) else peg.y
        val x = if (r > dx) LABEL_X else peg.x - r + 8f
        canvas.drawText(text, x, y - 8f, gridLabel)
    }

    private fun Paint.stroke(width: Float, color: Int) {
        strokeWidth = width
        this.color = color
    }

    private fun drawBrowser(canvas: Canvas, entries: List<Sessions.Entry>) {
        fill.color = Color.argb(235, 16, 16, 22)
        canvas.drawRect(0f, panelBottom, width.toFloat(), height.toFloat(), fill)
        hud.color = Color.WHITE
        canvas.drawText("Saved loops: tap — open, hold — delete", 24f, panelBottom + 60f, hud)
        hud.color = Color.LTGRAY
        if (entries.isEmpty()) canvas.drawText("Nothing saved yet", 24f, listTop + 60f, hud)
        entries.forEachIndexed { i, entry ->
            val top = listTop + i * ITEM_H
            if (top + ITEM_H > height) return@forEachIndexed
            fill.color = Color.rgb(42, 42, 52)
            canvas.drawRoundRect(16f, top, width - 16f, top + ITEM_H - 16f, 16f, 16f, fill)
            label.textAlign = Paint.Align.LEFT
            label.textSize = 40f
            canvas.drawText(entry.title, 40f, top + 52f, label)
            label.textSize = 30f
            label.alpha = 170
            canvas.drawText(entry.summary, 40f, top + 98f, label)
            label.alpha = 255
            label.textAlign = Paint.Align.CENTER
        }
    }

    private fun drawPanel(canvas: Canvas) {
        val pulse = (SystemClock.uptimeMillis() % 600) < 300
        engine.tracks.forEachIndexed { i, tr ->
            val r = cells[i]
            fill.color = when {
                tr.recording || engine.countingIn == i -> if (pulse) Color.rgb(200, 40, 40) else Color.rgb(140, 30, 30)
                !tr.hasContent -> Color.rgb(42, 42, 52)
                tr.muted -> Color.rgb(30, 30, 34)
                else -> dim(TRACK_COLORS[i])
            }
            canvas.drawRoundRect(r, 16f, 16f, fill)
            if (tr.level > 0f) {
                fill.color = Color.argb(140, 255, 255, 255)
                canvas.drawRect(r.left + 10f, r.bottom - 16f, r.left + 10f + (r.width() - 20f) * tr.level, r.bottom - 8f, fill)
            }
            if (i == engine.selected) canvas.drawRoundRect(r, 16f, 16f, border)

            val state = when {
                tr.recording -> "● rec"
                engine.countingIn == i -> "count-in"
                !tr.hasContent -> "empty"
                tr.muted -> "muted"
                else -> "playing"
            }
            label.textSize = 34f
            canvas.drawText("${i + 1} ${tr.mode.short}", r.centerX(), r.top + r.height() * 0.4f, label)
            label.textSize = 28f
            canvas.drawText(state, r.centerX(), r.top + r.height() * 0.72f, label)
        }

        // metronome ticking: four beat cells, the current one lit; otherwise the loop's progress
        fill.color = Color.rgb(42, 42, 52)
        canvas.drawRect(progress, fill)
        val loopLen = engine.loopLen
        val bar = engine.barBlocks
        val beat = if (bar > 0) engine.clickBlocks % bar * 4 / bar else -1
        if (beat >= 0) {
            val cw = progress.width() / 4
            fill.color = if (beat == 0) Color.rgb(255, 210, 80) else Color.rgb(90, 160, 255)
            canvas.drawRect(progress.left + beat * cw + 4f, progress.top, progress.left + (beat + 1) * cw - 4f, progress.bottom, fill)
        } else if (loopLen > 0) {
            fill.color = Color.rgb(90, 160, 255)
            canvas.drawRect(progress.left, progress.top, progress.left + progress.width() * engine.pos / loopLen, progress.bottom, fill)
            // bar lines, so the loop reads as bars of the metronome's grid
            fill.color = Color.rgb(16, 16, 22)
            val bars = engine.loopBeats / 4
            for (b in 1 until bars) {
                val x = progress.left + progress.width() * b / bars
                canvas.drawRect(x - 3f, progress.top, x + 3f, progress.bottom, fill)
            }
        }

        val selected = engine.tracks[engine.selected]
        val firstTake = loopLen == 0 && selected.recording
        val counting = engine.countingIn == engine.selected
        fill.color = if (selected.recording || counting) Color.rgb(170, 40, 40) else Color.rgb(60, 60, 72)
        canvas.drawRoundRect(recButton, 16f, 16f, fill)
        label.textSize = 38f
        val recText = when {
            counting -> "Count-in… ${4 - beat}"
            firstTake && bar > 0 -> "■ Stop · bar ${engine.recCount / bar + 1}"
            firstTake -> "■ Stop · %.1f s".format(engine.recCount / engine.blocksPerSecond)
            selected.recording -> "■ Stop"
            loopLen == 0 -> "● Rec"
            else -> "● Rec · %.1f s".format(loopLen / engine.blocksPerSecond)
        }
        canvas.drawText(recText, recButton.centerX(), recButton.centerY() + 13f, label)

        // tempo can change only before the first loop exists; the metronome toggles any time
        fill.color = Color.rgb(60, 60, 72)
        for (r in listOf(slowerButton, fasterButton)) canvas.drawRoundRect(r, 16f, 16f, fill)
        label.alpha = if (loopLen == 0) 255 else 110
        canvas.drawText("−", slowerButton.centerX(), slowerButton.centerY() + 13f, label)
        canvas.drawText("+", fasterButton.centerX(), fasterButton.centerY() + 13f, label)
        label.alpha = 255
        fill.color = if (engine.metronome) Color.rgb(90, 80, 30) else Color.rgb(60, 60, 72)
        canvas.drawRoundRect(tempoButton, 16f, 16f, fill)
        canvas.drawText(if (engine.metronome) "♩ ${engine.bpm}" else "♩ off", tempoButton.centerX(), tempoButton.centerY() + 13f, label)

        fill.color = Color.rgb(60, 60, 72)

        canvas.drawRoundRect(modeButton, 16f, 16f, fill)
        canvas.drawText("${selected.mode.title} ▸", modeButton.centerX(), modeButton.centerY() + 13f, label)

        for (r in listOf(saveButton, openButton)) canvas.drawRoundRect(r, 16f, 16f, fill)
        canvas.drawText("Save", saveButton.centerX(), saveButton.centerY() + 13f, label)
        canvas.drawText(if (browser != null) "Close" else "Open…", openButton.centerX(), openButton.centerY() + 13f, label)
    }

    /**
     * Replays each audible track's recorded shapes at the playhead: the band as it was held,
     * a burst where each drum hit landed.
     */
    private fun drawGhosts(canvas: Canvas) {
        val len = engine.loopLen
        if (len == 0) return
        val now = (engine.pos - 1 + len) % len // the block being heard
        val lookBack = minOf(len, (BURST_S * engine.blocksPerSecond).toInt())
        engine.tracks.forEachIndexed { ti, tr ->
            if (!tr.hasContent || tr.muted || tr.recording) return@forEachIndexed
            val f = tr.frames
            val color = TRACK_COLORS[ti]
            val o = now * Frame.SIZE
            if (f[o + Frame.GATE] > 0.5f) drawBand(canvas, ghostShape(f, o), f[o + Frame.TENSION], color, GHOST_ALPHA)

            for (k in 0 until lookBack) {
                val e = ((now - k + len) % len) * Frame.SIZE
                if (f[e + Frame.EVENT] != Frame.EV_HIT) continue
                val p = 1f - k / engine.blocksPerSecond / BURST_S
                fill.color = color
                fill.alpha = (255 * p * GHOST_ALPHA).toInt()
                canvas.drawCircle(f[e + Frame.EV_X] * width, f[e + Frame.EV_Y] * height, 40f + 120f * (1f - p), fill)
            }
        }
    }

    private fun ghostShape(f: FloatArray, o: Int): List<PointF> =
        List(f[o + Frame.COUNT].toInt()) { i -> PointF(f[o + Frame.PTS + 2 * i] * width, f[o + Frame.PTS + 2 * i + 1] * height) }

    /** Smooth curve through the points; thinner as it stretches, like real rubber. */
    private fun drawBand(canvas: Canvas, pts: List<PointF>, tension: Float, color: Int, alpha: Float = 1f) {
        if (pts.size < 2) return
        bandPaint.strokeWidth = 36f * (1f - 0.75f * tension)
        bandPaint.color = color
        bandPaint.alpha = (alpha * 255).toInt()

        val a = pts.first()
        val b = pts.last()
        path.reset()
        path.moveTo(a.x, a.y)
        for (i in 1 until pts.size - 1) {
            val p = pts[i]
            val q = pts[i + 1]
            path.quadTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2)
        }
        path.lineTo(b.x, b.y)
        canvas.drawPath(path, bandPaint)
    }

    private fun dist(a: PointF, b: PointF) = hypot(a.x - b.x, a.y - b.y)

    companion object {
        private const val HOLD_MS = 600L
        private const val ITEM_H = 140f
        /** Band length at zero stretch and per full stretch, in screen diagonals. */
        private const val REST = 0.05f
        private const val LABEL_X = 20f
        private const val SPAN = 0.8f
        /** Drum sound by stretch: up to this tension → this name. */
        private val DRUM_ZONES = listOf(0.33f to "kick", 0.66f to "tom / snare", 1.01f to "hat")
        private const val TEMPO_STEP = 5
        private const val MIN_BPM = 40
        private const val MAX_BPM = 200
        private const val BURST_S = 0.3f
        private const val GHOST_ALPHA = 0.6f

        /** Track colours: ghost bands and the panel cells share them. */
        private val TRACK_COLORS = intArrayOf(
            Color.rgb(70, 210, 120),
            Color.rgb(255, 150, 50),
            Color.rgb(80, 150, 255),
            Color.rgb(200, 100, 255),
        )

        /** The live band: yellow when slack, red when stretched. */
        private fun hot(tension: Float) = Color.HSVToColor(floatArrayOf(40f - 40f * tension, 0.85f, 1f))

        private fun dim(c: Int) = Color.rgb(Color.red(c) * 2 / 5, Color.green(c) * 2 / 5, Color.blue(c) * 2 / 5)

        private val NOTES = arrayOf("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

        private fun midi(freq: Float) = 69 + 12 * log2(freq / 440f)

        private fun noteName(freq: Float): String {
            val midi = midi(freq)
            val n = Math.round(midi)
            val cents = ((midi - n) * 100).toInt()
            return "${NOTES[(n % 12 + 12) % 12]}${n / 12 - 1} ${if (cents >= 0) "+" else ""}$cents¢"
        }
    }
}
