"""
Generates procedural synthetic 32x32 RGB images for 5 "screen region type"
classes, used to train a small real Vision Transformer for on-device
screen-content classification (see train_vit.py).

Classes:
  0 document - text-block-like: many thin horizontal dark strokes on a
               light background (mimics a paragraph/scanned page)
  1 chart    - a bar or line chart silhouette on a light background
  2 photo    - a smooth, low-frequency gradient blob (mimics a face/photo
               region: continuous tone, no hard edges)
  3 code     - a monospace-grid-like pattern of small tinted blocks
               (mimics a code editor / terminal region)
  4 table    - an evenly spaced grid of horizontal + vertical lines
               (mimics a data table)

This is explicitly SYNTHETIC, procedurally generated data - not a
real-world labeled screen-content dataset (none exists in this
repository; see docs/LIMITATIONS.md). It is used because a real pretrained
ImageNet-scale vision model's weights are not reachable from this
environment's allowed network egress (no huggingface.co / download.
pytorch.org access), so training a small model from scratch on data we can
generate ourselves is the only way to ship a genuinely trained, verifiable
model rather than an untrained/random one.
"""
import numpy as np
from PIL import Image, ImageDraw

CLASSES = ["document", "chart", "photo", "code", "table"]
IMG_SIZE = 32
rng = np.random.default_rng(42)


def _blank(bg=None):
    if bg is None:
        bg = rng.integers(235, 256)
    img = Image.new("RGB", (IMG_SIZE, IMG_SIZE), (bg, bg, bg))
    return img, ImageDraw.Draw(img)


def make_document():
    img, d = _blank()
    y = rng.integers(2, 6)
    while y < IMG_SIZE - 2:
        x0 = rng.integers(1, 5)
        x1 = IMG_SIZE - rng.integers(1, 6)
        shade = rng.integers(20, 90)
        d.line([(x0, y), (x1, y)], fill=(shade, shade, shade), width=1)
        y += rng.integers(2, 4)
    return np.asarray(img, dtype=np.float32)


def make_chart():
    img, d = _blank()
    if rng.random() < 0.5:
        # bar chart
        n_bars = rng.integers(4, 8)
        bar_w = IMG_SIZE // n_bars
        for i in range(n_bars):
            h = rng.integers(4, IMG_SIZE - 4)
            x0 = i * bar_w + 1
            x1 = x0 + bar_w - 2
            color = tuple(int(c) for c in rng.integers(40, 180, size=3))
            d.rectangle([x0, IMG_SIZE - h, x1, IMG_SIZE - 1], fill=color)
    else:
        # line chart
        pts = []
        x = 0
        step = IMG_SIZE / rng.integers(5, 9)
        while x < IMG_SIZE:
            y = rng.integers(4, IMG_SIZE - 4)
            pts.append((x, y))
            x += step
        color = tuple(int(c) for c in rng.integers(30, 150, size=3))
        d.line(pts, fill=color, width=2)
    return np.asarray(img, dtype=np.float32)


def make_photo():
    # smooth low-frequency gradient via a few random Gaussian blobs summed,
    # then normalized to a plausible photo-tone range - deliberately has
    # NO hard edges/lines, which is what should separate it from the other
    # four (all line/grid/block-structured) classes.
    yy, xx = np.mgrid[0:IMG_SIZE, 0:IMG_SIZE]
    field = np.zeros((IMG_SIZE, IMG_SIZE), dtype=np.float32)
    for _ in range(rng.integers(2, 4)):
        cx, cy = rng.uniform(4, IMG_SIZE - 4, size=2)
        sigma = rng.uniform(6, 14)
        amp = rng.uniform(0.5, 1.0)
        field += amp * np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2)))
    field = (field - field.min()) / (field.max() - field.min() + 1e-6)
    base = rng.uniform(60, 200, size=3)
    spread = rng.uniform(30, 80, size=3)
    img = base[None, None, :] + field[:, :, None] * spread[None, None, :]
    return np.clip(img, 0, 255).astype(np.float32)


def make_code():
    img, d = _blank(bg=rng.integers(20, 45))  # code editors are often dark
    cell_w, cell_h = 3, 4
    for row in range(0, IMG_SIZE, cell_h):
        line_len = rng.integers(3, IMG_SIZE - 2)
        col = 1
        while col < line_len:
            w = rng.integers(1, 3)
            color = tuple(int(c) for c in rng.integers(120, 230, size=3))
            d.rectangle([col, row, min(col + w, IMG_SIZE - 1), row + 1], fill=color)
            col += w + rng.integers(1, 2)
    return np.asarray(img, dtype=np.float32)


def make_table():
    img, d = _blank()
    n_rows = rng.integers(3, 6)
    n_cols = rng.integers(2, 5)
    shade = rng.integers(60, 140)
    for r in range(n_rows + 1):
        y = int(r * IMG_SIZE / n_rows)
        d.line([(0, y), (IMG_SIZE - 1, y)], fill=(shade, shade, shade), width=1)
    for c in range(n_cols + 1):
        x = int(c * IMG_SIZE / n_cols)
        d.line([(x, 0), (x, IMG_SIZE - 1)], fill=(shade, shade, shade), width=1)
    return np.asarray(img, dtype=np.float32)


GENERATORS = [make_document, make_chart, make_photo, make_code, make_table]


def generate_dataset(n_per_class: int, seed: int = 0):
    local_rng = np.random.default_rng(seed)
    global rng
    images, labels = [], []
    for label, gen in enumerate(GENERATORS):
        for _ in range(n_per_class):
            rng = np.random.default_rng(local_rng.integers(0, 2**31 - 1))
            images.append(gen())
            labels.append(label)
    images = np.stack(images).astype(np.float32)
    labels = np.array(labels, dtype=np.int64)
    perm = local_rng.permutation(len(labels))
    return images[perm], labels[perm]


if __name__ == "__main__":
    X, y = generate_dataset(4)
    print(X.shape, y.shape, y)
