"""Cuts every book spine out of a shelf photo, for the Node server (vision.js).

The spine finder is a small YOLO11n-OBB model (2.66 M weights, 5.7 MB) trained by the lab
(experiment 051: the admin's checked outlines plus 3,000 synthetic shelves with book covers
that are not spines). It draws a turned rectangle around each spine; each spine is cut out
straight along its own rectangle, 4% longer at each end. On the lab's 55 checked test spines:
43 cut cleanly, against 15 for the vision model's boxes; 0.07 s a photo on the CPU.

The edge rule: a rectangle that runs off the photo is kept only if the part inside still has
a spine's shape (long side at least 4 times the short side); a squarer stub is a book the
photo cut off.

POST /cut with the upright photo's bytes answers
  {"W", "H", "ms", "dropped_edge", "spines": [{"poly", "conf", "w", "h", "jpeg"}]}
poly: the spine's four corners as fractions of W and H; w, h: the cut-out's size in pixels
(h along the spine); jpeg: the cut-out, base64, upright with the spine's length vertical.
Spines left to right. Listens on 127.0.0.1 only.
"""
import base64
import io
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
from ultralytics import YOLO

HERE = os.path.dirname(os.path.abspath(__file__))
WEIGHTS = os.environ.get("SPINES_WEIGHTS", os.path.join(HERE, "models", "spines-051.pt"))
CONF = float(os.environ.get("SPINES_CONF", "0.25"))
MARGIN = 0.04
EDGE_ASPECT = 4.0
model = YOLO(WEIGHTS)
lock = threading.Lock()


def frame(q):
    """Centre, unit axis along the spine (down the photo), across axis, length, thickness."""
    q = np.asarray(q, float)
    c = q.mean(0)
    d01, d12 = np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[1])
    if d01 >= d12:
        u, L, T = (q[1] - q[0]) / d01, d01, d12
    else:
        u, L, T = (q[2] - q[1]) / d12, d12, d01
    if u[1] < 0 or (abs(u[1]) < 1e-6 and u[0] < 0):
        u = -u
    v = np.array([-u[1], u[0]])
    if v[0] < 0:
        v = -v
    return c, u, v, L, T


def keep(poly, W, H):
    """The edge rule (lab 051 edge.py)."""
    p = np.float32(poly)
    m = 0.005
    if not ((p[:, 0] < m * W).any() or (p[:, 0] > (1 - m) * W).any() or (p[:, 1] < m * H).any() or (p[:, 1] > (1 - m) * H).any()):
        return True
    a, ip = cv2.intersectConvexConvex(cv2.convexHull(p), np.float32([[0, 0], [W, 0], [W, H], [0, H]]))
    if a < 1 or ip is None:
        return False
    (_, (w, h), _) = cv2.minAreaRect(ip.reshape(-1, 2))
    return max(w, h) / max(1e-6, min(w, h)) >= EDGE_ASPECT


def cut(img, q):
    c, u, v, L, T = frame(q)
    m = L * MARGIN
    x0, x1, y0, y1 = -T / 2, T / 2, -L / 2 - m, L / 2 + m
    w, h = int(round(x1 - x0)), int(round(y1 - y0))
    if w < 4 or h < 4:
        return None, None
    M = np.array([[v[0], u[0], c[0] + x0 * v[0] + y0 * u[0]],
                  [v[1], u[1], c[1] + x0 * v[1] + y0 * u[1]]])
    crop = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    poly = [c + x * v + y * u for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    return crop, poly


def cut_spines(data):
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("not an image")
    H, W = img.shape[:2]
    t = time.time()
    with lock:
        r = model.predict(img, imgsz=1280, conf=CONF, verbose=False, device="cpu")[0]
    boxes = r.obb.xyxyxyxy.cpu().numpy() if r.obb is not None and len(r.obb) else []
    confs = r.obb.conf.cpu().numpy() if r.obb is not None and len(r.obb) else []
    out, dropped = [], 0
    for q, cf in zip(boxes, confs):
        crop, poly = cut(img, q)
        if crop is None:
            continue
        if not keep(poly, W, H):
            dropped += 1
            continue
        ok, jpg = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
        out.append({
            "poly": [[round(min(1, max(0, float(x) / W)), 4), round(min(1, max(0, float(y) / H)), 4)] for x, y in q],
            "conf": round(float(cf), 3), "w": int(crop.shape[1]), "h": int(crop.shape[0]),
            "jpeg": base64.b64encode(jpg.tobytes()).decode(), "_x": float(np.mean(q[:, 0])),
        })
    out.sort(key=lambda s: s.pop("_x"))
    return {"W": W, "H": H, "ms": round((time.time() - t) * 1000), "dropped_edge": dropped, "spines": out}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._send(200, {"ok": True, "weights": os.path.basename(WEIGHTS)} if self.path == "/health" else {"error": "not found"})

    def do_POST(self):
        if self.path != "/cut":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("content-length", 0))
        if not 0 < n <= 60_000_000:
            return self._send(400, {"error": "bad length"})
        try:
            self._send(200, cut_spines(self.rfile.read(n)))
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": str(e)[:200]})

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("SPINES_PORT", "3876"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
