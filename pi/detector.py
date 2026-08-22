#!/usr/bin/env python3
"""
FUSE — Raspberry Pi vision bridge.

Takes the video your Pi already processes with OpenCV, and publishes it to the
same Firebase project the FUSE console (web + Android) reads from. Nothing here
invents readings: it uploads the frame you pass in and the verdict you compute.

Data flow (this file is the arrow that was missing):

    ESP32-CAM --> Raspberry Pi + OpenCV --> [ detector.py ] --> Firebase --> app

For each processed frame it:
  1. uploads the annotated JPEG to Storage at frames/<zone>/latest.jpg
  2. (on a detection event) uploads a short MP4 to clips/<zone>/<ts>.mp4
  3. writes the verdict + frame URL + heartbeat to RTDB zones/<zone>
  4. writes a Firestore `events` doc when the fused severity changes level,
     so the Alerts tab fills in without the Cloud Function.

The RTDB shape and the fusion rules below are a 1:1 match with the console
(www/assets/js/app.js: TH, lvlOf, classify). Keep them in step if the web app's
thresholds ever change.

Setup:
    pip install -r requirements.txt
    # put your Firebase service-account JSON next to this file as
    # serviceAccountKey.json  (it is gitignored — never commit it)
    python3 detector.py

You supply two things, marked "PLUG IN YOUR PIPELINE" below:
  - a frame source (RTSP/HTTP/USB) in open_source()
  - your OpenCV verdict in run_detection(frame)
"""

import os
import socket
import time
import uuid
from urllib.parse import quote

import cv2
import firebase_admin
from firebase_admin import credentials, db, firestore, storage

HERE = os.path.dirname(os.path.abspath(__file__))

DATABASE_URL   = "https://spendwise-dec03-default-rtdb.firebaseio.com"
STORAGE_BUCKET = "spendwise-dec03.firebasestorage.app"
SERVICE_KEY    = os.path.join(HERE, "serviceAccountKey.json")

ZONE_ID   = os.environ.get("FUSE_ZONE_ID", "cam-1")
ZONE_NAME = os.environ.get("FUSE_ZONE_NAME", "Lobby Camera")
ZONE_FLOOR = os.environ.get("FUSE_ZONE_FLOOR", "Ground")

ZONE_MCU     = os.environ.get("FUSE_MCU", "ESP32-CAM + Raspberry Pi")
ZONE_CAM     = os.environ.get("FUSE_CAM_MODEL", "OV2640")
ZONE_SENSORS = [s for s in os.environ.get("FUSE_SENSORS", "flame,gas,temp").split(",") if s]
FLAME_SOURCE = os.environ.get("FUSE_FLAME_SOURCE", "vision")
ZONE_ACTUATORS = [a for a in os.environ.get("FUSE_ACTUATORS", "").split(",") if a]

FRAME_SOURCE = os.environ.get("FUSE_SOURCE", "http://192.168.1.50:81/stream")

FRAME_INTERVAL_S = 2.0
HEARTBEAT_S      = 8.0
JPEG_QUALITY     = 70
CLIP_SECONDS     = 6

TH = {"temp": [36, 48, 65], "gas": [1100, 1800, 2600],
      "smoke": [5, 10, 18], "co": [50, 120, 300]}
SEV = ["NORMAL", "CAUTION", "WARNING", "CRITICAL"]


def lvl_of(value, thresholds):
    lvl = 0
    for i, t in enumerate(thresholds):
        if value > t:
            lvl = i + 1
    return lvl


def classify(r):
    """Return the fused severity level 0..3 for a reading dict. Mirrors classify()."""
    L = {
        "smoke": lvl_of(r.get("smoke", 0), TH["smoke"]),
        "flame": 2 if r.get("flame") else 0,
        "temp":  lvl_of(r.get("temp", 0), TH["temp"]),
        "gas":   lvl_of(r.get("gas", 0), TH["gas"]),
        "co":    lvl_of(r.get("co", 0), TH["co"]),
    }
    base = max(L.values())
    elev = sum(1 for v in L.values() if v >= 1)
    if elev == 0:
        level = 0
    elif elev == 1:
        level = 2 if base >= 3 else 1
    else:
        level = min(3, base + 1)
    if L["flame"] >= 2 and (L["smoke"] >= 1 or L["temp"] >= 1):
        level = 3
    if elev >= 4:
        level = 3
    return level


def reading_summary(r):
    parts = []
    if r.get("flame"):
        parts.append("flame DETECTED")
    if r.get("smoke", 0) > TH["smoke"][0]:
        parts.append("smoke %.1f %%obs" % r["smoke"])
    if r.get("temp", 0) > TH["temp"][0]:
        parts.append("temp %.1f C" % r["temp"])
    if not parts:
        parts.append("vision nominal")
    return " · ".join(parts)


def init_firebase():
    if not os.path.exists(SERVICE_KEY):
        raise SystemExit(
            "Missing %s.\n"
            "Firebase console -> Project settings -> Service accounts -> "
            "Generate new private key, and save it there." % SERVICE_KEY)
    cred = credentials.Certificate(SERVICE_KEY)
    firebase_admin.initialize_app(cred, {
        "databaseURL": DATABASE_URL,
        "storageBucket": STORAGE_BUCKET,
    })
    return db.reference("zones/" + ZONE_ID), firestore.client(), storage.bucket()


