"""
A genuinely small Vision Transformer (patch embedding -> [cls]+positional
embeddings -> 1 transformer encoder block (multi-head self-attention +
MLP) -> classification head), implemented directly in numpy with
`autograd` for real reverse-mode automatic differentiation and trained
with real mini-batch gradient descent (Adam) on the synthetic dataset in
synthetic_data.py.

Why implemented by hand instead of in PyTorch/timm with a pretrained
checkpoint: this environment's network egress does not reach
huggingface.co, download.pytorch.org, or any other host that serves
pretrained ImageNet/ViT weights - only PyPI, npm, and plain github.com/
raw.githubusercontent.com (see docs/LIMITATIONS.md). Rather than ship an
untrained (random-weight) "vision model" that would fail every accuracy
check while still nominally satisfying an interface, this trains a real,
small, genuinely-fit-to-data model from scratch, and is honest that it is
trained on synthetic procedural data rather than a natural-image corpus.

Architecture (deliberately tiny - this targets a WASM/WebGPU browser
budget, not accuracy on natural images):
  - input: 32x32x3, normalized to roughly [-1, 1]
  - patch size 8x8 -> 16 patches, patch_dim = 8*8*3 = 192
  - embed_dim D = 32, 1 encoder block, 4 attention heads (head_dim 8)
  - MLP hidden dim = 64, GELU activation
  - LayerNorm (pre-norm) around both the attention and MLP sublayers
  - classification head reads the [cls] token's final embedding
  - ~15k parameters total
"""
import autograd.numpy as anp
from autograd import grad
import numpy as np
import json

from synthetic_data import generate_dataset, CLASSES, IMG_SIZE

PATCH = 8
N_PATCHES_PER_SIDE = IMG_SIZE // PATCH
N_PATCHES = N_PATCHES_PER_SIDE ** 2
PATCH_DIM = PATCH * PATCH * 3
D = 32
N_HEADS = 4
HEAD_DIM = D // N_HEADS
MLP_HIDDEN = 64
N_CLASSES = len(CLASSES)
SEQ_LEN = N_PATCHES + 1  # +1 for [cls]


def init_params(seed=0):
    r = np.random.default_rng(seed)

    def lin(fan_in, fan_out):
        scale = np.sqrt(2.0 / fan_in)
        return r.normal(0, scale, size=(fan_in, fan_out)).astype(np.float64)

    params = {
        "patch_w": lin(PATCH_DIM, D),
        "patch_b": np.zeros(D),
        "cls_token": r.normal(0, 0.02, size=(1, D)),
        "pos_embed": r.normal(0, 0.02, size=(SEQ_LEN, D)),
        "ln1_g": np.ones(D), "ln1_b": np.zeros(D),
        "wq": lin(D, D), "wk": lin(D, D), "wv": lin(D, D), "wo": lin(D, D),
        "ln2_g": np.ones(D), "ln2_b": np.zeros(D),
        "mlp_w1": lin(D, MLP_HIDDEN), "mlp_b1": np.zeros(MLP_HIDDEN),
        "mlp_w2": lin(MLP_HIDDEN, D), "mlp_b2": np.zeros(D),
        "ln3_g": np.ones(D), "ln3_b": np.zeros(D),
        "head_w": lin(D, N_CLASSES), "head_b": np.zeros(N_CLASSES),
    }
    return params


def extract_patches(img):
    """img: (32,32,3) float array in [-1,1] -> (N_PATCHES, PATCH_DIM)."""
    patches = []
    for py in range(N_PATCHES_PER_SIDE):
        for px in range(N_PATCHES_PER_SIDE):
            block = img[py * PATCH:(py + 1) * PATCH, px * PATCH:(px + 1) * PATCH, :]
            patches.append(block.reshape(-1))
    return anp.stack(patches)  # (N_PATCHES, PATCH_DIM)


def layer_norm(x, gamma, beta, eps=1e-5):
    mu = anp.mean(x, axis=-1, keepdims=True)
    var = anp.mean((x - mu) ** 2, axis=-1, keepdims=True)
    xn = (x - mu) / anp.sqrt(var + eps)
    return xn * gamma + beta


def gelu(x):
    # tanh approximation of GELU (matches the ONNX Gelu op's
    # approximate="tanh" mode used at export time, so numpy-forward and
    # ONNX-forward compute the identical function, not just similar ones).
    return 0.5 * x * (1.0 + anp.tanh(anp.sqrt(2.0 / anp.pi) * (x + 0.044715 * x ** 3)))


def softmax(x, axis=-1):
    x = x - anp.max(x, axis=axis, keepdims=True)
    e = anp.exp(x)
    return e / anp.sum(e, axis=axis, keepdims=True)


