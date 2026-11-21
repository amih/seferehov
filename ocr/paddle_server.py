"""Reads the text on a spine cut-out with PaddleOCR trained for Hebrew (Rivok/paddleocr-hebrew,
Apache-2.0, ONNX on the CPU), for the Node server (vision.js readCrop, SPINE_OCR_URL).

Same answer as surya_server.py; the server asks this one first and Surya only when it does not
confirm the reading (vision.js readCrop):
POST /ocr with the image bytes answers {"text": "...", "lines": [...], "boxes": [...]}, boxes
being the lines with their [x1, y1, x2, y2] in pixels. This model gives no confidence: every
line gets 1. Lab 055 (20 Nov 2026, 413 approved spines): it read 62% of the titles (Hebrew 67%)
in 0.4 s a spine, against Surya's 76% in 7 s. As the app's check (stage 5, 207 spines): 78% of titles
right with this alone, 80% with Surya alone, 83% with this then Surya, 27% faster than Surya.
Listens on 127.0.0.1 only. One image at a time.
"""
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from PIL import Image

THREADS = int(os.environ.get("OCR_THREADS", "16"))
_Session = ort.InferenceSession


class Session(_Session):  # every model this package opens: at most THREADS cores
    def __init__(self, path, sess_options=None, providers=None, **kw):
        so = sess_options or ort.SessionOptions()
        so.intra_op_num_threads, so.inter_op_num_threads = THREADS, 1
        super().__init__(path, sess_options=so, providers=providers or ["CPUExecutionProvider"], **kw)


ort.InferenceSession = Session
from paddleocr_hebrew import HebrewOCR  # noqa: E402  (after the thread cap)


def model_dir():
    if os.environ.get("PADDLE_HEB_DIR"):
        return os.environ["PADDLE_HEB_DIR"]
    from huggingface_hub import snapshot_download
    return snapshot_download("Rivok/paddleocr-hebrew", revision=os.environ.get("PADDLE_HEB_REV"))


ocr = HebrewOCR.word(model_dir(), providers=["CPUExecutionProvider"])
lock = threading.Lock()


def read(image):
    bgr = np.ascontiguousarray(np.array(image)[:, :, ::-1])
    with lock:
        lines = ocr.read_array(bgr)["lines"]
    lines = sorted(lines, key=lambda l: (l["bbox"][1], -l["bbox"][2]))
    return [{"text": l["text"].strip(), "bbox": [round(v) for v in l["bbox"]], "confidence": 1.0} for l in lines if l["text"].strip()]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/ocr":
            return self.send_error(404)
        size = int(self.headers.get("Content-Length", 0))
        if not 0 < size <= 30 * 1024 * 1024:
            return self.send_error(413)
        try:
            boxes = read(Image.open(io.BytesIO(self.rfile.read(size))).convert("RGB"))
        except Exception as err:  # a broken picture must not stop the service
            return self.send_error(400, str(err)[:200])
        lines = [b["text"] for b in boxes]
        body = json.dumps({"text": "\n".join(lines), "lines": lines, "boxes": boxes}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("OCR_PORT", "3878"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