def upload_bytes(bucket, path, data, content_type):
    """Upload and return a stable Firebase download URL (with a cache-buster)."""
    blob = bucket.blob(path)
    token = str(uuid.uuid4())
    blob.metadata = {"firebaseStorageDownloadTokens": token}
    blob.upload_from_string(data, content_type=content_type)
    return ("https://firebasestorage.googleapis.com/v0/b/%s/o/%s"
            "?alt=media&token=%s&v=%d"
            % (bucket.name, quote(path, safe=""), token, int(time.time())))


def now_ms():
    return int(time.time() * 1000)


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return ""


# --------------------------------------------------------------------------- #
# PLUG IN YOUR PIPELINE                                                        #
# --------------------------------------------------------------------------- #

def open_source():
    """Open your frame source. Replace with your existing capture if you have one."""
    cap = cv2.VideoCapture(FRAME_SOURCE)
    if not cap.isOpened():
        raise SystemExit("Could not open frame source: %r" % FRAME_SOURCE)
    return cap


def run_detection(frame):
    """
    Your OpenCV detection goes here (the vision part only).

    Return (reading, annotated, confidence):
      reading    the VISION readings — {"flame": bool} (add "smoke": %obs only if
                 your pipeline estimates smoke). Physical sensors (gas, temp) are
                 added separately by read_sensors(); don't set them here.
      annotated  the frame to publish (draw your boxes/labels on it)
      confidence 0..1, or None

    Alert behaviour with your rig (vision flame + MQ-2 gas + temperature):
      flame only .......................... CAUTION
      flame + gas over 1100 (or temp>36) .. CRITICAL   (corroborated)
      gas/temp elevated, no flame ......... CAUTION / WARNING

    The stub just runs end-to-end. DELETE it and call your real detector, e.g.:
      flame, boxes, confidence = your_model(frame)
      reading["flame"] = flame
      annotated = draw(frame, boxes)
    """
    annotated = frame
    reading = {"flame": False}
    confidence = None
    return reading, annotated, confidence


def read_sensors():
    """
    Return this node's PHYSICAL (non-vision) readings. Yours: MQ-2 gas + temperature.

    Wire these to however the sensors reach the Pi — an ADC such as an MCP3008 for
    the analog MQ-2, 1-Wire for the temperature probe, or values the ESP32
    forwards. Return only the keys this node has, and keep them in sync with
    FUSE_SENSORS. Units: gas = MQ-2 raw ADC (0-4095), temp = degrees C.
    """
    return {"gas": 0.0, "temp": 0.0}


def record_clip(cap, bucket, seconds):
    """Grab a few seconds and upload as MP4. Returns the clip URL, or None."""
    fps = cap.get(cv2.CAP_PROP_FPS) or 15
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 480)
    tmp = os.path.join(HERE, "_clip.mp4")
    writer = cv2.VideoWriter(tmp, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    frames = int(fps * seconds)
    for _ in range(frames):
        ok, fr = cap.read()
        if not ok:
            break
        writer.write(run_detection(fr)[1])
    writer.release()
    with open(tmp, "rb") as fh:
        data = fh.read()
    os.remove(tmp)
    return upload_bytes(bucket, "clips/%s/%d.mp4" % (ZONE_ID, now_ms()), data, "video/mp4")


def main():
    zone_ref, fs, bucket = init_firebase()
    cap = open_source()

    zone_ref.update({
        "name": ZONE_NAME, "floor": ZONE_FLOOR, "ip": local_ip(),
        "mcu": ZONE_MCU, "camModel": ZONE_CAM,
        "sensors": ZONE_SENSORS, "flameSource": FLAME_SOURCE,
        "actuators": ZONE_ACTUATORS if ZONE_ACTUATORS else False,
    })
    print("FUSE bridge up · zone=%s · sensors=%s · source=%r"
          % (ZONE_ID, ",".join(ZONE_SENSORS), FRAME_SOURCE))

    last_frame_up = 0.0
    last_beat = 0.0
    last_level = 0

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                time.sleep(0.5)
                continue

            reading, annotated, confidence = run_detection(frame)
            reading.update(read_sensors())
            level = classify(reading)
            t = time.time()

            frame_url = None
            if t - last_frame_up >= FRAME_INTERVAL_S:
                ok_jpg, buf = cv2.imencode(
                    ".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
                if ok_jpg:
                    frame_url = upload_bytes(
                        bucket, "frames/%s/latest.jpg" % ZONE_ID,
                        buf.tobytes(), "image/jpeg")
                last_frame_up = t

            clip_url = None
            if level > last_level:
                clip_url = record_clip(cap, bucket, CLIP_SECONDS)
            if level != last_level:
                fs.collection("events").add({
                    "ts": now_ms(), "zone": ZONE_ID,
                    "from": SEV[last_level], "to": SEV[level],
                    "readings": reading_summary(reading), "acked": False,
                })
                last_level = level

            if frame_url is not None or (t - last_beat) >= HEARTBEAT_S:
                r = {}
                for s in ZONE_SENSORS:
                    r[s] = bool(reading.get("flame")) if s == "flame" else float(reading.get(s, 0))
                patch = {"ts": now_ms(), "r": r}
                if frame_url is not None:
                    patch["frame"] = frame_url
                if clip_url is not None:
                    patch["clip"] = clip_url
                if confidence is not None:
                    patch["conf"] = float(confidence)
                zone_ref.update(patch)
                last_beat = t

            time.sleep(0.05)
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        cap.release()


if __name__ == "__main__":
    main()
