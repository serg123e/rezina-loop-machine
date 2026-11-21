import Foundation

/// One saved looper: the loop's grid plus, per track, its sound and one loop of gesture frames.
struct Session {
    /// `frames` is nil for an empty track, else exactly loopLen × `Frame.size` floats.
    struct TrackData {
        let mode: Mode
        let muted: Bool
        let frames: [Float]?
    }

    let loopLen: Int
    let loopBeats: Int
    let bpm: Int
    let tracks: [TrackData]
}

struct SessionError: Error {}

/// Sessions live as gzip'd files in `Documents/sessions/<date>.rez`, newest first.
/// Same format as Android `Sessions.kt`, so files can be moved between the apps.
///
/// Format v1: magic, version, Frame.size, loopLen, loopBeats, bpm, track count (big-endian Int32); then per
/// track mode ordinal (byte), muted, hasContent (bytes 0/1) and, if present, loopLen × Frame.size big-endian
/// floats. Frames are per 192-sample block; iOS always runs at 48 kHz, so a file from a 44.1 kHz Android
/// phone plays ~9 % faster here.
enum Sessions {
    private static let magic: Int32 = 0x5245_5a31 // "REZ1"
    private static let version: Int32 = 1

    /// A saved file and a one-line summary read from its header.
    struct Entry {
        let file: URL
        let title: String
        let summary: String
    }

    static var dir: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("sessions")
    }

    private static func formatter(_ pattern: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = pattern
        return f
    }

    static func list() -> [Entry] {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let title = formatter("dd.MM HH:mm")
        return files.filter { $0.pathExtension == "rez" }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
            .compactMap { f in
                guard let s = try? load(f) else { return nil } // unreadable or from another version
                let bars = s.loopBeats / 4
                let used = s.tracks.filter { $0.frames != nil }.map { $0.mode.title }.joined(separator: ", ")
                let date = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()
                return Entry(file: f, title: title.string(from: date),
                             summary: "\(bars) \(bars == 1 ? "bar" : "bars") · ♩ \(s.bpm) · \(used)")
            }
    }

    static func save(_ s: Session) throws -> URL {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = dir.appendingPathComponent(formatter("yyyy-MM-dd_HH-mm-ss").string(from: Date()) + ".rez")
        var out = Data()
        func int(_ v: Int32) { withUnsafeBytes(of: v.bigEndian) { out.append(contentsOf: $0) } }
        int(magic)
        int(version)
        int(Int32(Frame.size))
        int(Int32(s.loopLen))
        int(Int32(s.loopBeats))
        int(Int32(s.bpm))
        int(Int32(s.tracks.count))
        for t in s.tracks {
            out.append(UInt8(t.mode.rawValue))
            out.append(t.muted ? 1 : 0)
            out.append(t.frames != nil ? 1 : 0)
            if let frames = t.frames {
                var bytes = [UInt8](repeating: 0, count: frames.count * 4)
                for (i, v) in frames.enumerated() {
                    let b = v.bitPattern
                    bytes[4 * i] = UInt8(b >> 24)
                    bytes[4 * i + 1] = UInt8((b >> 16) & 0xff)
                    bytes[4 * i + 2] = UInt8((b >> 8) & 0xff)
                    bytes[4 * i + 3] = UInt8(b & 0xff)
                }
                out.append(contentsOf: bytes)
            }
        }
        try Gzip.compress(out).write(to: f, options: .atomic)
        return f
    }

    static func load(_ f: URL) throws -> Session {
        let raw = [UInt8](try Gzip.decompress(Data(contentsOf: f)))
        var at = 0
        func byte() throws -> UInt8 {
            guard at < raw.count else { throw SessionError() }
            at += 1
            return raw[at - 1]
        }
        func int() throws -> Int {
            guard at + 4 <= raw.count else { throw SessionError() }
            let v = UInt32(raw[at]) << 24 | UInt32(raw[at + 1]) << 16 | UInt32(raw[at + 2]) << 8 | UInt32(raw[at + 3])
            at += 4
            return Int(Int32(bitPattern: v))
        }
        guard try int() == Int(magic), try int() == Int(version), try int() == Frame.size else { throw SessionError() }
        let loopLen = try int()
        let loopBeats = try int()
        let bpm = try int()
        let count = try int()
        guard loopLen >= 0, (0...16).contains(count) else { throw SessionError() }
        var tracks: [Session.TrackData] = []
        for _ in 0..<count {
            guard let mode = Mode(rawValue: Int(try byte())) else { throw SessionError() }
            let muted = try byte() != 0
            var frames: [Float]?
            if try byte() != 0 {
                let n = loopLen * Frame.size
                guard at + 4 * n <= raw.count else { throw SessionError() }
                var fr = [Float](repeating: 0, count: n)
                for i in 0..<n {
                    let o = at + 4 * i
                    fr[i] = Float(bitPattern: UInt32(raw[o]) << 24 | UInt32(raw[o + 1]) << 16 | UInt32(raw[o + 2]) << 8 | UInt32(raw[o + 3]))
                }
                at += 4 * n
                frames = fr
            }
            tracks.append(.init(mode: mode, muted: muted, frames: frames))
        }
        return Session(loopLen: loopLen, loopBeats: loopBeats, bpm: bpm, tracks: tracks)
    }
}
