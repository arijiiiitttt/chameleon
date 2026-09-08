# Screen-region ViT: training pipeline

This folder trains and exports the small Vision Transformer bundled at
`apps/extension/public/models/screen-region-vit.onnx`, used by
`apps/extension/src/models/scene-classifier-model.ts` to classify a
whole `<img>`/`<canvas>` region as `document` / `chart` / `photo` /
`code` / `table`.

**Why this exists at all** (full context in `docs/LIMITATIONS.md` §2 and
`docs/MODEL_PIPELINE.md`): the sandbox this repository was built in
cannot reach huggingface.co, download.pytorch.org, or any other host
that serves pretrained ImageNet/ViT checkpoints — only PyPI, npm, and
`github.com`/`raw.githubusercontent.com` are reachable. So instead of
fine-tuning a pretrained model (the normal, better approach — do this if
you have network access to one), this ViT was trained from scratch on
procedurally generated synthetic data, using `autograd` (a lightweight
numpy-compatible automatic differentiation library) instead of
PyTorch/TensorFlow, which were also unavailable (`pip install torch`
pulls a multi-GB CUDA-bundled wheel with no reachable CPU-only build,
and there wasn't disk space for it regardless).

## Files, in the order they run

1. **`synthetic_data.py`** — procedurally generates 32×32 RGB images for
   the 5 target classes. No real screenshots are used or needed here;
   run `python3 synthetic_data.py` to sanity-check the generator
   directly (prints array shapes and labels for 20 samples).
2. **`train_vit.py`** — defines the ViT (patch embedding → [cls] +
   positional embeddings → 1 encoder block → MLP → classification head,
   ~15k params) and trains it with Adam via `autograd`'s reverse-mode
   differentiation. Run `python3 train_vit.py` to retrain from scratch;
   it prints per-epoch train/val accuracy and saves
   `trained_vit_weights.npz` + `trained_vit_meta.json` (records the
   final validation accuracy achieved).
3. **`export_onnx.py`** — loads `trained_vit_weights.npz` and builds a
   real ONNX graph node-by-node with `onnx.helper`, mirroring
   `train_vit.py`'s `forward_single()` op-for-op (not a black-box
   tracer). Run `python3 export_onnx.py` to produce
   `screen-region-vit.onnx`; `onnx.checker.check_model()` runs
   automatically and will raise if the graph is malformed.
4. **`verify_parity.py`** — the actual proof this is a faithful export,
   not just "should be right": runs 100 **fresh** synthetic samples (a
   third random seed, never used in training or validation) through both
   the numpy forward pass and the real exported ONNX model via
   `onnxruntime`, and asserts (a) every prediction matches between the
   two, and (b) the max absolute logit difference is below 1e-3 (a real
   run typically shows ~2.4e-5, i.e. floating-point rounding noise, not
   a discrepancy). Run `python3 verify_parity.py` — it exits non-zero if
   parity fails.

## Reproducing end to end

```bash
pip install autograd onnx onnxruntime numpy pillow
python3 train_vit.py        # retrains, prints val accuracy, saves weights
python3 export_onnx.py      # exports + validates the ONNX graph
python3 verify_parity.py    # numerically proves the export is faithful
cp screen-region-vit.onnx ../../apps/extension/public/models/
```

## If you have real network access to pretrained model hosts

Retraining from scratch on synthetic data was a constraint of the
environment this repo was built in, not a design preference. If your
environment can reach huggingface.co or download.pytorch.org, the
better path is: fine-tune a small pretrained ViT (e.g. a distilled/tiny
ViT variant) on a **real, labeled screen-content dataset** (screenshots
of documents, charts, tables, code editors, and photos — this repo has
none; see `docs/DATASET.md`), then export that to ONNX with the same
input/output contract (`image` input `[32,32,3]` or whatever resolution
you choose, `logits` output `[5]` matching `SCENE_CLASSES` in
`scene-classifier-model.ts`, or update that file's constants to match a
different resolution/class set). The rest of the integration
(`image-scan-service.ts`, `vision-detector.ts`) doesn't need to change —
only the model file and, if you change classes, `SCENE_CLASSES` +
`SCENE_LABEL_TO_KIND`.
