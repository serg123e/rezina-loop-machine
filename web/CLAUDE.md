# Rezina in the browser

JavaScript port of the Android app in `../app` (read `../CLAUDE.md` for what the instrument and the looper do). It has the same behaviour, labels and session format. Each file says which Kotlin file it ports. When you change a rule there, port it here too.

No libraries and no build step: plain ES modules, one `<canvas>`, an `AudioWorklet`, `devicemotion`, IndexedDB. Installable to the home screen (manifest + service worker), works offline after the first visit.

```
page (app.js)  ── messages: live gesture, motion, hits, commands ──▶  audio thread (worklet.js: Engine)
               ◀── state ~60/s, a track's frames when they become final ──
```

## Run and test

```bash
cd web
npm test                               # sounds vs the page, looper rules, .rez format (Node 22, no installs)
python3 -m http.server 8765            # then http://localhost:8765 (AudioWorklet needs localhost or https)
```

- **`npm test`** runs three files under `test/`:
  - `soundcheck.mjs`: the gestures of Android `VoiceTest`, checked against the same page numbers;
  - `looper.mjs`: `worklet.js`'s `Engine` without a browser;
  - `sessions.mjs`: the bytes of a `.rez` file, field by field.
- **Phones need https** for the motion sensors, so test tilt and shake on the deployed site, not over the LAN.

## Deploy

`.github/workflows/web.yml` runs the tests on every push touching `web/`. It publishes `web/` to GitHub Pages from `main`, or from any branch when started by hand:

```bash
gh workflow run web.yml --ref <branch>
```

- The deploy writes the commit into `sw.js` (`VERSION`), so each deploy gets a fresh offline cache.
- The service worker fetches from the network first, so an online visit always gets the latest files.

## Code

- **`synth.js`** (Synth.kt, Mode.kt, Voice.kt): the instruments, `Master`, `MODES` (index = Kotlin ordinal, stored in files), `Frame`.
  - Melodic instruments hold a `Melodic` (`mel`) instead of extending it. With six subclasses sharing it, V8's property lookups in `step()` went megamorphic, and every voice cost twice as much CPU.
  - Keep hot loops on one class per call site.
- **`worklet.js`** (Engine.kt): the looper and `Click`, inside an `AudioWorkletProcessor`.
  - It renders 192-sample blocks and serves the browser's 128-sample quanta from them (`mixPos`), as on iOS.
  - The page writes nothing directly: every change is a message, handled between blocks.
  - `Engine` is exported, so Node can test it.
- **`app.js`** (BandView.kt, MainActivity.kt): touches (Pointer Events), the band, the panel, grid, ghosts, toasts, the browser list, sensors, start and pause.
  - Pixel constants are Android's on a 1080 px wide screen, scaled by `px()`.
  - On a desktop the app is a portrait column in the middle.
- **`sessions.js`** (Sessions.kt): the `.rez` bytes (gzip via `CompressionStream`, big-endian `DataView`), stored in IndexedDB `rezina/sessions` under Android's file names.

## Browser specifics

- **The first tap starts everything.** Browsers allow sound only after a gesture, and iOS asks for motion permission (`DeviceMotionEvent.requestPermission`) only from a tap. That tap does not play.
- **`AudioContext({sampleRate: 48000})`**, so frames are 4 ms as on Android and `.rez` files play at the same speed. If the hardware runs at another rate, the browser resamples.
- **Motion.** `accelerationIncludingGravity` goes through MainActivity's filter, with the constants rescaled from Android's 50 Hz to the event interval.
  - iOS Safari reports the opposite sign of Android and the spec, so the values are negated there (detected by `requestPermission`).
  - Portrait only: in landscape on a touch screen the app asks to turn the phone upright.
- **iOS silent switch.** `navigator.audioSession.type = 'playback'` (Safari 16.4+) makes sound play with the switch on.
- **Pause.** On `visibilitychange` the context is suspended (like Android `onPause`). Any touch resumes it, which iOS needs after a call. A screen wake lock is held while visible.
- **Drawing.** It redraws only while something moves, plus one frame after, as on iOS.

## Not tested

- Checked in headless Chromium and WebKit on Linux: touch, mouse, record, loop, save, reload, open, no console errors.
- CPU per voice is ~2.5–3.5 % of a desktop core (`synth.js` in Node), about 1.5× the Kotlin cost.
- Never run on a real phone: latency, CPU on mid-range Android, iOS motion signs and permission, the silent switch, wake lock.
