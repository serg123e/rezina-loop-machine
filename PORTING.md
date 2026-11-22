# What each version still lacks

There are three copies of Rezina with the same behaviour: Android (`app/`), iPhone (`ios/`) and browser (`web/`). This is the list of what one has and the others don't yet.

**Rule:** when you change one version, add a line here for each version you did not change. Delete the line when it is done.

## Android (`app/`)

- [ ] **See-through readout.** The note rings should show through a half-transparent plate under the text readout (web: `drawReadout`, `plate()` in `app.js`). Ring names that fall under the plate are not drawn.
- [ ] **Import a `.rez` file.** Web has "＋ Import .rez file…" as the first row of the Open… list: the file is saved under its own name and opened (`fileInput` in `app.js`). Android: an `ACTION_OPEN_DOCUMENT` intent.
- [ ] **Latency and CPU on screen.** Web shows `lat base+out+block=total cpu N% max M` with `?debug=1`. Android logs only its own buffer size (`adb logcat -s rezina:I`). The output part needs `AudioTrack.getTimestamp`.
- [ ] **Convert a file's frames to this phone's rate on load.** Sessions record their sample rate (format v2), but nothing converts yet. A 44.1 kHz file still plays ~9 % faster at 48 kHz.
- [ ] **Latency shift of takes.** Record each take shifted back by output latency + touch latency (web: `Engine.comp`, `sendLatency` in `app.js`; see `web/CLAUDE.md`, "Takes"). Android: the output part from `AudioTrack.getTimestamp`, touch ~15–30 ms.
- [ ] **Takes over a loop start on the next bar line** ("waiting", `● Rec in N`, a second tap cancels), and the part a take has covered is red on the progress bar (web: `armed`/`nextBar` in `worklet.js`, `drawPanel` in `app.js`; `web/CLAUDE.md`, "Takes start on a bar line").
- [ ] **Grid.** A "Grid 1/16" / "Grid off" button next to Save/Open. Tracks keep the raw take and play a copy with drum hits and note starts pulled 70 % toward the sixteenths; Save writes the raw take (web: `quantize.js`, `applyGrid` in `worklet.js`, tests in `test/quantize.mjs`).

## iPhone (`ios/`)

- [ ] **See-through readout.** As above.
- [ ] **Import a `.rez` file.** As above; on iOS a document picker, or opening a `.rez` from Files (`CFBundleDocumentTypes`).
- [ ] **Latency and CPU on screen.** As above; iOS logs latency to the `audio` category only.
- [ ] **Convert a file's frames to this phone's rate on load.** As above (iOS always runs at 48 kHz).
- [ ] **Latency shift of takes.** As above; the output part from `AVAudioSession.outputLatency` + `ioBufferDuration`.
- [ ] **Takes over a loop start on the next bar line**, recorded part red. As above.
- [ ] **Grid.** As above.

## Browser (`web/`)

- [ ] **Convert a file's frames to this device's rate on load.** As above. The page asks for 48 kHz, so this matters only for Android files from 44.1 kHz phones, or with `?rate=native`.

## Nowhere yet

- [ ] **Export a session to a `.rez` file** (share or download). The format is the same in all three versions, but each keeps its files to itself: Android in app-private storage, iOS in `Documents/sessions/`, web in IndexedDB.

## Done everywhere

- `.rez` format v2: the sample rate after `Frame.SIZE`; v1 files still open with rate 0 (2026-11-22).
