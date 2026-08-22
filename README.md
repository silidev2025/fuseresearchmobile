# FUSE — Android

The [FUSE fire detection console](https://github.com/manciafrancisdave/fuseresearch)
for Meridian Court, packaged as an installable Android app.

**This is a wrapper, not a second implementation.** The console inside it is the
same HTML/CSS/JS that runs on the web, bundled into the APK and served locally by
the WebView. That is deliberate: the product's whole claim rests on the fusion
rules in `classify()`, and a native rewrite would mean a third copy of those
rules to keep in step with the web app and the Cloud Function. There are already
two, and CLAUDE.md in the web repo is uneasy about that.

| | |
|---|---|
| Package | `com.research2.fuse` |
| Firebase project | `spendwise-dec03` (the same one the web console uses) |
| Min SDK | 23 (Android 6.0) |
| Target / compile SDK | 35 (Android 15) |
| Shell | Capacitor 7 |

## What it does and does not do

It talks to the **same Firebase project, through the same security rules, as the
same accounts**. There is no separate mobile backend and no separate permission
model. If your account cannot read the event log on the web, it cannot read it
here either, for exactly the same reason.

There is **no demo mode and no simulator**. The app shows what the building's
nodes actually report, or it says plainly that it cannot reach them. A console
that invents plausible readings when the backend is down is worse than one that
goes dark, because the invented readings look real.

## Building

Requires **JDK 21** and the Android SDK (platform 35, build-tools 34+). Capacitor
7's Android library compiles at Java 21, so JDK 17 fails with `invalid source
release: 21`. Android Studio's bundled runtime (`…\Android Studio\jbr`) is a
JDK 21 and works; point `JAVA_HOME` at it.

```bash
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`. A copy of
the built artefact is committed under `dist/` so the app can be installed without
a toolchain.

To install on a device with USB debugging on:

```bash
adb install -r dist/fuse-debug.apk
```

Or copy the APK to the phone and open it — Android will ask you to allow
installation from unknown sources.

### After changing the console

The web assets live in `www/`. They are a copy of the web repo's `index.html`
and `assets/`. After updating them:

```bash
npx cap sync android    # copies www/ into the native project
cd android && ./gradlew assembleDebug
```

`npx cap sync` is not optional. Editing `www/` alone changes nothing in the APK,
because the build reads from `android/app/src/main/assets/public`.

## Signing

`dist/fuse-debug.apk` is signed with the Android debug keystore — it sideloads
and runs, but **cannot** go to Google Play and is not a trusted build for
distribution.

`dist/fuse-release.apk` is a **signed release build**: `android/app/build.gradle`
reads `android/keystore.properties` (untracked) for the keystore path, alias and
passwords, and signs with `android/fuse-release.jks` (untracked). Keep both out of
git and backed up — `*.jks`, `*.keystore` and `keystore.properties` are
gitignored, and losing the keystore means no future updates under the same
identity. To recreate the keystore on another machine:

```bash
keytool -genkey -v -keystore android/fuse-release.jks -keyalg RSA \
        -keysize 2048 -validity 10000 -alias fuse
```

Then write `android/keystore.properties` with `storeFile`, `storePassword`,
`keyAlias` and `keyPassword`.

## google-services.json is committed, deliberately

`android/app/google-services.json` holds the project id, the Android app id and
a web API key. **None of these are secrets.** A Firebase API key identifies a
project; it does not grant access to it. Access is decided by Firebase Auth plus
the rules in `firestore.rules` and `database.rules.json` in the web repository —
those are the real gate, and they are enforced server-side on every read and
write.

What must never be committed is a service-account JSON or an admin credential.
Neither is in this repository.

## Accounts

Three identities exist in the Firebase project and they are not
interchangeable. Sign in with an **operator** account.

- **Operator** — enrolled at `users/{uid}` in Firestore, and in `/admins` in RTDB
  if they may drive actuators. This is the account to use here.
- **Viewer** — enrolled with `role: viewer`. Can observe and acknowledge.
- **Node** — the credential an ESP32 publishes readings with. It is listed in
  `/devices` and has **no** `users/` document, on purpose.

Signing into the console with the node account produces a `NOT ENROLLED` card and
an empty screen. That is the security model working, not a fault. A node
credential is destined to live in firmware bolted to a wall; enrolling it would
give that firmware read access to every resident's name, phone number and email.

## Known scope

Inherited from the web console, and unchanged by packaging it:

- **Alerts and Dispatch stay empty until the Cloud Function is deployed.** Nothing
  else writes severity transitions. See `functions/` in the web repository.
- **Dispatch records that a dispatch was raised; it sends nothing.** No SMS, push
  or email leaves the system until a gateway is wired.
- **The historical charts under Monitoring are synthetic.** Only the newest point
  is real, because no reading history is stored anywhere yet.
- **Thresholds are per-device.** Editing them in Settings changes that screen and
  nothing on the server.
- **The launcher icon is upscaled from a 131×157 raster.** It is the real FUSE
  mark, generated by `tools/gen-assets.js`, and it holds up because an adaptive
  icon only shows its inner 66 of 108dp — so the mark sits at about half the
  canvas and the largest upscale is roughly 1.5×. If the original vector ever
  turns up, drop it in and re-run the generator for a sharper result.

## The nodes

The ESP32 firmware, wiring, bill of materials and calibration notes live in
[`hardware/`](https://github.com/manciafrancisdave/fuseresearch/tree/main/hardware)
in the web repository.

This app does not talk to the nodes directly. It reads what they publish to
Realtime Database, exactly as the web console does. The nodes fuse their own
readings and drive their own sounders without waiting for either.

## Not life-safety equipment

This is a monitoring aid. Local sounders must fire from the node itself, without
depending on the network, the cloud, a phone, or this app being open.
