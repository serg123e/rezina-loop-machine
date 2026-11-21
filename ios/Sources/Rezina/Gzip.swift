import Foundation

/// gzip (RFC 1952) around Foundation's raw DEFLATE (`NSData.compressed(using: .zlib)` is raw RFC 1951):
/// the Android app writes `.rez` files with `GZIPOutputStream`, and iOS has no gzip API of its own.
enum Gzip {
    static func compress(_ data: Data) throws -> Data {
        let body = try (data as NSData).compressed(using: .zlib) as Data
        var out = Data([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]) // deflate, no flags, no mtime, OS unknown
        out.append(body)
        le32(&out, crc32(data))
        le32(&out, UInt32(truncatingIfNeeded: data.count))
        return out
    }

    static func decompress(_ data: Data) throws -> Data {
        let b = [UInt8](data)
        guard b.count >= 18, b[0] == 0x1f, b[1] == 0x8b, b[2] == 8 else { throw SessionError() }
        let flags = b[3]
        var at = 10
        if flags & 4 != 0 { // FEXTRA
            guard at + 2 <= b.count else { throw SessionError() }
            at += 2 + (Int(b[at]) | Int(b[at + 1]) << 8)
        }
        if flags & 8 != 0 { while at < b.count && b[at] != 0 { at += 1 }; at += 1 } // FNAME
        if flags & 16 != 0 { while at < b.count && b[at] != 0 { at += 1 }; at += 1 } // FCOMMENT
        if flags & 2 != 0 { at += 2 } // FHCRC
        guard at < b.count - 8 else { throw SessionError() }
        let body = Data(b[at..<(b.count - 8)])
        let out = try (body as NSData).decompressed(using: .zlib) as Data
        let t = b.count - 8
        let crc = UInt32(b[t]) | UInt32(b[t + 1]) << 8 | UInt32(b[t + 2]) << 16 | UInt32(b[t + 3]) << 24
        guard crc == crc32(out) else { throw SessionError() }
        return out
    }

    private static func le32(_ d: inout Data, _ v: UInt32) {
        d.append(contentsOf: [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8(v >> 24)])
    }

    private static let table: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xedb8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xffff_ffff
        data.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
            for byte in p { c = table[Int((c ^ UInt32(byte)) & 0xff)] ^ (c >> 8) }
        }
        return c ^ 0xffff_ffff
    }
}
