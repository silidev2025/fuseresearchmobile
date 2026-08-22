# Connecting the Raspberry Pi vision pipeline to the FUSE app

This wires your working system —

```
ESP32-CAM  -->  Raspberry Pi + OpenCV  -->  [ pi/detector.py ]  -->  Firebase  -->  FUSE app
```

— so the video the Pi processes shows up on the app's dashboard, and its
fire/smoke verdict drives the app's alerts. It keeps the promise the README
makes: **one Firebase project, one auth model, no separate mobile backend.** The
Pi publishes; the app reads, exactly as it already reads sensor telemetry.

Nothing here streams smooth live video. It publishes the **latest processed
frame** (~1 frame/2s) plus a **short clip on each escalation**. For a fire
console that's the honest, low-cost trade: annotated stills that prove what the
detector saw, viewable from anywhere over cellular.

---

## The data contract

The Pi writes one Realtime Database node per camera; the app reads it. This is
the whole interface between the two halves.

```jsonc
// RTDB:  zones/cam-1
{
  "name":  "Lobby Camera",
  "floor": "Ground",
  "ip":    "192.168.1.60",
  "ts":    1755820800000,          // heartbeat, ms — refresh < 60s or the app marks it offline

  // capabilities — the app renders ONLY what a node declares here.
  // Omit all of these and the app falls back to the original five-sensor
  // ESP32 node, so existing nodes keep working unchanged.
  "mcu":         "ESP32-CAM + Raspberry Pi",
  "camModel":    "OV2640",
  "sensors":     ["flame", "gas", "temp"],   // your rig — no CO or optical smoke
  "flameSource": "vision",                   // labels flame as camera-detected, not KY-026
  "actuators":   false,                      // no fan/mist/valve -> that panel is hidden

  // live readings — only the keys named in "sensors"
  "r": { "flame": true, "gas": 1850, "temp": 41 },

  "frame": "https://firebasestorage.googleapis.com/.../latest.jpg?alt=media&token=…&v=…",
  "clip":  "https://firebasestorage.googleapis.com/.../1755820800.mp4?alt=media&token=…&v=…",
  "conf":  0.91                     // optional, shown as "91% confidence"
}
```

How the verdict becomes a dashboard state for your rig — **camera flame +
MQ-2 gas + temperature** (these rules are ported verbatim into `pi/detector.py`
from `www/assets/js/app.js`; thresholds: gas `>1100`, temp `>36 °C`):

| Situation                          | write to `r`               | app shows          |
|------------------------------------|----------------------------|--------------------|
| nothing                            | `flame:false, gas<1100`    | **NORMAL**         |
| camera sees flame only             | `flame:true`               | **CAUTION**        |
| flame **+** gas>1100 (or temp>36)  | `flame:true, gas:1850`     | **CRITICAL**       |
| gas>2600 or temp>65, no flame      | `gas:2700`                 | **WARNING**        |

Because your gas/temp sensors corroborate the camera's flame, a real fire
escalates straight to CRITICAL — which is exactly the fusion the console is for.

---

## What was changed in this repo (already done)

- `www/assets/js/backend.js` — `onZones` now passes `frame`, `clip`, `conf` and
  the capability fields (`mcu`, `camModel`, `sensors`, `flameSource`, `actuators`)
  through; `rssi` no longer defaults to a fake `-70`.
- `www/assets/js/app.js` — the camera slot in the zone detail and the zone-list
  card render the real frame (`<img>`) / clip (`<video>`); the UI is now
  **capability-driven** — it shows only the sensors a node declares, hides the
  actuator panel and mist/exhaust overrides when a node has none, labels flame as
  camera-detected, and uses the node's own MCU/camera names. Legacy five-sensor
  nodes (which declare nothing) are unaffected.
- `www/assets/css/styles.css` — `.cam__img` overlays the frame inside the camera frame.
- `pi/detector.py`, `pi/requirements.txt` — the bridge that runs on the Pi.
- `firebase/storage.rules`, `firebase/database.rules.snippet.json` — access rules.
- `.gitignore` — never commit the Pi's service-account key.

The app rebuild step (`npx cap sync` + Gradle) still has to be run by you — see
step 4 below.

---

## What YOU need to do next

