# What each version still lacks

There are three copies of Rezina with the same behaviour: Android (`app/`), iPhone (`ios/`) and browser (`web/`). This is the list of what one has and the others don't yet.

**Rule:** when you change one version, add a line here for each version you did not change. Delete the line when it is done.

## Android (`app/`)

- [ ] **See-through readout.** The note rings should show through a half-transparent plate under the text readout (web: `drawReadout`, `plate()` in `app.js`). Ring names that fall under the plate are not drawn.
- [ ] **Latency and CPU on screen.** Web shows `lat base+out+block=total cpu N% max M` with `?debug=1`. Android logs only its own buffer size (`adb logcat -s rezina:I`). The output part needs `AudioTrack.getTimestamp`.
- [ ] **Convert a file's frames to this phone's rate on load.** Sessions record their sample rate (format v2), but nothing converts yet. A 44.1 kHz file still plays ~9 % faster at 48 kHz.

## iPhone (`ios/`)

- [ ] **See-through readout.** As above.
- [ ] **Latency and CPU on screen.** As above; iOS logs latency to the `audio` category only.
- [ ] **Convert a file's frames to this phone's rate on load.** As above (iOS always runs at 48 kHz).

## Browser (`web/`)

- [ ] **Convert a file's frames to this device's rate on load.** As above. The page asks for 48 kHz, so this matters only for Android files from 44.1 kHz phones, or with `?rate=native`.

## Nowhere yet

- [ ] **Move sessions between devices** (export and import a `.rez` file). The format is the same in all three versions, but each keeps its files to itself: Android in app-private storage, iOS in `Documents/sessions/`, web in IndexedDB.

## Done everywhere

- `.rez` format v2: the sample rate after `Frame.SIZE`; v1 files still open with rate 0 (2026-11-22).
