# CLAUDE.md

Working notes for this repository. Read before changing anything.

## What this is

The FUSE fire-detection console packaged as an Android app (Capacitor 7).
`www/` is a **copy** of the web repo's HTML/CSS/JS, not a second implementation.
Firmware for both ESP32 boards lives in `hardware/`.

Related repo: `manciafrancisdave/fuseresearch` — web console, Cloud Function,
wiring notes. **It returns 404.** Do not assume it can be read, and do not send
someone there for a file without checking first.

## Never change these

`classify()`, `lvlOf()` and the `TH` threshold arrays exist in three places and
must behave identically:

| Where | Symbols |
|---|---|
| `www/assets/js/app.js` | `TH` (~line 30), `lvlOf` (~157), `classify` (~159) |
| `hardware/fuse_node/fuse_node.ino` | `TH_TEMP/TH_GAS/TH_SMOKE/TH_CO`, `lvlOf`, `classify` |
| Cloud Function, web repo | the same rules again |

The product's claim rests on these agreeing. If a change is genuinely required,
change all three in one commit and say so loudly. Otherwise treat them as frozen.

Check after editing `app.js`:

```bash
git diff -- www/assets/js/app.js | grep -E '^[+-].*(function classify|function lvlOf|var TH )'
```

Any output means you touched them.

## Style

**`app.js` / `backend.js`** — `var`, not `let`/`const`. Function declarations,
not arrows. String concatenation, not template literals. **No comments.** Event
handling is delegated through `document.addEventListener`; there are no inline
`on*` attributes anywhere, so do not add any. Note that `error` events do not
bubble — the `cam__img` fallback listener is registered in capture phase for
exactly this reason.

**Firmware** — comment-free, `static` helpers, matching `fuse_node.ino`'s shape.
Both sketches hand-roll JSON with `String` concatenation and parse responses with
`jsonStr`/`jsonNum`. No Firebase library, no ArduinoJson. Keep it that way.

## Who writes what to RTDB

| Writer | Keys |
|---|---|
| `fuse_node.ino` | `ts`, `rssi`, `ip`, `r/temp`, `r/gas`, `r/smoke`, `r/co` |
| `fuse_cam.ino` | `camIp`, `r/flame`, `frame` |
| Admin, by hand | `name`, `floor`, `mcu`, `camModel`, `sensors`, `flameSource`, `actuators`, `silenced`, `ov` |

The node writes **multi-path keys** (`"r/temp"`), never a nested `{"r": {...}}`
object. A nested write replaces the whole `r` node and erases the camera's
`r/flame` on the next heartbeat. This has already been a bug once.

The node also *reads* `r/flame` back in `pollOverrides()` so its local sounder
sees a camera-only fire. That readback is TTL'd (`CAM_FLAME_TTL_MS`, 30s) so a
dropped link cannot latch the buzzer on.

## Three fields that silently hide the camera

All admin-only, all set by hand. None can be written by firmware.

- **`camModel`** — `hasCam(z)` tests it. Unset means the camera tile never
  renders, no matter how correct everything else is.
- **`sensors`** must contain `"flame"`. The readings list is filtered through
  `hasSensor()`, while `classify()` reads `z.r` directly — so with `flame`
  missing, the zone can reach CRITICAL off the camera with nothing on screen
  explaining why.
- **`flameSource`** must be `"vision"`, or the app describes the ESP32-CAM as
  *"IR/UV signature present on the digital pin"*.

## Rules exist in two copies

`firebase/database.rules.json` deploys from here. The web repo holds its own copy
of the same file. **A `firebase deploy --only database` from there reverts the
camera's write permissions**, and the symptom is `PATCH -> 401` on firmware that
worked yesterday. Delete the web repo's copy when it becomes reachable.

Storage rules cannot consult RTDB — only Firestore — so the `devices/<uid>`
binding the database rules use cannot be reproduced in `storage.rules`.
`request.auth != null` plus content-type and size caps is the ceiling there.

```bash
firebase deploy --only database
firebase deploy --only storage
```

## Building

Requires **JDK 21** (Capacitor 7 compiles at 21; JDK 17 fails with
`invalid source release: 21`) and Android SDK platform 35 / build-tools 35.

```bash
npm install
npx cap sync android
cd android && ./gradlew.bat assembleDebug
```

`npx cap sync` is not optional: the build reads
`android/app/src/main/assets/public`, so editing `www/` alone changes nothing in
the APK. After building, verify the APK actually contains the change rather than
trusting the build:

```bash
unzip -p android/app/build/outputs/apk/debug/app-debug.apk \
  assets/public/assets/js/app.js | grep -c camStream
unzip -l android/app/build/outputs/apk/debug/app-debug.apk | grep network_security_config
```

**`dist/fuse-release.apk` cannot be rebuilt here.** The keystore
(`android/fuse-release.jks`, `android/keystore.properties`) is gitignored and
exists only on the original build machine. Only the debug APK can be refreshed —
say so rather than letting someone assume the release build is current.

## Testing firmware

Verify at the layer that failed, not the top. In order:

1. **Serial, 115200.** Boot prints in sequence: wifi dots, IP, `stream server on
   /stream`, `signed in, token NNN chars`. Each missing line isolates a
   different failure.
2. **Browser on the camera's WiFi** — `http://<camIp>/stream`. Tests camera,
   detection, overlay and HTTP with Firebase and the phone out of the picture.
3. **RTDB** — `camIp` matches serial, `r/flame` toggles with a real flame.
4. **Leave it 30s.** If `r/flame` reverts on its own, the sensor node is running
   pre-multi-path firmware and is overwriting it.
5. **The node reacts** — `flame CAM` on its serial within ~4s.
6. **Then the phone.**

Reading live state without a browser:

```bash
MSYS_NO_PATHCONV=1 firebase database:get /zones/Z-01
```

`r` containing a `flame` key means the node is on **old** firmware.

## Environment gotchas

- **`firebase database:set` cannot read stdin on Windows** and needs a real
  Windows path: `firebase database:set /p "$(cygpath -w file.json)" --force`.
- **MSYS rewrites leading-slash arguments** into Windows paths. Export
  `MSYS_NO_PATHCONV=1` before any `firebase database:*` call, or you get
  `Path must begin with /`.
- **PowerShell has no heredocs and no `&&`.** Use the Bash tool for those, or
  write the file first and pass a path.
- **Native stderr under PowerShell** raises `NativeCommandError` even on success.
  Check the exit code, not the presence of stderr.
- **The dev machine is not on the boards' network.** It sits on `192.168.5.x`;
  the ESP32s join SSID `BALANSAG` on `192.168.123.x`. You cannot scan for or
  reach the camera from here, and a browser on this machine cannot open the
  stream. Test from a phone on `BALANSAG`.
- **No Arduino toolchain here.** Neither sketch has ever been compiled. Never
  claim firmware builds.

## Android cleartext

Android's network security config **cannot express a CIDR range** — `<domain>`
takes hostnames, not subnets. The camera's address is pinned in
`android/app/src/main/res/xml/network_security_config.xml` and needs a matching
DHCP reservation. If the pin and the real address disagree, the failure is silent
and graceful: the `<img>` errors, the handler swaps in `z.frame`, and the tile
shows a stale still. Check the pin before debugging anything else about the
stream.

## Not life-safety equipment

A monitoring aid. The local sounder must fire from the node itself without
depending on the network, the cloud, a phone, or the app being open. Anything
that makes the buzzer depend on connectivity is a regression, whatever it does
for the dashboard.
