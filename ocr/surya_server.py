"""Reads the text on a cover photo with Surya OCR, for the Node server (vision.js).

Surya reads Hebrew far better than Tesseract or the vision model (92% of the words of
a vowel-pointed back cover, against 65% and invented text). The models load once;
POST /ocr with the image bytes answers {"text": "...", "lines": [...]}.
Listens on 127.0.0.1 only. One image at a time (~30 s on the CPU).
"""
import io
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image
from surya.detection import DetectionPredictor
from surya.foundation import FoundationPredictor
from surya.recognition import RecognitionPredictor

foundation = FoundationPredictor()
detector = DetectionPredictor()
recognizer = RecognitionPredictor(foundation)
lock = threading.Lock()


def read(image):
    with lock:
        [page] = recognizer([image], det_predictor=detector, math_mode=False)
    # Top to bottom; Surya gives each line's box.
    lines = sorted(page.text_lines, key=lambda l: (l.bbox[1], -l.bbox[2]))
    # Surya marks bold or italic print with HTML tags: plain text only.
    texts = [re.sub(r"</?(b|i|u|sup|sub|math)>", "", l.text.replace("<br>", "\n")).strip() for l in lines]
    return [t for t in texts if t]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/ocr":
            return self.send_error(404)
        size = int(self.headers.get("Content-Length", 0))
        if not 0 < size <= 30 * 1024 * 1024:
            return self.send_error(413)
        try:
            image = Image.open(io.BytesIO(self.rfile.read(size))).convert("RGB")
            lines = read(image)
        except Exception as err:  # a broken picture must not stop the service
            return self.send_error(400, str(err)[:200])
        body = json.dumps({"text": "\n".join(lines), "lines": lines}, ensure_ascii=False).encode()
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
    port = int(os.environ.get("OCR_PORT", "3872"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
