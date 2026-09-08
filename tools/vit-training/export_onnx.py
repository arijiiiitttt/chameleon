"""
Exports the numpy/autograd-trained ViT weights (trained_vit_weights.npz)
into a real ONNX graph built node-by-node with onnx.helper, so the graph
topology is an explicit, auditable mirror of forward_single() in
train_vit.py - not a black-box tracer/converter. Verified for exact
numerical parity against the numpy forward pass in verify_parity.py.

Batch size is fixed at 1 (dynamic batching isn't needed for this use
case: the extension analyzes one screen region crop at a time).
"""
import numpy as np
import onnx
from onnx import helper, TensorProto

from train_vit import (
    PATCH, N_PATCHES_PER_SIDE, N_PATCHES, PATCH_DIM, D, N_HEADS, HEAD_DIM,
    MLP_HIDDEN, N_CLASSES, SEQ_LEN, IMG_SIZE,
)


def to_tensor(name, arr):
    arr = np.asarray(arr, dtype=np.float32)
    return helper.make_tensor(name, TensorProto.FLOAT, arr.shape, arr.flatten().tolist())


def to_int64_tensor(name, arr):
    arr = np.asarray(arr, dtype=np.int64)
    return helper.make_tensor(name, TensorProto.INT64, arr.shape, arr.flatten().tolist())


