# What each version still lacks

There are three copies of Rezina with the same behaviour: Android (`app/`), iPhone (`ios/`) and browser (`web/`). This is the list of what one has and the others don't yet.

**Rule:** when you change one version, add a line here for each version you did not change. Delete the line when it is done.

## iPhone (`ios/`)

Android and web have all of these; the Kotlin is the closest model for Swift.

- [ ] **See-through readout.** The note rings show through a half-transparent plate under the text readout; ring names under the plate are not drawn (Android: `drawReadout`, `plate()` in `BandView.kt`).
- [ ] **Import a `.rez` file.** "＋ Import .rez file…" is the first row of the Open… list: the file is saved under its own name and opened (Android: `importFrom` in `BandView.kt`, `Sessions.read`). On iOS a document picker, or opening a `.rez` from Files (`CFBundleDocumentTypes`). Refuse a broken header (loopLen, loopBeats or bpm ≤ 0, an unknown sound) and read plain bytes too (web on an old Safari writes them without gzip).
- [ ] **Latency and CPU on screen.** Android: hold ♩ for a fourth readout line `lat out+block=total @48k cpu N% max M` (`latencyLine`; `Engine.outputLatency`, `cpu`, `peakMs`). iOS: the output part from `AVAudioSession.outputLatency` + `ioBufferDuration`.
- [ ] **Convert a file's frames to this phone's rate on load** (`Session.atRate` in `Sessions.kt`). iOS always runs at 48 kHz, so this matters for files from 44.1 kHz Android phones.
- [ ] **Latency shift of takes.** Each take is recorded shifted back by output latency + block + touch (`Engine.comp`; `web/CLAUDE.md`, "Takes").
- [ ] **Takes over a loop start on the next bar line** ("waiting", `● Rec in N`, a second tap cancels; erasing the loop ends the wait), and the part a take has covered is red on the progress bar (`armed`, `nextBar` in `Engine.kt`).
- [ ] **Grid.** A "Grid 1/16" / "Grid off" button next to Save/Open. Tracks keep the raw take and play a copy with drum hits and note starts pulled 70 % toward the sixteenths; Save writes the raw take (`Quantize.kt`, `QuantizeTest.kt`).

## Nowhere yet

- [ ] **Export a session to a `.rez` file** (share or download). The format is the same in all three versions, but each keeps its files to itself: Android in app-private storage, iOS in `Documents/sessions/`, web in IndexedDB.

## Done everywhere

- `.rez` format v2: the sample rate after `Frame.SIZE`; v1 files still open with rate 0 (2026-11-22).
