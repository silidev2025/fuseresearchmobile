# Progress — Raspberry Pi vision → FUSE app

_Last updated: 2026-08-23_

Wiring the working **ESP32-CAM → Raspberry Pi + OpenCV** pipeline into the FUSE
mobile app so the processed video and its fire verdict show up on the dashboard.
Transport chosen: **Firebase Storage** (frames/clips) + **RTDB** (verdict), so it
reuses the same project and auth as the rest of the app. Full how-to lives in
[`INTEGRATION.md`](INTEGRATION.md).

Rig confirmed by the owner: **camera flame (vision) + MQ-2 gas + temperature**,
no actuators.

---

## Done ✅

**Firebase (project `spendwise-dec03`)**
- Storage enabled; `firebase/storage.rules` published in the console **and**
  deployed via the CLI (`firebase deploy --only storage`).
- Realtime Database rules: reviewed — **no change needed** (read already granted;
  the Pi writes with the Admin SDK, which bypasses rules).
- Firestore: no change needed (console already reads `events`; Pi writes via Admin SDK).
- Firebase CLI installed, logged in as `francismancia334@gmail.com`, project wired
  (`firebase.json` + `.firebaserc`, Storage only — RTDB left untouched on purpose).
- Service-account key saved at `pi/serviceAccountKey.json` (gitignored, validated).

**App (web assets in `www/`, wrapped by Capacitor)**
- `backend.js` forwards `frame`, `clip`, `conf`, and the capability fields
  (`mcu`, `camModel`, `sensors`, `flameSource`, `actuators`).
- `app.js` renders the real frame (`<img>`) / clip (`<video>`) in the zone detail
  and a live thumbnail in the zone cards; UI is **capability-driven** — shows only
  the sensors a node declares, hides absent actuators/overrides, labels flame as
  camera-detected. Legacy five-sensor nodes are unaffected.
- `styles.css` adds `.cam__img`.
- **APKs rebuilt** with all changes (JDK 21) and committed under `dist/`:
  - `dist/fuse-debug.apk` — debug-signed, installs by sideload.
  - `dist/fuse-release.apk` — release build, **signed** with the project keystore
    (`android/fuse-release.jks`, alias `fuse`) via `android/keystore.properties`;
    verified with `apksigner` (exit 0).
  - each with a matching `.sha256`.

**Raspberry Pi bridge (new, in `pi/`)**
- `detector.py` — uploads frames/clips, writes the RTDB verdict + heartbeat, logs
  a Firestore `events` row on each severity change, and declares node capabilities.
- Fusion thresholds/rules ported 1:1 from `app.js` so Pi and app agree.
- `requirements.txt` for `firebase-admin` + `opencv-python`.

---

## Pending ⏳ (your side)

1. **On the Raspberry Pi** — copy `pi/detector.py`, `pi/requirements.txt`, and
   `pi/serviceAccountKey.json` over (keep the key secret). `pip install -r
   requirements.txt`. Then fill the three plug-in spots in `detector.py`:
   - `open_source()` → your ESP32-CAM feed
   - `run_detection()` → your OpenCV flame verdict (`{"flame": bool}`)
   - `read_sensors()` → MQ-2 `gas` + `temp`
   Run: `FUSE_ZONE_ID=cam-1 FUSE_ZONE_NAME="Lobby Camera" python3 detector.py`
2. **Install the new APK** on the phone and sign in with an **operator** account;
   confirm the camera zone appears with a live frame and escalates on flame.
3. Auto-start on the Pi: install `pi/fuse-bridge.service` (see INTEGRATION.md,
   "Auto-start on boot (systemd)").
4. **Back up the release keystore.** Release signing is wired: `build.gradle`
   reads `android/keystore.properties` → `android/fuse-release.jks` (both
   untracked/gitignored, on this machine only). Save the `.jks` and its password
   somewhere safe — losing them means no future signed updates under the same
   identity.
5. Optional: `smoke` from vision (add to `FUSE_SENSORS`), signed URLs instead of
   token URLs.

---

## Handy commands

```bash
# Redeploy Storage rules after editing firebase/storage.rules (run from repo root)
firebase deploy --only storage

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
`android/keystore.properties`, `pi/serviceAccountKey.json`, the synced
`android/app/src/main/assets/`.
