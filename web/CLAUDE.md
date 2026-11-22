# Rezina in the browser

JavaScript port of the Android app in `../app` (read `../CLAUDE.md` for what the instrument and the looper do). It has the same behaviour, labels and session format. Each file says which Kotlin file it ports. When you change a rule there, port it here too. What this version still lacks, and what it has that the others don't: [`../PORTING.md`](../PORTING.md).

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
  - Keep imports as plain `'./name.js'` strings: the deploy finds them with a regex (`web.yml`: app, synth, sessions, worklet, soundcheck). A new `.js` file must be added to that regex.
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
- **`sessions.js`** (Sessions.kt): the `.rez` bytes, format v2 with the context's sample rate (gzip via `CompressionStream`, big-endian `DataView`), stored in IndexedDB `rezina/sessions` under Android's file names.
- **Import.** The Open… list starts with "＋ Import .rez file…". The file picker opens from the `click` after that tap: a user gesture on iOS too. The file input has no `accept`, because iOS greys out an extension it does not know. An imported file is saved under its own name (`label`), then opened.
- **`?session=demo`** opens `sessions/demo.rez` on the first tap: the sound lab's "Всё вместе" phrase (Growl, 808, Pluck; 4 bars at 100 bpm). It is not added to the list. `node tools/make-demo-session.mjs` rebuilds it from `docs/sound-lab.html`; rebuild after changing the page's phrase. Other files in `sessions/` open the same way by name (`[a-z0-9-]`).

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
  - **An AudioWorklet breaks all sound there.** If the context holds one, every sound in it clicks ~48 times a second, even the browser's own oscillator. So on Safari before 16 (`OLD_WEBKIT`: no `roundRect`, iOS motion permission API) the same `Engine` runs on the page's thread through a `ScriptProcessorNode` of 1024 samples (`startScriptEngine`). That adds ~21 ms of latency, and the debug line then shows `sp`. Chrome on those iPhones is WebKit too and gets the same.
  - `?engine=worklet` or `?engine=script` forces one engine on any browser.
  - Check new canvas or storage APIs against iOS 15 before using them.
- **Playwright WebKit** screenshots at device scale 2 show the canvas at twice its size. That is the harness, not the page: the sizes are right, and Chromium and real iPhones look fine.
- **`?debug=1`** adds a readout line `lat base+out+block=total ms [@rate] cpu N% max M`.
  - Latency: the browser's `baseLatency` and `outputLatency` plus our 4 ms block. Headless Chromium reports a fake ~100 ms output, so only real devices count. `?` means the browser does not say (iOS 15 Safari has no `outputLatency`). `@48k` is the context's sample rate.
  - `cpu`: the audio thread's busy time over the last second, as a share of real time (worklet.js `cpu`, measured with `Date.now()`, the only clock there). A desktop shows ~7 % for one Growl note.
  - `max`: the longest single render call that second, in whole ms. A 128-sample call has 2.7 ms at 48 kHz; spikes past that crackle even when `cpu` is low.
- **`?test=sound`** runs the `npm test` sound check (`soundcheck.js`, shared with `test/soundcheck.mjs`) on the phone's main thread and lists the rows, FAIL in red. It needs no tap. It also counts jumps through the whole `Engine` (0 in Node). A FAIL on a phone where Node passes means that browser computes the synth differently.
- **`?test=offline`** renders 4 s of a held Growl note with no deadline (`OfflineAudioContext`, the same worklet) and counts its jumps (samples that leap by more than 0.25; 0 on a desktop). Then, with the live synth disconnected, it plays three labelled 2 s stages: a plain browser sine, that note at ¼ level, that note at full level. A crackling sine blames the phone's browser output, not our code.
- **Test switches for crackling phones** (with or without `debug`): `?rate=native` lets the device choose the sample rate (no resampling; frames then follow that rate). `?hint=balanced|playback|<seconds>` asks for a bigger output buffer than `interactive`. `?reopen=1` opens the context, plays one sample, closes it and opens a new one: the old iOS Safari workaround for a first context at the wrong hardware rate. `?engine=script` runs the same `Engine` on the page's thread through a `ScriptProcessorNode` (1024 samples, ~21 ms more latency, not counted in `lat`), with no AudioWorklet in the context at all.

## Differences from Android

- The text readout (sound, stretch, tilt) sits on a see-through plate, and the note grid runs under it up to the panel. Android starts the grid below the text. Ring names that would fall under the plate are not drawn (`plate()`, `labelRing`).

## Tested on devices (2026-11-22)

- Checked in headless Chromium and WebKit on Linux: touch, mouse, record, loop, save, reload, open, no console errors.
- CPU per voice is ~2.5–3.5 % of a desktop core (`synth.js` in Node), about 1.5× the Kotlin cost.
- **Android Chrome:** plays fine; latency `3+24+4` ms.
- **New iPhone Safari:** plays fine; latency `2.7+10.1+4.0` ms. Tilt and shake work after the `touchend` permission, so the iOS sign flip (`IOS_SIGNS`) is right.
- **Old iPhone, iOS 15.8.7 Safari:** every sound clicked ~48 times a second, even the browser's own sine, in headphones too, at any rate or buffer size (`?rate=native`, `?hint=playback`, `?reopen=1`). Our samples were right (`?test=sound` passed, the offline render had 0 jumps). Without an AudioWorklet (`?engine=script`) it is clean, and that is now automatic there.
- Not checked: the silent switch, the wake lock, CPU on a mid-range Android with several tracks.
