# Rezina Loop Machine: a rubber band as a musical instrument (prototype)

This is an Android app. You stretch and bend a band on the screen with your fingers, and tilt and shake the phone, to change the sound. It also has a 4-track looper: record a bass line, then drums over it, then a melody, all on the same instrument in different modes.

There are no libraries. The synth runs on `AudioTrack` (stereo float), and the whole screen is one custom `View`. The README is the user-facing page and has the screenshots.

**Ports.** There are two copies of this app, with the same behaviour and session format. When you change a rule in the Kotlin code, port it to both. **[`PORTING.md`](PORTING.md) lists what each version still lacks:** when you change one version and not the others, add a line there for each of them.

- **iPhone:** `ios/` is a native Swift copy. Build and release: [`ios/CLAUDE.md`](ios/CLAUDE.md).
- **Browser:** `web/` is a JavaScript copy (AudioWorklet, canvas, installable), deployed to GitHub Pages. Details: [`web/CLAUDE.md`](web/CLAUDE.md).

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
| Band length (path through all fingers) | `tension` | Pitch. The range depends on the mode (`Mode.freq`). |
| Band curvature (path length against the distance between the ends) | `bend` | Drive and filter resonance; a longer "pluck" on Lead, a longer kick and open hat on Drums |
| Tilt left/right, **or play left/right of centre** | `tiltX` | Brightness: the filter on bass and lead (the vowel on Voice lead); on drums the snare/hat noise and the kick's click. The band's angle from the peg (far end, off straight up) adds to the phone's tilt: 45° = half a full tilt (`BandView.aim` → `Engine.aim`, summed into the frame's `TILT_X`, so recordings keep it). |
| Lift from flat to upright | `tiltY` | Vibrato on Lead; on Growl bass the last stretch to upright (0.8–1) wobbles the filter in eighths; on drums it tunes the kit up, +3 semitones when upright (`DrumColour`) |
| Shake | `shake` | Pitch wobble; a shaker in Drums mode. While fingers hold a band, its length sets the shaker's brightness and its bend the grain, smooth "shh" … sparse rattles (`ShakerShape`) |
| New finger (drums: by its own distance from the peg, even with other fingers down) | gate rises | Lead and Bass: the filter snaps open and falls back. Drums: a hit — kick near the peg, tom/snare further out, hat far away |

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

## Sound

Each track plays one of nine sounds (`Mode`), three per family (`Kind`: bass, drums, lead). The **Sound** button (it shows the sound's name, e.g. "Acid bass ▸") cycles through them: basses, then drums, then leads.

| Mode | Kind | Instrument (`Synth.kt`) | In short |
|---|---|---|---|
| `BASS` "Growl bass" | bass | `GrowlBass` | 3 detuned saws → drive → resonant low-pass; clean sub; top widened; wobble when held upright |
| `ACID_BASS` "Acid bass" | bass | `AcidBass` | 1 saw, resonant filter that "quacks" on every touch |
| `FM_BASS` "FM bass" | bass | `FmBass` | self-modulated sine: a bark on the attack, carries on phone speakers |
| `DRUMS` "808 drums" | drums | `Kit808` | kick with click and drive, two-tone snare, metallic hat |
| `HARD_DRUMS` "Hard drums" | drums | `KitHard` | driven kick, hand clap, sharp hat |
| `LOFI_DRUMS` "Lo-fi drums" | drums | `KitLofi` | soft kit through a 12-bit/24 kHz "sampler", low-pass, tape saturation, room |
| `LEAD` "Pluck lead" | lead | `PluckLead` | filter snap per touch, dotted-eighth echo |
| `WIDE_LEAD` "Wide lead" | lead | `WideLead` | 7-saw stereo supersaw, 3/16 echo, hall |
| `VOICE_LEAD` "Voice lead" | lead | `VoiceLead` | vowel formants: tilt sweeps U-O-A-E-I |

`Master`: bass and lead duck under each kick ("pumping"), room on drums, bus compressor, tanh.

- **Session files store the mode's ordinal.** Only append to `Mode`; the first three are what old files called Bass / Drums / Lead.
- **The sounds were picked by ear on [`docs/sound-lab.html`](docs/sound-lab.html)** (published as the "Звуки Rezina" artifact). Its JavaScript is the reference; `Synth.kt`, `ios/…/Synth.swift` and `web/synth.js` are line-by-line ports. To change a sound, change it on the page first (open the file in a browser and listen), then port the same lines to Kotlin, Swift and `web/`.
- **`Mode.gain`** levels the instruments as on the page: 0.14 / the variant's RMS on the page's phrase × 0.9 (bass), 1 (drums), 0.65 (lead) × 1.5.
- **`VoiceTest`** (`./gradlew --offline testDebugUnitTest`) renders a fixed gesture in every mode and checks the RMS against numbers from the page's JavaScript. If it fails, the port no longer sounds like what was chosen. The same check runs for iOS (`make soundcheck`) and the browser (`cd web && npm test`).
- On the page the drum zones are 0.3/0.7; in the app they are 0.33/0.66, as on the screen grid.
- Every `Voice` holds all nine instruments; inactive ones get a closed gate, ring out and sleep, so they cost nothing.

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

- **Save** writes the current loop to `files/sessions/<date>.rez`. The file is gzip; the format is described in `Sessions.kt`. It holds the sample rate (format v2; v1 files without it still open), the track gestures, each track's mode and mute state, the loop length, the bars and the tempo.
- Saving is refused during recording or count-in.
- **Open…** shows a list over the band. Tap an entry to load it (this replaces everything); hold an entry to delete it.
- Frames are tied to the phone's sample rate, so a file from another phone plays slightly faster or slower. The file records its rate, but loading does not convert yet ([`PORTING.md`](PORTING.md)).

**Playing live**

- Live playing always sounds on a separate voice in the selected track's mode, so you can play over the loop without recording.

**Panel**

| Control | Action |
|---|---|
| Track | Tap: select. Tap the selected one: mute/unmute. Hold 0.6 s: erase. |
| **Rec** | Record the selected track |
| **−** / **+** | Tempo, before the first loop only |
| **♩** | Metronome on/off |
| **Sound** (shows the sound's name) | Change the selected track's sound, one of nine |
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

- `Engine.kt`: the audio thread and the looper. Voices write into two stereo buses (melodic, drums); `Master` mixes them. The UI and the sensors write only `@Volatile` fields. Everything that changes looper state goes through a command queue, so only the audio thread changes it.
- `Voice.kt`: one track's sound: routes a `Frame` to the instrument of the track's mode. Audio thread only.
- `Synth.kt`: one instrument per `Mode`, the `Master` bus and the DSP parts (filter, echo, reverb, delay line).
- `Sessions.kt`: saving and loading session files.
- `Mode.kt`: the nine sounds (`Mode`), their families (`Kind`: pitch range, drum zones) and the `Frame` layout.
- `BandView.kt`: touches → band shape → `tension`/`bend`; the looper panel; drawing.
- `tools/aab`, `tools/play`, `tools/play_api.py`: the Google Play bundle and Play Developer API (a copy of Skeeto's helpers).
- `MainActivity.kt`: the accelerometer. A low-pass filter splits its signal into tilt (gravity) and shake.
