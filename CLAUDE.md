# Rezina Loop Machine: a rubber band as a musical instrument (prototype)

This is an Android app. You stretch and bend a band on the screen with your fingers, and tilt and shake the phone, to change the sound. It also has a 4-track looper: record a bass line, then drums over it, then a melody, all on the same instrument in different modes.

There are no libraries. The synth runs on `AudioTrack`, and the whole screen is one custom `View`. The README is the user-facing page and has the screenshots.

**iPhone port:** `ios/` is a native Swift copy of this app (same behaviour and session format). Its build and release are in [`ios/CLAUDE.md`](ios/CLAUDE.md). When you change a rule in the Kotlin code, port it there too.

## Build and run

```bash
./gradlew --offline assembleDebug                      # → app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

- **Offline builds.** `--offline` takes dependencies from the shared `~/.gradle` cache.
- **Kotlin plugin.** Kotlin 2.4.21 is declared in the root `build.gradle.kts` only to pin its version. AGP 9 pulls in 2.2.10 by itself, and that version is not in the local cache.

## Releases

Push a `v*` tag. The workflow `.github/workflows/release.yml` then does three things:

1. Builds `assembleRelease` on GitHub's runners and signs it with the release key.
2. Adds a build-provenance attestation.
3. Publishes `rezina-loop-machine.apk` to GitHub Releases. The README links to `releases/latest/download/rezina-loop-machine.apk`.

```bash
# bump versionCode/versionName in app/build.gradle.kts first
git tag v0.2 && git push origin v0.2
```

**Release key**

- The keystore is `~/.config/rezina/release.jks`, alias `rezina`. Its password is in `~/.config/rezina/keystore-password`. The key is not in the repo.
- The CI copy lives in the GitHub secrets `REZINA_KEYSTORE_BASE64` and `REZINA_KEYSTORE_PASSWORD`.
- **If the key is lost, users cannot update the app over an installed copy.** Keep a backup.
- For a local release build, set the `REZINA_KEYSTORE` and `REZINA_KEYSTORE_PASSWORD` environment variables. Without them, `assembleRelease` produces an unsigned APK.

## Google Play

[`docs/play.md`](docs/play.md) covers what is done by hand in Play Console and what goes through the API (`tools/aab`, `tools/play`). Store texts and art are in `store/`.

The app signing key in Play is our release key, so GitHub and Play builds can update each other.

## Icon

`store/icon.svg` is the source picture. Keep `app/src/main/res/drawable/ic_launcher_foreground.xml` drawing the same shapes.

`store/icon-512.png` is rendered with:

```bash
rsvg-convert -w 512 -h 512 store/icon.svg -o store/icon-512.png
```

## What controls what

| Input | Synth parameter | Sound |
|---|---|---|
| Band length (path through all fingers) | `tension` | Pitch and loudness. The range depends on the mode (`Mode.freq`). |
| Band curvature (path length against the distance between the ends) | `bend` | Drive and filter resonance |
| Tilt left/right | `tiltX` | Brightness (filter cutoff) |
| Lift from flat to upright | `tiltY` | Vibrato depth |
| Shake | `shake` | Pitch and volume wobble; brighter |
| New finger in Drums mode | `hit()` | A hit: kick near the peg, snare further out, hat far away |

**Band shape**

- With 1 finger, the band runs from the peg at the bottom of the screen to the finger.
- With 2 or more fingers, the ends are the two fingers furthest apart.

**Note grid**

- With one finger, pitch equals the distance to the peg, so note rings are drawn around the peg under the band:
  - C notes are bright and labelled;
  - other white keys are dim and labelled;
  - sharps are barely visible;
  - the note that is sounding is lit.
- In Drums mode the grid shows three zones instead: kick, tom/snare, hat.
- The rings do not apply with 2 or more fingers.

## Looper

**Tracks store gestures**

- A track stores the **gesture**, not the sound. Once per audio block (192 samples, about 4 ms) it takes a `Frame` snapshot. The snapshot holds `tension`, `bend`, the tilts, shake, a drum hit with its position, and the band shape (up to 6 points, as fractions of the screen).
- On playback, each track's own `Voice` synthesizes the gesture again. That is why a recorded track's mode (`Mode`) can still be changed.
- The shape is drawn as a "ghost" in the track's colour. Drum hits show as a flash at the point of the hit.

**Loop length**

- The first take sets the loop length, from start to stop. A take shorter than 0.5 s is discarded. The maximum is 60 s.
- After that, every take lasts exactly one loop from the current position and stops by itself.
- When all tracks are erased, the loop length resets.

**Metronome**

- The metronome is on by default, in 4/4. Tap **♩** to turn it on or off at any time.
- Before the first loop, the tempo is 40–200 bpm in steps of 5.
- First take: **Rec** → one bar of count-in → recording from the downbeat with clicks → **Stop**. Stop rounds the loop to whole bars, and the unplayed tail is silence. Tapping Rec again during the count-in cancels.
- Once a loop exists, the clicks play over the tracks on its grid (`loopBeats`). The clicks are sample-accurate on that grid.
- After a free take (metronome off), a whole number of bars near the chosen tempo is fitted into the loop, and **♩** shows the resulting tempo.

**Saving**

- **Save** writes the current loop to `files/sessions/<date>.rez`. The file is gzip; the format is described in `Sessions.kt`. It holds the track gestures, each track's mode and mute state, the loop length, the bars and the tempo.
- Saving is refused during recording or count-in.
- **Open…** shows a list over the band. Tap an entry to load it (this replaces everything); hold an entry to delete it.
- Frames are tied to the phone's sample rate, so a file from another phone plays slightly faster or slower.

**Playing live**

- Live playing always sounds on a separate voice in the selected track's mode, so you can play over the loop without recording.

**Panel**

| Control | Action |
|---|---|
| Track | Tap: select. Tap the selected one: mute/unmute. Hold 0.6 s: erase. |
| **Rec** | Record the selected track |
| **−** / **+** | Tempo, before the first loop only |
| **♩** | Metronome on/off |
| **Sound** | Change the selected track's mode |
| **Save** / **Open…** | Sessions |

## Audio latency

- **Buffer size.** The `AudioTrack` buffer is one of our blocks plus one device "burst" (`PROPERTY_OUTPUT_FRAMES_PER_BUFFER`). On an underrun it grows by one burst.
- **Measured numbers** are in logcat: `adb logcat -s rezina:I`. `size=` is the buffer in frames; `perf=1` means the low-latency mode was granted.
- **Bluetooth headphones** add their own 150–250 ms, which the app cannot remove.

## Screenshots

The README screenshots come from the emulator: AVD `Phone_API_36`, unlocked with PIN 1234.

- **Start the emulator with `-gpu swiftshader_indirect`.** With the default host GPU, `screencap` returns black frames.
- **Touches come from `input motionevent DOWN/MOVE/UP` and `input tap`.** Each `input` call takes about 0.3 s, so run each sequence in one `adb shell '…'` script.

## Files

- `Engine.kt`: the audio thread and the looper. The UI and the sensors write only `@Volatile` fields. Everything that changes looper state goes through a command queue, so only the audio thread changes it.
- `Voice.kt`: synthesizes one voice from a `Frame` (tone plus drum). Audio thread only.
- `Sessions.kt`: saving and loading session files.
- `Mode.kt`: the modes (Bass / Drums / Lead) and the `Frame` layout.
- `BandView.kt`: touches → band shape → `tension`/`bend`; the looper panel; drawing.
- `tools/aab`, `tools/play`, `tools/play_api.py`: the Google Play bundle and Play Developer API (a copy of Skeeto's helpers).
- `MainActivity.kt`: the accelerometer. A low-pass filter splits its signal into tilt (gravity) and shake.