### 1. Firebase console (once)
- **Enable Storage** on project `spendwise-dec03` if it isn't already. (Storage on
  recently-created projects requires the **Blaze** pay-as-you-go plan.)
- **Deploy the rules:**
  - Copy `firebase/storage.rules` into the web repo and `firebase deploy --only storage`.
  - Merge `firebase/database.rules.snippet.json` into the web repo's
    `database.rules.json`, then `firebase deploy --only database`.
- **Service account:** Project settings → Service accounts → *Generate new private
  key*. This is a real admin credential.
- Confirm you have an **operator** account to log into the app with (a node/viewer
  account shows an empty screen by design — see the README).

### 2. Raspberry Pi (once)
```bash
cd pi
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# save the service-account JSON you downloaded as:
#   pi/serviceAccountKey.json     (gitignored — do not commit it)
```

### 3. Wire in your detector, then run it
Open `pi/detector.py` and edit the three spots marked **PLUG IN YOUR PIPELINE**:
- `open_source()` — point `FRAME_SOURCE` at your ESP32-CAM stream
  (`http://<cam-ip>:81/stream`), an RTSP URL, or a USB index. Or replace it with
  the capture you already have.
- `run_detection(frame)` — delete the stub and call your OpenCV model; return
  `{"flame": bool}` (the vision part), your annotated frame, and a confidence.
- `read_sensors()` — return your **MQ-2 gas** and **temperature** values from
  wherever they reach the Pi (an ADC like an MCP3008 for the analog MQ-2, 1-Wire
  for the temperature probe, or values the ESP32 forwards).

The node's declared hardware (`FUSE_SENSORS=flame,gas,temp`, `flameSource=vision`,
no actuators) is already set for your rig at the top of the file. Then:
```bash
FUSE_ZONE_ID=cam-1 FUSE_ZONE_NAME="Lobby Camera" FUSE_ZONE_FLOOR="Ground" python3 detector.py
```
It prints `FUSE bridge up …`, uploads a frame every ~2s, heartbeats every ~8s,
and logs an Alerts event whenever the fused severity changes. One camera = one
`FUSE_ZONE_ID`; run one process per camera.

To keep it running across reboots, wrap it in a systemd service (ask and I'll
write the unit file).

### 4. Rebuild the app so the changes ship in the APK
Needs JDK 17+ and the Android SDK (per the README).
```bash
npm install
npx cap sync android          # mandatory — editing www/ alone does nothing to the APK
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 5. Verify
Sign in as the operator. With `detector.py` running you should see, within a few
seconds: **Nodes Online** tick up, **Last Reading** go green, the camera zone
appear in Monitoring with a live thumbnail, and its detail view show the frame.
Wave a lighter/heat source (or force `flame:true` in the stub) and the zone
should climb to CAUTION/CRITICAL and an Alerts event should land.

---

## Notes and honest caveats

- **Each node declares its hardware.** The app shows only the sensors listed in
  `sensors` and hides actuators when `actuators` is `false`, so there are no more
  phantom "0 °C" readings. Your node is set to `["flame","gas","temp"]`; edit
  `FUSE_SENSORS` (or `read_sensors()`) in `detector.py` if that changes. If your
  OpenCV also estimates smoke, add `"smoke"` to the list and set it in
  `run_detection()`.
- **Download-URL security.** The frame/clip URLs are capability URLs; they bypass
  Storage rules but are only handed out through auth-gated RTDB. If you need every
  fetch gated server-side, switch `upload_bytes()` to `blob.generate_signed_url()`
  (time-limited) — a ~10-line change. Ask and I'll do it.
- **The Alerts *log* now fills from the Pi**, not the Cloud Function. The web
  repo's `functions/` are still the path if you later want SMS/push dispatch;
  Dispatch remains send-nothing until a gateway is wired (unchanged scope).
- **Cost.** Overwriting `frames/<zone>/latest.jpg` keeps stills to one object per
  camera. Clips accumulate under `clips/<zone>/` — add a Storage lifecycle rule
  (e.g. delete after 7 days) if you record many.
- **Refresh is heartbeat-driven.** The app's `morph` diff only reloads the
  `<img>` when the URL string changes; `detector.py` puts a `&v=<ts>` cache-buster
  on every upload so each new frame shows without a full re-render.
