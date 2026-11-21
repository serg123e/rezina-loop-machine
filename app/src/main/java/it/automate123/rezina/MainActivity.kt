package it.automate123.rezina

import android.app.Activity
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.view.WindowInsets
import android.view.WindowManager
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Wires the phone's inputs into the engine:
 * touch → [BandView]; accelerometer → tilt (slow part, gravity) and shake (fast part, the rest).
 */
class MainActivity : Activity(), SensorEventListener {
    private val engine by lazy {
        val burst = getSystemService(AudioManager::class.java)
            .getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)?.toIntOrNull() ?: Engine.BLOCK
        Engine(burst)
    }
    private lateinit var view: BandView
    private lateinit var sensors: SensorManager

    private val gravity = floatArrayOf(0f, 0f, SensorManager.GRAVITY_EARTH)
    private var shake = 0f

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        view = BandView(this, engine)
        setContentView(view)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.hide(WindowInsets.Type.systemBars())
        }
        sensors = getSystemService(SensorManager::class.java)
    }

    override fun onResume() {
        super.onResume()
        engine.start()
        sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
            sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
    }

    override fun onPause() {
        sensors.unregisterListener(this)
        engine.stop()
        super.onPause()
    }

    override fun onSensorChanged(e: SensorEvent) {
        // low-pass splits the raw signal: what changes slowly is gravity (tilt), the rest is shaking
        val k = 0.9f
        var energy = 0f
        for (i in 0..2) {
            gravity[i] = k * gravity[i] + (1 - k) * e.values[i]
            val lin = e.values[i] - gravity[i]
            energy += lin * lin
        }
        val g = SensorManager.GRAVITY_EARTH
        // shake jumps up at once and fades over ~half a second, like a band that keeps quivering
        shake = maxOf(sqrt(energy) / 12f, shake * 0.93f).coerceIn(0f, 1f)

        val tiltX = (-gravity[0] / g).coerceIn(-1f, 1f) // right edge down → brighter
        val tiltY = (abs(gravity[1]) / g).coerceIn(0f, 1f) // flat → 0, upright → 1

        engine.tiltX = tiltX
        engine.tiltY = tiltY
        engine.shake = shake
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit
}
