"""Spine FITTER (lab 081, 28 Nov 2026): refits a suspect spine cut to the book's own left and right edges.

Why: the cutter sometimes takes a sliver (6-37%) of the neighbouring book into a cut, mostly in rows of leaning books,
and the cut then fails. A small model (MobileNetV3-Small, 2.7 M weights) looks at the cut widened by 25% on each
side (whole cut 128x448, top and bottom 15% strips 128x128) and answers where the book's two long edges are (top and
bottom position of each, so slant is handled). Lab test v2 (30 photos, 338 spines, official grade):
StairsCutter 303 -> 309 (+6 / -0), AnchorCutter 293 -> 296 (+3 / -0).

Where it runs in spine_server.py cut_spines(): AFTER the overlap rule, the edge rule and the partial-edge rule (on the
kept boxes), BEFORE cut() makes the jpeg. Only the cuts suspects() flags are refitted:
    flags = fitter_app.suspects([q for q, _, _ in kept], W, H)
    q = fitter_app.fit(FITTER, img, q, W, H) if flag else q      # then cut(img, q) as before
Depends only on torch, torchvision, numpy and cv2. CPU. Off switch: the caller's (e.g. SPINES_FITTER=0).

Suspect rule (lab 081, as graded): a standing cut (long side >= 3x short side) that is
  W: >= 1.6x the median thickness of the standing cuts in its row (row = standing cuts whose vertical extent overlaps
     this cut's by >= 50% of the shorter; fewer than 3 in the row -> the photo's standing cuts), or
  L: leaning 8-35 deg with >= 2 other cuts in its row leaning 8-35 deg the same way.
"""
import numpy as np
import cv2
import torch
import torch.nn as nn
import torch.nn.functional as F
import torchvision

MARGIN = 0.04          # spine_server.py: each cut 4% longer at each end
PAD = 0.25             # the model sees the cut widened by 25% of its width on each side
FW, FH, SW, SH, STRIP = 128, 448, 128, 128, 0.15
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
W_RATIO, LEAN_MIN, LEAN_MAX, LEAN_OTHERS = 1.6, 8, 35, 2


# ---- geometry (frame() and cut() as in spine_server.py) ----
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


def cut(img, q):
    c, u, v, L, T = frame(q)
    m = L * MARGIN
    x0, x1, y0, y1 = -T / 2, T / 2, -L / 2 - m, L / 2 + m
    w, h = int(round(x1 - x0)), int(round(y1 - y0))
    if w < 4 or h < 4:
        return None
    M = np.array([[v[0], u[0], c[0] + x0 * v[0] + y0 * u[0]],
                  [v[1], u[1], c[1] + x0 * v[1] + y0 * u[1]]])
    return cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))


def _box(c, u, v, x0, x1, y0, y1):
    return np.array([c + x * v + y * u for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))])


def _padded(q):
    c, u, v, L, T = frame(q)
    return _box(c, u, v, -T / 2 - PAD * T, T / 2 + PAD * T, -L / 2, L / 2)


def _area(p):
    p = np.asarray(p, float); x, y = p[:, 0], p[:, 1]
    return abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2


def _refit(q, l, r):
    """The box between two lines across the cut: l = (top, bottom), r = (top, bottom), fractions of the cut's width
    at the crop's first and last row; the ends stay where the cut's ends are (without the 4% margins)."""
    c, u, v, L, T = frame(q)
    m0 = L * MARGIN
    o = c + (-T / 2) * v + (-L / 2 - m0) * u
    w, h = int(round(T)), int(round(L + 2 * m0))
    m = (h - h / (1 + 2 * MARGIN)) / 2
    def at(t, b, y): return (t + (b - t) * y / h) * w
    quad = np.array([[at(l[0], l[1], m), m], [at(r[0], r[1], m), m], [at(r[0], r[1], h - m), h - m], [at(l[0], l[1], h - m), h - m]])
    P = o + quad[:, :1] * v + quad[:, 1:2] * u
    if _area(P) < 4:
        return None
    return cv2.boxPoints(cv2.minAreaRect(np.float32(P).reshape(-1, 2))).astype(np.float64)


