import CoreMotion

/// Accelerometer → tilt (slow part, gravity) and shake (fast part, the rest); port of Android `MainActivity`.
final class Motion {
    private let manager = CMMotionManager()
    private let engine: Engine
    private static let g: Float = 9.80665 // SensorManager.GRAVITY_EARTH
    private var gravity: [Float] = [0, 0, Motion.g]
    private var shake: Float = 0

    init(engine: Engine) { self.engine = engine }

    func start() {
        guard manager.isAccelerometerAvailable, !manager.isAccelerometerActive else { return }
        manager.accelerometerUpdateInterval = 0.02 // Android SENSOR_DELAY_GAME: the filter constants assume ~50 Hz
        manager.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
            guard let a = data?.acceleration else { return }
            // Same axes as Android, but in g and with the opposite sign: Android reports +9.8 on y when upright,
            // iOS −1. Convert to Android's m/s² so the rest is the Kotlin code as is.
            self?.update([Float(-a.x) * Motion.g, Float(-a.y) * Motion.g, Float(-a.z) * Motion.g])
        }
    }

    func stop() { manager.stopAccelerometerUpdates() }

    private func update(_ v: [Float]) {
        // low-pass splits the raw signal: what changes slowly is gravity (tilt), the rest is shaking
        let k: Float = 0.9
        var energy: Float = 0
        for i in 0..<3 {
            gravity[i] = k * gravity[i] + (1 - k) * v[i]
            let lin = v[i] - gravity[i]
            energy += lin * lin
        }
        let g = Motion.g
        // shake jumps up at once and fades over ~half a second, like a band that keeps quivering
        shake = min(max(max(energy.squareRoot() / 12, shake * 0.93), 0), 1)

        engine.tiltX.value = min(max(-gravity[0] / g, -1), 1) // right edge down → brighter
        engine.tiltY.value = min(max(abs(gravity[1]) / g, 0), 1) // flat → 0, upright → 1
        engine.shake.value = shake
    }
}
