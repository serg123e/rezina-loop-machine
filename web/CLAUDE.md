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

`.github/workflows/web.yml` runs the tests on every push touching `web/`. It publishes `web/` to GitHub Pages, **https://123automate.it/rezina-loop-machine/** (the account's Pages domain, behind Cloudflare), from `main`, or from any branch when started by hand:

```bash
gh workflow run web.yml --ref <branch>
```

- That domain does not redirect http to https, so `index.html` does it: without https there is no AudioWorklet and no sensors.
- **Cloudflare keeps `.js` for 4 hours** (`max-age=14400`, edge cache). The page itself is not cached there (10 minutes in the browser). So the deploy writes the commit into every script URL: `app.js?v=<commit>` in `index.html`, and the same for each `import` and `addModule`. A new page pulls new scripts, and old copies are never mixed in.
  - Keep imports as plain `'./name.js'` strings: the deploy finds them with a regex (`web.yml`). A new `.js` file must be added to that regex.
  - On 2026-11-22 phones kept running the old `app.js` for hours before this was in place.
- The deploy writes the commit into `sw.js` (`VERSION`), so each deploy gets a fresh offline cache. Offline lookups ignore `?v=`.
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

- **The first tap starts everything.** Browsers allow sound only after a gesture, so that tap does not play.
- **iOS motion permission** (`DeviceMotionEvent.requestPermission`) is asked when the first tap's finger lifts (`touchend`).
  - From `pointerdown` Safari refuses it with no prompt. Until 2026-11-22 it was asked there, and tilt and shake never worked on iPhones.
  - A refusal for that reason asks again on the next lift. A "Don't allow" sticks until Safari is restarted.
- **`AudioContext({sampleRate: 48000})`**, so frames are 4 ms as on Android and `.rez` files play at the same speed. If the hardware runs at another rate, the browser resamples.
- **Motion.** `accelerationIncludingGravity` goes through MainActivity's filter, with the constants rescaled from Android's 50 Hz to the event interval.
  - iOS Safari reports the opposite sign of Android and the spec, so the values are negated there (detected by `requestPermission`).
  - Portrait only: in landscape on a touch screen the app asks to turn the phone upright.
- **iOS silent switch.** `navigator.audioSession.type = 'playback'` (Safari 16.4+) makes sound play with the switch on.
- **Pause.** On `visibilitychange` the context is suspended (like Android `onPause`). Any touch resumes it, which iOS needs after a call. A screen wake lock is held while visible.
- **Drawing.** It redraws only while something moves, plus one frame after, as on iOS.
- **Old Safari (iOS 14.5–16).** AudioWorklet works there, but two newer APIs are missing:
  - `ctx.roundRect` (Safari 16+): it threw on every frame, so the screen stayed black while the sound played. Rounded rectangles go through `roundPath()` (arcTo).
  - `CompressionStream` (Safari 16.4+): sessions are stored as plain, ungzipped bytes there. `decode()` reads both, telling them apart by the gzip magic number.
  - Check new canvas or storage APIs against iOS 15 before using them.
- **Playwright WebKit** screenshots at device scale 2 show the canvas at twice its size. That is the harness, not the page: the sizes are right, and Chromium and real iPhones look fine.
- **`?debug=1`** adds a readout line `latency base+out+block = total ms · cpu N%`.
  - Latency: the browser's `baseLatency` and `outputLatency` plus our 4 ms block. Headless Chromium reports a fake ~100 ms output, so only real devices count. `?` means the browser does not say (iOS 15 Safari has no `outputLatency`).
  - `cpu`: the audio thread's busy time over the last second, as a share of real time (worklet.js `cpu`, measured with `Date.now()`, the only clock there). Near 100 % the sound crackles. A desktop shows ~7 % for one Growl note.

## Differences from Android

- The text readout (sound, stretch, tilt) sits on a see-through plate, and the note grid runs under it up to the panel. Android starts the grid below the text. Ring names that would fall under the plate are not drawn (`plate()`, `labelRing`).

## Not tested

- Checked in headless Chromium and WebKit on Linux: touch, mouse, record, loop, save, reload, open, no console errors.
- CPU per voice is ~2.5–3.5 % of a desktop core (`synth.js` in Node), about 1.5× the Kotlin cost.
- Never run on a real phone: latency, CPU on mid-range Android, iOS motion signs and permission, the silent switch, wake lock.
