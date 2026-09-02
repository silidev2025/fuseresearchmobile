# Progress — ESP32-CAM vision → FUSE app

_Last updated: 2026-09-03_

The ESP32-CAM now talks to Firebase directly. **There is no Raspberry Pi.** The
camera runs its own colour-threshold flame detection, serves an MJPEG stream on
the local network, and publishes its verdict to RTDB as a third fusion channel
alongside the sensor node's gas and temperature.

Transport: **RTDB** for the verdict, the camera's IP and the still's URL;
**Firebase Storage** for the still itself. Same project, same auth, same rules as
the rest of the app.

---

## Architecture

| Board | Publishes | Reads |
|---|---|---|
| ESP32-WROOM-32 (`hardware/fuse_node/`) | `ts`, `rssi`, `ip`, `r/temp`, `r/gas`, `r/smoke`, `r/co` | `ov`, `silenced`, `r/flame` |
| ESP32-CAM (`hardware/fuse_cam/`) | `camIp`, `r/flame`, `frame` | — |

Both sign in over the Firebase Auth REST API as `node-z01@fuse.local` and refresh
the token five minutes before expiry. Neither uses a Firebase library.

The two boards no longer collide. The node writes multi-path keys (`"r/temp"`
rather than a nested `{"r": {...}}` object), so a heartbeat touches only its own
fields instead of replacing the whole `r` node and erasing the camera's verdict
every five seconds.

The camera keeps the MJPEG stream off the network path entirely: a vision task
detects and encodes, the HTTP handler serves the most recent encoded frame, and a
third task on the other core does all the Firebase work. The stream cannot stall
behind a TLS handshake because it never makes one.

---

## Done ✅

**Firmware**
- `hardware/fuse_node/fuse_node.ino` — `publish()` writes multi-path keys and no
  longer writes `r/flame`. `pollOverrides()` reads `r/flame` back so the local
  sounder sees a camera-only fire; the value is discarded after 30s without a
  successful read, so a dropped link cannot latch the buzzer on.
- `hardware/fuse_cam/fuse_cam.ino` — new. Auth, detection, overlay, MJPEG server,
  `camIp` publish, `r/flame` single-key patch, JPEG upload to Storage and `frame`
  URL write.

**Firebase**
- `firebase/storage.rules` — signed-in devices may write `frames/<zone>/`, capped
  at 2 MB and `image/jpeg`. Reads still require auth; `clips/` and everything
  else still deny.
- `firebase/database.rules.json` — the full ruleset, deployed from this repo.
  Adds `camIp` and `frame` (device-writable, same condition as `ts` and `rssi`)
  and `camModel` (admin-only). **The web repo holds its own copy of this file.**
  A `firebase deploy --only database` from there would revert the camera. Keep
  the two in step, or delete the copy in the web repo.

**App**
- `backend.js` forwards `camIp`.
- `app.js` renders the live MJPEG when `camIp` is set, falls back to the Storage
  still on image error, and says in the caption that the stream is LAN-only.
- `capacitor.config.json` allows mixed content; `network_security_config.xml`
  permits cleartext to the camera's pinned address only.

**Removed**
- `pi/` and `INTEGRATION.md`. The Pi bridge, its service-account key and its
  systemd unit are gone.

---

## Pending ⏳ (your side)

1. **Set `camModel` once**, by hand, at `zones/Z-01/camModel` in the Firebase
   console, signed in as an admin — e.g. `ESP32-CAM OV2640`. It is admin-only by
   design and the camera cannot write it. **Until it exists the camera tile does
   not render at all**, because `hasCam(z)` tests `z.camModel`.
2. **Give the ESP32-CAM a static DHCP lease** matching the address pinned in
   `android/app/src/main/res/xml/network_security_config.xml` (currently
   `192.168.1.50`). Android's network security config cannot express a CIDR
   range, so the address is pinned rather than the subnet.
3. **Tune the flame thresholds** in `fuse_cam.ino` — `FLAME_R_MIN`,
   `FLAME_RG_DIFF`, `FLAME_GB_DIFF`, `FLAME_PIXEL_RATIO`. The committed values
   are untested starting points. Watch the `FUSE-CAM: verdict` serial lines
   against a real flame and real room lighting; `FLAME_PIXEL_RATIO` is the one
   that governs false positives.
4. **Check the RGB565 byte order** on your board. `detectFlame()` reads
   big-endian. If detection behaves as though red and blue are swapped, swap the
   two indices in that one line.
5. **Rebuild and install the APK**: `npx cap sync android`, then
   `./gradlew assembleDebug` with JDK 21.
6. **Back up the release keystore** — `android/fuse-release.jks` and
   `android/keystore.properties`, both untracked and on this machine only.

---

## Flashing the ESP32-CAM

The camera is an AI-Thinker ESP32-CAM on an **ESP32-CAM-MB** baseboard. The MB is
only a CH340 USB-serial programmer — it does not change the pin map, so
`hardware/fuse_cam/fuse_cam.ino` targets the AI-Thinker pinout as written.

| Setting | Value |
|---|---|
| Board | AI Thinker ESP32-CAM |
| Partition Scheme | Huge APP (3MB No OTA/1MB SPIFFS) |
| PSRAM | Enabled |
| Upload Speed | 115200 |

Partition scheme is not optional: the default app partition is too small for the
camera driver plus `WiFiClientSecure`, and the build fails with `Sketch too big`.
PSRAM is not optional either — the sketch holds a QVGA RGB565 frame with
`fb_count 2` and uses `ps_malloc`; without it `esp_camera_init` fails and the
board reboots in a loop.

With the MB there is no IO0-to-GND jumper. If upload hangs on `Connecting...`,
hold BOOT, tap RST, release BOOT.

`Brownout detector was triggered` in the serial log is a power problem, not a
firmware one — camera plus WiFi plus a TLS handshake is a real current spike. Use
a 5V/2A supply or feed 5V directly. Do not disable the brownout detector; it
turns a clear failure into random reboots.

---

## Handy commands

```bash
# Redeploy rules after editing them (run from repo root)
firebase deploy --only storage
firebase deploy --only database

# Rebuild the APK after changing www/ (run from repo root)
npm install
npx cap sync android
cd android
# JDK 21 required — e.g. on this machine:
#   $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Not committed (generated/secret): `node_modules/`, `android/build/`,
`android/local.properties`, `android/fuse-release.jks`,
`android/keystore.properties`, the synced `android/app/src/main/assets/`.
