import Synchronization

// Shared UI ↔ audio fields. The Android app uses @Volatile; here every shared scalar is an `Atomic`
// (relaxed: each field is independent, like a volatile), so the render thread never takes a lock.

final class AtomicFloat {
    private let raw: Atomic<UInt32>
    init(_ v: Float = 0) { raw = Atomic(v.bitPattern) }
    var value: Float {
        get { Float(bitPattern: raw.load(ordering: .relaxed)) }
        set { raw.store(newValue.bitPattern, ordering: .relaxed) }
    }
}

final class AtomicInt {
    private let raw: Atomic<Int>
    init(_ v: Int = 0) { raw = Atomic(v) }
    var value: Int {
        get { raw.load(ordering: .relaxed) }
        set { raw.store(newValue, ordering: .relaxed) }
    }
}

final class AtomicBool {
    private let raw: Atomic<Bool>
    init(_ v: Bool = false) { raw = Atomic(v) }
    var value: Bool {
        get { raw.load(ordering: .relaxed) }
        set { raw.store(newValue, ordering: .relaxed) }
    }
}

/// Single-producer single-consumer queue of fixed-width Float records, preallocated.
/// Producer: the main thread. Consumer: the audio render thread (no allocation, no lock).
/// The release store of `head` publishes the record (and anything the producer wrote before it).
final class Ring {
    let width: Int
    private let capacity: Int
    private let buf: UnsafeMutablePointer<Float>
    private let head = Atomic<Int>(0) // next write, producer only
    private let tail = Atomic<Int>(0) // next read, consumer only

    init(width: Int, capacity: Int) {
        self.width = width
        self.capacity = capacity
        buf = .allocate(capacity: width * capacity)
        buf.initialize(repeating: 0, count: width * capacity)
    }

    deinit { buf.deallocate() }

    /// Main thread. False when full (the audio thread is not running).
    @discardableResult
    func push(_ values: [Float]) -> Bool {
        let h = head.load(ordering: .relaxed)
        if h - tail.load(ordering: .acquiring) >= capacity { return false }
        let slot = buf + (h % capacity) * width
        for i in 0..<width { slot[i] = i < values.count ? values[i] : 0 }
        head.store(h + 1, ordering: .releasing)
        return true
    }

    /// Audio thread. Copies the oldest record into `dst` (`width` floats).
    func pop(into dst: UnsafeMutablePointer<Float>) -> Bool {
        let t = tail.load(ordering: .relaxed)
        if t == head.load(ordering: .acquiring) { return false }
        dst.update(from: buf + (t % capacity) * width, count: width)
        tail.store(t + 1, ordering: .releasing)
        return true
    }
}
