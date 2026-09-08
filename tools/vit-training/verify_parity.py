import numpy as np
import onnxruntime as ort

from synthetic_data import generate_dataset, CLASSES
from train_vit import forward_single, normalize_img

weights = np.load("trained_vit_weights.npz")
params = {k: weights[k] for k in weights.files}

session = ort.InferenceSession("screen-region-vit.onnx", providers=["CPUExecutionProvider"])
print("ONNX input:", session.get_inputs()[0].name, session.get_inputs()[0].shape)
print("ONNX output:", session.get_outputs()[0].name, session.get_outputs()[0].shape)

X, y = generate_dataset(20, seed=999)  # fresh, never-seen-before samples

max_abs_diff = 0.0
n_match = 0
for img, label in zip(X, y):
    norm = normalize_img(img)
    np_logits = np.array(forward_single(params, norm), dtype=np.float64)

    onnx_input = norm.astype(np.float32)
    onnx_logits = session.run(None, {"image": onnx_input})[0]

    diff = np.max(np.abs(np_logits - onnx_logits))
    max_abs_diff = max(max_abs_diff, diff)

    np_pred = int(np.argmax(np_logits))
    onnx_pred = int(np.argmax(onnx_logits))
    assert np_pred == onnx_pred, f"prediction mismatch: numpy={np_pred} onnx={onnx_pred}"
    n_match += int(onnx_pred == label)

print(f"max |numpy_logits - onnx_logits| over {len(X)} fresh samples: {max_abs_diff:.8f}")
print(f"ONNX model accuracy on fresh held-out synthetic samples: {n_match}/{len(X)} = {n_match/len(X):.3f}")
print("per-class:", CLASSES)

assert max_abs_diff < 1e-3, "numpy/ONNX parity check FAILED"
print("PARITY CHECK PASSED: ONNX graph is a faithful export of the trained numpy model.")
