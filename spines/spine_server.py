"""Cuts every book spine out of a shelf photo, for the Node server (vision.js).

The spine finder is a small YOLO11n-OBB model (2.66 M weights, 5.7 MB) trained by the lab
(experiment 051: the admin's checked outlines plus 3,000 synthetic shelves with book covers
that are not spines). It draws a turned rectangle around each spine; each spine is cut out
straight along its own rectangle, 4% longer at each end. On the lab's 55 checked test spines:
43 cut cleanly, against 15 for the vision model's boxes; 0.07 s a photo on the CPU.

The edge rule: a rectangle that runs off the photo is kept only if at least 85% of it is
inside the photo and the part inside still has a spine's shape (long side at least 4 times
the short side); otherwise it is a book the photo cut off (24 Nov 2026: two such books were
declined as bad cuts).

Cut off by the edge, part 2 (lab 079, Ami 27 Nov 2026): a rectangle that touches the photo's
edge is left out when an end of the spine is at the edge (top or bottom for a standing spine)
and the part inside is shorter than 80% of the median length of the cuts in the same photo
that touch no edge and stand the same way (upright or lying), or when a side is at the edge
and the part inside is thinner than 50% of their median thickness (a sliver of a spine the
photo cut lengthwise). A short book whole at the photo's side stays. Half a spine is rarely readable. With fewer than 3 such cuts to compare
with (a close-up where every spine runs from edge to edge) nothing is left out.
SPINES_EDGE_PARTIAL=0 turns it off.

Overlaps: a rectangle that covers 35% or more of a surer one (or is 35% covered by it) is
the same spine found twice, often half of it; only the surer one is kept (24 Nov 2026).

POST /cut with the upright photo's bytes answers
  {"W", "H", "ms", "dropped_edge", "dropped_partial", "dropped_overlap", "spines": [{"poly", "conf", "w", "h", "jpeg"}]}
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

HERE = os.path.dirname(os.path.abspath(__file__))
WEIGHTS = os.environ.get("SPINES_WEIGHTS", os.path.join(HERE, "models", "spines-051.pt"))
CONF = float(os.environ.get("SPINES_CONF", "0.25"))
MARGIN = 0.04
EDGE_ASPECT = 4.0
EDGE_INSIDE = 0.85
OVERLAP = 0.35
EDGE_PARTIAL = os.environ.get("SPINES_EDGE_PARTIAL", "1") != "0"
PARTIAL_LEN = 0.80
PARTIAL_THIN = 0.50
PARTIAL_MIN_REF = 3
EDGE_MARGIN = 0.005
model = None
lock = threading.Lock()


def load():
    global model
    if model is None:
        from ultralytics import YOLO
        model = YOLO(WEIGHTS)
    return model


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


def touches(poly, W, H, axis=None):
    """Does the rectangle reach (or cross) the photo's edge? axis 0: the left or right edge only,
    1: the top or bottom only, None: any."""
    p = np.float32(poly)
    m = EDGE_MARGIN
    x = bool((p[:, 0] < m * W).any() or (p[:, 0] > (1 - m) * W).any())
    y = bool((p[:, 1] < m * H).any() or (p[:, 1] > (1 - m) * H).any())
    return x if axis == 0 else y if axis == 1 else x or y


def inside(poly, W, H):
    """(area inside the photo, the part inside as points or None)."""
    return cv2.intersectConvexConvex(cv2.convexHull(np.float32(poly)), np.float32([[0, 0], [W, 0], [W, H], [0, H]]))


def keep(poly, W, H):
    """The edge rule (lab 051 edge.py)."""
    p = np.float32(poly)
    if not touches(p, W, H):
        return True
    a, ip = inside(p, W, H)
    if a < 1 or ip is None or a < EDGE_INSIDE * cv2.contourArea(cv2.convexHull(p)):
        return False
    (_, (w, h), _) = cv2.minAreaRect(ip.reshape(-1, 2))
    return max(w, h) / max(1e-6, min(w, h)) >= EDGE_ASPECT


def partial_edge(boxes, W, H, len_share=PARTIAL_LEN, thin_share=PARTIAL_THIN, min_ref=PARTIAL_MIN_REF):
    """Which rectangles are spines the photo's edge cut off (lab 079): True = leave out.
    An end of the spine at the edge (top or bottom for a standing spine) can make it short; a
    side at the edge (left or right) can make it thin. A short book whole at the photo's side
    is not taken for a cut-off one."""
    info = []
    for q in boxes:
        _, u, v, L, T = frame(q)
        up = abs(u[1]) >= abs(u[0])
        at_end, at_side = touches(q, W, H, 1 if up else 0), touches(q, W, H, 0 if up else 1)
        if at_end or at_side:  # the part inside the photo, measured along and across the spine
            a, ip = inside(q, W, H)
            if a < 1 or ip is None:
                L = T = 0.0
            else:
                ip = ip.reshape(-1, 2).astype(float)
                L, T = np.ptp(ip @ u), np.ptp(ip @ v)
        info.append((at_end, at_side, up, L, T))
    drop = []
    for at_end, at_side, up, L, T in info:
        ref = [(l, t) for e, s, u2, l, t in info if not e and not s and u2 == up]
        if not (at_end or at_side) or len(ref) < min_ref:
            drop.append(False)
            continue
        mL, mT = np.median([l for l, _ in ref]), np.median([t for _, t in ref])
        drop.append(bool((at_end and L < len_share * mL) or (at_side and T < thin_share * mT)))
    return drop


def overlaps(a, b):
    """Share of the smaller of two rectangles that the other covers."""
    a, b = cv2.convexHull(np.float32(a)), cv2.convexHull(np.float32(b))
    inter, _ = cv2.intersectConvexConvex(a, b)
    return inter / max(1e-6, min(cv2.contourArea(a), cv2.contourArea(b)))


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
        r = load().predict(img, imgsz=1280, conf=CONF, verbose=False, device="cpu")[0]
    boxes = r.obb.xyxyxyxy.cpu().numpy() if r.obb is not None and len(r.obb) else []
    confs = r.obb.conf.cpu().numpy() if r.obb is not None and len(r.obb) else []
    dropped, twice, kept = 0, 0, []
    for k in sorted(range(len(confs)), key=lambda k: -confs[k]):
        q, cf = boxes[k], confs[k]
        if any(overlaps(q, o) >= OVERLAP for o, _, _ in kept):
            twice += 1
            continue
        crop, poly = cut(img, q)
        if crop is None:
            continue
        if not keep(q, W, H):
            dropped += 1
            continue
        kept.append((q, cf, crop))
    partial = partial_edge([q for q, _, _ in kept], W, H) if EDGE_PARTIAL else [False] * len(kept)
    if any(partial):
        print(f"{W}x{H}: {sum(partial)} of {len(kept)} cuts cut off by the photo's edge left out", flush=True)
    out = []
    for (q, cf, crop), part in zip(kept, partial):
        if part:
            continue
        ok, jpg = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
        out.append({
            "poly": [[round(min(1, max(0, float(x) / W)), 4), round(min(1, max(0, float(y) / H)), 4)] for x, y in q],
            "conf": round(float(cf), 3), "w": int(crop.shape[1]), "h": int(crop.shape[0]),
            "jpeg": base64.b64encode(jpg.tobytes()).decode(), "_x": float(np.mean(q[:, 0])),
        })
    out.sort(key=lambda s: s.pop("_x"))
    return {"W": W, "H": H, "ms": round((time.time() - t) * 1000), "dropped_edge": dropped, "dropped_partial": sum(partial), "dropped_overlap": twice, "spines": out}


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
    load()
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