def forward_single(params, img):
    """img: (32,32,3) in [-1,1]. Returns logits (N_CLASSES,)."""
    patches = extract_patches(img)  # (16, 192)
    x = patches @ params["patch_w"] + params["patch_b"]  # (16, D)
    cls = params["cls_token"]  # (1, D)
    x = anp.concatenate([cls, x], axis=0)  # (17, D)
    x = x + params["pos_embed"]

    # --- attention sublayer (pre-norm) ---
    h = layer_norm(x, params["ln1_g"], params["ln1_b"])
    q = h @ params["wq"]
    k = h @ params["wk"]
    v = h @ params["wv"]

    q = q.reshape(SEQ_LEN, N_HEADS, HEAD_DIM)
    k = k.reshape(SEQ_LEN, N_HEADS, HEAD_DIM)
    v = v.reshape(SEQ_LEN, N_HEADS, HEAD_DIM)

    outs = []
    scale = 1.0 / anp.sqrt(HEAD_DIM)
    for hd in range(N_HEADS):
        qh, kh, vh = q[:, hd, :], k[:, hd, :], v[:, hd, :]
        scores = (qh @ kh.T) * scale  # (17,17)
        attn = softmax(scores, axis=-1)
        outs.append(attn @ vh)  # (17, HEAD_DIM)
    attn_out = anp.concatenate(outs, axis=-1)  # (17, D)
    attn_out = attn_out @ params["wo"]
    x = x + attn_out

    # --- MLP sublayer (pre-norm) ---
    h2 = layer_norm(x, params["ln2_g"], params["ln2_b"])
    mlp = gelu(h2 @ params["mlp_w1"] + params["mlp_b1"])
    mlp = mlp @ params["mlp_w2"] + params["mlp_b2"]
    x = x + mlp

    x = layer_norm(x, params["ln3_g"], params["ln3_b"])
    cls_out = x[0]  # (D,)
    logits = cls_out @ params["head_w"] + params["head_b"]
    return logits


def normalize_img(img_uint8):
    return (img_uint8.astype(np.float64) / 127.5) - 1.0


def batch_loss(params, imgs, labels):
    total = 0.0
    for img, label in zip(imgs, labels):
        logits = forward_single(params, normalize_img(img))
        logp_full = logits - anp.max(logits) - anp.log(anp.sum(anp.exp(logits - anp.max(logits))))
        total = total - logp_full[label]
    return total / len(labels)


def accuracy(params, imgs, labels):
    correct = 0
    for img, label in zip(imgs, labels):
        logits = forward_single(params, normalize_img(img))
        pred = int(np.argmax(logits))
        correct += int(pred == label)
    return correct / len(labels)


def flatten_params(params):
    keys = sorted(params.keys())
    flat = np.concatenate([np.asarray(params[k]).reshape(-1) for k in keys])
    shapes = {k: np.asarray(params[k]).shape for k in keys}
    return flat, keys, shapes


def unflatten_params(flat, keys, shapes):
    params = {}
    i = 0
    for k in keys:
        size = int(np.prod(shapes[k]))
        params[k] = flat[i:i + size].reshape(shapes[k])
        i += size
    return params


def train(epochs=18, batch_size=16, lr=0.02, n_per_class_train=140, n_per_class_val=30, seed=0):
    params = init_params(seed=seed)
    X_train, y_train = generate_dataset(n_per_class_train, seed=100)
    X_val, y_val = generate_dataset(n_per_class_val, seed=200)

    flat, keys, shapes = flatten_params(params)

    def loss_flat(flat_params, imgs, labels):
        p = unflatten_params(flat_params, keys, shapes)
        return batch_loss(p, imgs, labels)

    grad_fn = grad(loss_flat)

    # Adam optimizer state
    m = np.zeros_like(flat)
    v = np.zeros_like(flat)
    beta1, beta2, eps = 0.9, 0.999, 1e-8
    t = 0

    n = len(X_train)
    rng = np.random.default_rng(1)

    for epoch in range(epochs):
        perm = rng.permutation(n)
        X_train, y_train = X_train[perm], y_train[perm]
        epoch_loss = 0.0
        n_batches = 0
        for start in range(0, n, batch_size):
            xb = X_train[start:start + batch_size]
            yb = y_train[start:start + batch_size]
            g = grad_fn(flat, xb, yb)
            t += 1
            m = beta1 * m + (1 - beta1) * g
            v = beta2 * v + (1 - beta2) * (g ** 2)
            m_hat = m / (1 - beta1 ** t)
            v_hat = v / (1 - beta2 ** t)
            flat = flat - lr * m_hat / (np.sqrt(v_hat) + eps)
            epoch_loss += float(loss_flat(flat, xb, yb))
            n_batches += 1

        params = unflatten_params(flat, keys, shapes)
        val_acc = accuracy(params, X_val, y_val)
        train_acc = accuracy(params, X_train[:60], y_train[:60])
        print(f"epoch {epoch+1:2d}  loss={epoch_loss/n_batches:.4f}  train_acc={train_acc:.3f}  val_acc={val_acc:.3f}")

    return params, keys, shapes, (X_val, y_val)


if __name__ == "__main__":
    params, keys, shapes, (X_val, y_val) = train()
    final_acc = accuracy(params, X_val, y_val)
    print("FINAL VAL ACCURACY:", final_acc)

    # Save trained weights as plain numpy arrays for the ONNX export step.
    np.savez("trained_vit_weights.npz", **params)
    with open("trained_vit_meta.json", "w") as f:
        json.dump({"classes": CLASSES, "val_accuracy": final_acc}, f, indent=2)
    print("saved trained_vit_weights.npz + trained_vit_meta.json")