def build_graph(weights: dict) -> onnx.ModelProto:
    nodes = []
    initializers = []

    def const(name, arr):
        initializers.append(to_tensor(name, arr))

    def const_i64(name, arr):
        initializers.append(to_int64_tensor(name, arr))

    # ---- weights as initializers ----
    for key in weights.files:
        const(key, weights[key])

    # small fixed constants used by the graph
    const("eps", np.array([1e-5], dtype=np.float32))
    const("half", np.array([0.5], dtype=np.float32))
    const("one", np.array([1.0], dtype=np.float32))
    const("gelu_c1", np.array([np.sqrt(2.0 / np.pi)], dtype=np.float32))
    const("gelu_c2", np.array([0.044715], dtype=np.float32))
    const("attn_scale", np.array([1.0 / np.sqrt(HEAD_DIM)], dtype=np.float32))

    # input: raw 32x32x3 image, values already normalized to ~[-1,1] by
    # the caller (JS side does `pixel/127.5 - 1`, identical to
    # normalize_img() in train_vit.py, so this graph starts from the same
    # numeric contract the numpy model was trained/evaluated on).
    input_info = helper.make_tensor_value_info("image", TensorProto.FLOAT, [IMG_SIZE, IMG_SIZE, 3])
    output_info = helper.make_tensor_value_info("logits", TensorProto.FLOAT, [N_CLASSES])

    def node(op, inputs, outputs, **attrs):
        n = helper.make_node(op, inputs, outputs, **attrs)
        nodes.append(n)
        return outputs[0]

    # ---- patch extraction: (32,32,3) -> (4,8,4,8,3) -> transpose -> (16,192) ----
    const_i64("shape_5d", np.array([N_PATCHES_PER_SIDE, PATCH, N_PATCHES_PER_SIDE, PATCH, 3], dtype=np.int64))
    x = node("Reshape", ["image", "shape_5d"], ["patches_5d"])
    x = node("Transpose", [x], ["patches_5d_t"], perm=[0, 2, 1, 3, 4])
    const_i64("shape_patches", np.array([N_PATCHES, PATCH_DIM], dtype=np.int64))
    x = node("Reshape", [x, "shape_patches"], ["patches"])

    # ---- patch embedding: (16,192) @ (192,32) + b -> (16,32) ----
    x = node("MatMul", [x, "patch_w"], ["patch_emb_mm"])
    x = node("Add", [x, "patch_b"], ["patch_emb"])

    # ---- prepend [cls] token: concat (1,32)+(16,32) -> (17,32) ----
    x = node("Concat", ["cls_token", x], ["with_cls"], axis=0)
    x = node("Add", [x, "pos_embed"], ["x0"])

    def layer_norm(x_in, gamma, beta, prefix):
        mu = node("ReduceMean", [x_in], [f"{prefix}_mu"], axes=[-1], keepdims=1)
        centered = node("Sub", [x_in, mu], [f"{prefix}_centered"])
        sq = node("Mul", [centered, centered], [f"{prefix}_sq"])
        var = node("ReduceMean", [sq], [f"{prefix}_var"], axes=[-1], keepdims=1)
        var_eps = node("Add", [var, "eps"], [f"{prefix}_var_eps"])
        std = node("Sqrt", [var_eps], [f"{prefix}_std"])
        norm = node("Div", [centered, std], [f"{prefix}_norm"])
        scaled = node("Mul", [norm, gamma], [f"{prefix}_scaled"])
        return node("Add", [scaled, beta], [f"{prefix}_out"])

    h = layer_norm("x0", "ln1_g", "ln1_b", "ln1")

    q = node("MatMul", [h, "wq"], ["q_full"])
    k = node("MatMul", [h, "wk"], ["k_full"])
    v = node("MatMul", [h, "wv"], ["v_full"])

    const_i64("shape_heads", np.array([SEQ_LEN, N_HEADS, HEAD_DIM], dtype=np.int64))
    q3 = node("Reshape", [q, "shape_heads"], ["q3"])
    k3 = node("Reshape", [k, "shape_heads"], ["k3"])
    v3 = node("Reshape", [v, "shape_heads"], ["v3"])
    q3t = node("Transpose", [q3], ["q3t"], perm=[1, 0, 2])  # (heads, seq, head_dim)
    k3t = node("Transpose", [k3], ["k3t"], perm=[1, 0, 2])
    v3t = node("Transpose", [v3], ["v3t"], perm=[1, 0, 2])

    k3t_T = node("Transpose", [k3t], ["k3t_T"], perm=[0, 2, 1])  # (heads, head_dim, seq)
    scores = node("MatMul", [q3t, k3t_T], ["scores"])  # (heads, seq, seq)
    scores_scaled = node("Mul", [scores, "attn_scale"], ["scores_scaled"])
    attn = node("Softmax", [scores_scaled], ["attn"], axis=-1)
    attn_out = node("MatMul", [attn, v3t], ["attn_out_heads"])  # (heads, seq, head_dim)
    attn_out_t = node("Transpose", [attn_out], ["attn_out_t"], perm=[1, 0, 2])  # (seq, heads, head_dim)
    const_i64("shape_seq_d", np.array([SEQ_LEN, D], dtype=np.int64))
    attn_out_flat = node("Reshape", [attn_out_t, "shape_seq_d"], ["attn_out_flat"])
    attn_proj = node("MatMul", [attn_out_flat, "wo"], ["attn_proj"])
    x1 = node("Add", ["x0", attn_proj], ["x1"])

    h2 = layer_norm("x1", "ln2_g", "ln2_b", "ln2")
    mlp1 = node("MatMul", [h2, "mlp_w1"], ["mlp1_mm"])
    mlp1 = node("Add", [mlp1, "mlp_b1"], ["mlp1"])

    # GELU (tanh approximation), matching train_vit.py's gelu() exactly:
    # 0.5*x*(1+tanh(sqrt(2/pi)*(x+0.044715*x^3)))
    x3 = node("Mul", [mlp1, mlp1], ["mlp1_sq"])
    x3 = node("Mul", [x3, mlp1], ["mlp1_cube"])
    x3c = node("Mul", [x3, "gelu_c2"], ["mlp1_cube_scaled"])
    inner = node("Add", [mlp1, x3c], ["gelu_inner_sum"])
    inner = node("Mul", [inner, "gelu_c1"], ["gelu_inner"])
    tanh_out = node("Tanh", [inner], ["gelu_tanh"])
    one_plus = node("Add", [tanh_out, "one"], ["gelu_one_plus"])
    half_x = node("Mul", [mlp1, "half"], ["gelu_half_x"])
    gelu_out = node("Mul", [half_x, one_plus], ["gelu_out"])

    mlp2 = node("MatMul", [gelu_out, "mlp_w2"], ["mlp2_mm"])
    mlp2 = node("Add", [mlp2, "mlp_b2"], ["mlp2"])
    x2 = node("Add", ["x1", mlp2], ["x2"])

    x_final = layer_norm("x2", "ln3_g", "ln3_b", "ln3")

    # take the [cls] row (index 0) of the (17, D) tensor
    const_i64("cls_idx", np.array([0], dtype=np.int64))
    cls_out = node("Gather", [x_final, "cls_idx"], ["cls_out_2d"], axis=0)  # (1, D)
    const_i64("shape_d", np.array([D], dtype=np.int64))
    cls_out_1d = node("Reshape", [cls_out, "shape_d"], ["cls_out_1d"])

    logits = node("MatMul", [cls_out_1d, "head_w"], ["logits_mm"])
    node("Add", [logits, "head_b"], ["logits"])

    graph = helper.make_graph(
        nodes, "chameleon_screen_region_vit", [input_info], [output_info],
        initializer=initializers,
    )
    model = helper.make_model(graph, producer_name="chameleon-vit-export", opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    return model


if __name__ == "__main__":
    weights = np.load("trained_vit_weights.npz")
    model = build_graph(weights)
    onnx.save(model, "screen-region-vit.onnx")
    print("saved screen-region-vit.onnx")
    import os
    print("size bytes:", os.path.getsize("screen-region-vit.onnx"))
