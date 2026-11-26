"""The fast spine reader: reads a batch of spine cut-outs with the lab's A5 model, for the Node server (vision.js).

A5 (lab 065, 24 Nov 2026) is Qwen3-VL 2B with a LoRA add-on (rank 32) trained on 18,000 synthetic Hebrew spine
lines, 175 real Hebrew spines and 47 of the admin's approved home spines, merged into the base model here.
On 198 real test spines: 85.2% of Hebrew titles right (Qwen3-VL 8B: 90.6%), 0.75 s a spine on the GTX 1080.
Weak on Latin print (28.6%): the server lets it settle only Hebrew readings the catalogue confirms.
It was taught to answer NONE for a spine upside down (15% of its real examples were turned over).

Run once per batch under the GPU queue (gpu-lease), so the model holds the card only while it reads:
  gpu-lease -c seferehov -- python fast_read.py <in.json> <out.json>
in.json: {"items": [{"id": "...", "file": "/tmp/....jpg"}, ...]}
out.json: {"model": "...", "load_s": .., "items": {"<id>": {"text": "TITLE | AUTHOR" or "NONE", "sec": ..}}}
The picture as the lab fed it (056 armB common.py): longest side at most 1024 px, at least 96 px high; the app's
spine prompt; greedy decoding, 80 tokens at most.
"""
import json
import os
import sys
import time

import torch
from PIL import Image

MODEL = os.environ.get('FAST_READER_MODEL', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'seferehov-a5'))
PROMPT = ('This is one book spine or cover. Read its title and author exactly as printed, in the original language '
          'and script. Answer one line: TITLE | AUTHOR. If unreadable answer NONE.')
LONG = 1024
BATCH = int(os.environ.get('FAST_READER_BATCH', 1))


def load(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    if h < 96:
        im = im.resize((round(w * 96 / h), 96)); w, h = im.size
    k = LONG / max(w, h)
    if k < 1: im = im.resize((max(32, round(w * k)), max(32, round(h * k))))
    return im


def main():
    src, dst = sys.argv[1], sys.argv[2]
    items = json.load(open(src))['items']
    t0 = time.time()
    os.environ.setdefault('HF_HUB_OFFLINE', '1'); os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
    from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
    proc = AutoProcessor.from_pretrained(MODEL)
    proc.tokenizer.padding_side = 'left'
    model = Qwen3VLForConditionalGeneration.from_pretrained(MODEL, dtype=torch.float16).to('cuda').eval()
    out = {'model': os.path.basename(MODEL.rstrip('/')), 'load_s': round(time.time() - t0, 2), 'batch': BATCH, 'items': {}}
    for i in range(0, len(items), BATCH):
        part = items[i:i + BATCH]
        msgs = [[{'role': 'user', 'content': [{'type': 'image', 'image': load(x['file'])}, {'type': 'text', 'text': PROMPT}]}] for x in part]
        t = time.time()
        try:
            b = proc.apply_chat_template(msgs if BATCH > 1 else msgs[0], tokenize=True, add_generation_prompt=True,
                                         return_dict=True, return_tensors='pt', padding=BATCH > 1).to('cuda')
            with torch.no_grad():
                g = model.generate(**b, max_new_tokens=80, do_sample=False)
            texts = proc.batch_decode(g[:, b['input_ids'].shape[1]:], skip_special_tokens=True)
            sec = round((time.time() - t) / len(part), 3)
            for x, txt in zip(part, texts): out['items'][x['id']] = {'text': txt.strip(), 'sec': sec}
        except Exception as e:  # one bad picture must not lose the batch
            for x in part: out['items'][x['id']] = {'text': None, 'error': str(e)[:200], 'sec': None}
    out['total_s'] = round(time.time() - t0, 2)
    json.dump(out, open(dst, 'w'), ensure_ascii=False)


if __name__ == '__main__':
    main()