def _same_order(q, new):
    """new rectangle with its corners in the same order (same corner roles) as q's."""
    c, u, v, L, T = frame(q); c2, u2, v2, L2, T2 = frame(new)
    out = []
    for p in np.asarray(q, float):
        d = p - c
        sx, sy = np.sign(d @ v) or 1.0, np.sign(d @ u) or 1.0
        out.append(c2 + sx * T2 / 2 * v2 + sy * L2 / 2 * u2)
    return np.array(out)


# ---- suspect rule ----
def suspects(kept_polys, W=None, H=None):
    info = []
    for q in kept_polys:
        q = np.asarray(q, float); c, u, v, L, T = frame(q)
        t = float(np.degrees(np.arctan2(-u[0], u[1])))
        info.append(dict(t=t, L=L, T=T, y0=q[:, 1].min(), y1=q[:, 1].max(), stand=L >= 3 * T))
    stand = [i for i, g in enumerate(info) if g['stand']]
    out = []
    for i, g in enumerate(info):
        row = [j for j in stand if min(g['y1'], info[j]['y1']) - max(g['y0'], info[j]['y0'])
               >= 0.5 * min(g['y1'] - g['y0'], info[j]['y1'] - info[j]['y0'])]
        ref = row if len(row) >= 3 else stand
        med = float(np.median([info[j]['T'] for j in ref])) if ref else g['T']
        ratio = g['T'] / med if med else 1.0
        lean = LEAN_MIN <= abs(g['t']) <= LEAN_MAX and g['stand']
        others = sum(1 for j in row if j != i and LEAN_MIN <= abs(info[j]['t']) <= LEAN_MAX
                     and np.sign(info[j]['t']) == np.sign(g['t']))
        out.append(bool((g['stand'] and ratio >= W_RATIO) or (lean and others >= LEAN_OTHERS)))
    return out


# ---- model ----
class Fitter(nn.Module):
    def __init__(self):
        super().__init__()
        self.f = torchvision.models.mobilenet_v3_small(weights=None).features
        self.head = nn.Sequential(nn.Linear(3 * 576 * 4, 256), nn.Hardswish(), nn.Dropout(0.2), nn.Linear(256, 4))

    def col(self, x):
        z = self.f(x).mean(2)
        return F.adaptive_avg_pool1d(z, 4).flatten(1)

    def forward(self, a, b, c):
        return self.head(torch.cat([self.col(a), self.col(b), self.col(c)], 1))


def load(path):
    ck = torch.load(path, map_location='cpu', weights_only=True)
    m = Fitter(); m.load_state_dict(ck['state'] if 'state' in ck else ck); m.eval()
    return m


def _views(img):
    h = img.shape[0]; s = max(2, int(round(STRIP * h)))
    out = []
    for im, (w2, h2) in ((img, (FW, FH)), (img[:s], (SW, SH)), (img[h - s:], (SW, SH))):
        r = cv2.resize(im, (w2, h2), interpolation=cv2.INTER_AREA if im.shape[1] > w2 else cv2.INTER_LINEAR)
        r = (cv2.cvtColor(r, cv2.COLOR_BGR2RGB).astype(np.float32) / 255 - MEAN) / STD
        out.append(torch.from_numpy(r.transpose(2, 0, 1).copy()).unsqueeze(0))
    return out


def edges(model, img_bgr, poly):
    """(l_top, l_bot, r_top, r_bot) of the book, fractions of the cut's width (may be < 0 or > 1)."""
    crop = cut(img_bgr, _padded(poly).astype(np.float32))
    if crop is None:
        return None
    with torch.no_grad():
        p = model(*_views(crop)).numpy()[0]
    return p * (1 + 2 * PAD) - PAD


def fit(model, img_bgr, poly, W=None, H=None):
    """The refitted box (4 corners, photo pixels, same corner order as poly); poly unchanged if it cannot be fitted."""
    poly = np.asarray(poly, float)
    e = edges(model, img_bgr, poly)
    if e is None:
        return poly
    new = _refit(poly, (e[0], e[1]), (e[2], e[3]))
    return poly if new is None else _same_order(poly, new)
