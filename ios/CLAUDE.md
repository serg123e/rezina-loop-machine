# Rezina for iPhone

Native Swift port of the Android app in `../app` (read `../CLAUDE.md` for what the instrument and the looper do). Same behaviour, labels and session file format; each Swift file says which Kotlin file it ports. Change a rule there, port it here. What this version still lacks: [`../PORTING.md`](../PORTING.md).

No third-party libraries: SwiftUI shell, one UIKit view drawn with CoreGraphics, `AVAudioEngine`, `CoreMotion`. iPhone only, portrait only, iOS 18+ (the `Synchronization` module's `Atomic`).

```
Linux:  make build (xtool, Package.swift) ── compile check only
GitHub: push → .github/workflows/ios.yml (XcodeGen, project.yml) → unsigned archive
        make testflight / make release → same workflow with upload=true → TestFlight
```

## Build

```bash
cd ios
make build        # xtool on Linux → xtool/Rezina.app (needs swiftly + `xtool sdk install`, as for CamJamProbe)
make ci           # unsigned Xcode build of the pushed branch on GitHub
make soundcheck   # every sound vs the comparison page's numbers, on Linux
make icon         # re-render Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png from ../store/icon.svg
```

- `make build` does not catch "unable to type-check this expression in reasonable time"; only Xcode does. Keep expressions short.
- The repo is public, so GitHub macOS minutes are free; every push touching `ios/` runs the unsigned build.

## Release (TestFlight)

Same scheme as CamJamProbe: the archive is unsigned, and `xcodebuild -exportArchive -allowProvisioningUpdates` signs and uploads it with the App Store Connect API key.

```bash
make release DRY=1   # checks: clean tree, pushed branch, ## <version> in store/whatsnew.md, make build
make release         # build + upload → "What to Test" → internal groups → tag ios-v<version>
```

- Version: `MARKETING_VERSION` in `project.yml`. The build number is the workflow run number.
- Tags are `ios-v<version>`: plain `v*` tags trigger the Android APK release.
- `bin/asc <path>`: App Store Connect API with the key in `~/.appstoreconnect` (key id `922J6W9LW2`). Never commit the key.
- Secrets the workflow needs for upload: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the `.p8` text), the same values as in the CamJamProbe repo.
- Bundle id `it.automate123.rezina` is registered (App ID `538GW34CVA`, via `bin/asc`, 21.11.2026). The app record must be created in the App Store Connect web UI (the API cannot create apps); `bin/release` finds it by bundle id.
- Never submit for App Store review from here.

## Code (`Sources/Rezina/`)

- `Engine.swift` (Engine.kt): `AVAudioSourceNode` render callback + the looper. The UI and sensors write only atomic fields; looper changes go through a lock-free single-producer ring (`Ring`), so only the render thread mutates looper state. The render thread does not allocate or lock.
- `Voice.swift` (Voice.kt), `Synth.swift` (Synth.kt): the instruments and the master bus, stereo. `Mode.swift` (Mode.kt): modes and the `Frame` layout. The source node is 2-channel non-interleaved.
- `Mode.swift` raw values = Kotlin `Mode` ordinals (they are in session files); `Kind` is the family.
- **Sound check on Linux:** `make soundcheck` renders the gestures of Android `VoiceTest` in every mode (`Tests/soundcheck/main.swift`) and must print `ok` for each: the same numbers as the `page` map there.
- `BandView.swift` (BandView.kt): touches → band → tension/bend, the panel, note grid, ghosts, saved-loop list, toasts. Android pixel constants go through `px()`: scaled to a 1080 px wide screen.
- **The view is drawn on the CPU**, so `frameTick()` redraws only while something moves (fingers, a playing loop, count-in, a toast), plus one frame after, or when the tilt readout changes by more than 0.03. Redrawing every frame kept the phone warm while idle. Anything new that animates must count as busy there.
- `Motion.swift` (MainActivity.kt): accelerometer at 50 Hz, converted to Android's axes and m/s², then the same tilt/shake filter.
- `Sessions.swift` + `Gzip.swift` (Sessions.kt): `.rez` files in `Documents/sessions/`. gzip is written by hand around Foundation's raw DEFLATE.
- `Atomics.swift`: `AtomicFloat/Int/Bool` wrappers and `Ring`. `RezinaApp.swift`: app shell, start/stop on scene phase.

## Audio blocks and session files

- The synth always runs at **48 kHz in 192-sample blocks** (4 ms), one `Frame` per block, like Android. The source node's format is fixed at 48 kHz; if the hardware runs at another rate, `AVAudioEngine` converts.
- iOS asks for any buffer size in the callback; `Engine.render` serves it from whole blocks (`mixPos`). This adds up to one block (4 ms) of latency on top of the ~5 ms IO buffer (`setPreferredIOBufferDuration(0.005)`).
- So `.rez` files are the Android format byte for byte (v2 records the rate: 48000 here), and play at the right speed between an iPhone and a 48 kHz Android phone. A file from a 44.1 kHz Android phone plays about 9 % faster here; converting on load is in [`../PORTING.md`](../PORTING.md).
- Latency numbers go to the log: subsystem `it.automate123.rezina`, category `audio`.

## Differences from Android

- The panel starts below the status bar area / Dynamic Island (`safeAreaInsets.top`), not at a fixed 60 px.
- Toasts are drawn in the view (a pill near the bottom), not system toasts.
- "Could not save", "Could not open" and "Busy, try again" are new messages for errors Android would crash on or ignore.
- Audio stops when the app is not active (`scenePhase`), like Android `onPause`. Interruptions and route changes restart the engine.

## Not tested

Nothing has run on a device or simulator yet: only the Linux compile (xtool), the Xcode build on GitHub, and a Linux run of `Voice` (no NaNs, sane peaks). Latency, touch feel, CoreMotion signs and gzip compatibility with Android files need a real iPhone.

## Ad hoc build for a specific iPhone

Use this to test without TestFlight. It works even without an App Store Connect app record.

1. **Register the iPhone once.** Its UDID shows in `xtool devices` while the phone is on USB:
   ```bash
   bin/asc POST /v1/devices '{"data":{"type":"devices","attributes":{"name":"…","udid":"<UDID>","platform":"IOS"}}}'
   ```
2. **Build the ad hoc IPA.**
   ```bash
   gh workflow run ios.yml --ref <branch> -f adhoc=true
   ```
   The run produces the artifact `Rezina-adhoc` (`Rezina.ipa`). Its profile lists all registered iPhones.
3. **Install over USB.**
   ```bash
   gh run download <run> -n Rezina-adhoc
   xtool install --usb Rezina.ipa
   ```
   xtool re-signs the app with a development profile on the way.

Registered so far: Sergey's iPhone 11 Pro (`00008030-001271063E08802E`), added 2026-11-21.
