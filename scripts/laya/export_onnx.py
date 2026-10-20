# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#   "torch==2.14.0",
#   "torchvision==0.29.0",
#   "transformers==5.17.0",
#   "onnx==1.23.2",
#   "onnxscript==0.7.2",
#   "onnxruntime==1.31.0",
#   "numpy==2.5.3",
#   "pillow==12.3.0",
#   "laya @ git+https://github.com/r33drichards/laya-vision@568feeeada793f70f736756b0f3a7643d1e75910",
# ]
# ///
"""Setup step for the cull: export Laya base and Laya new to ONNX (fp32) for the backend.

    uv run scripts/laya/export_onnx.py [--laya-new PATH] [--out models]

Downloads Laya base (`thaitea/laya-vision` at a fixed revision) from Hugging Face when it is not cached and
converts it on this machine; Laya new is converted from the checkpoint directory given with `--laya-new`
(without it the Score forecast stage stays off). Nothing is uploaded. Writes:

  <out>/laya-base/vision.onnx     pixel_values [1, 3, 512, 512] -> image features [64, 576]; vision tower +
                                  connector, shared by Laya new (its weights must be identical — checked).
  <out>/laya-base/decoder.onnx    one row per question: input_ids, attention_mask [B, L], option_span [B, 2],
  <out>/laya-new/decoder.onnx     qtype [B], marker_pos / marker_mask [B, K], image_features -> option logits
                                  [B, K] before temperature. Token embedding, image merge, the text model under
                                  Laya's block option mask, and the decision head.
  <out>/<model>/model.json        temperatures, budgets, special ids, image prefix ids.
  <out>/<model>/tokenizer/        the processor's tokenizer files.
  <out>/<model>/reference/        a synthetic test photo with PyTorch's pixel values, token rows and
                                  probabilities, for the backend's start check and parity test.

Each graph is checked against PyTorch before the reference is written.
"""
from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

REPO = Path(__file__).resolve().parents[2]
QUESTIONS = REPO / "apps/visualizer/backend/src/laya/questions.json"
BASE_ID = "thaitea/laya-vision"
BASE_REVISION = "8b318c99d7ad3ce19c24369263463882eada9d1e"
MAX_LOGIT_DIFF = 1e-3


class Vision(nn.Module):
    def __init__(self, enc):
        super().__init__()
        self.vm, self.conn = enc.vision_model, enc.connector

    def forward(self, pixel_values):
        n = pixel_values.shape[-1] // self.vm.config.patch_size
        pam = torch.ones((1, n, n), dtype=torch.bool, device=pixel_values.device)
        h = self.vm(pixel_values=pixel_values, patch_attention_mask=pam).last_hidden_state
        return self.conn(h)[0]


def head_layer(layer: nn.TransformerEncoderLayer, x, pad):
    """nn.TransformerEncoderLayer (norm_first, relu, eval) written out: its fast path does not export."""
    sa = layer.self_attn
    B, L, d = x.shape
    nh = sa.num_heads
    y = layer.norm1(x)
    qkv = F.linear(y, sa.in_proj_weight, sa.in_proj_bias).view(B, L, 3, nh, d // nh).permute(2, 0, 3, 1, 4)
    bias = torch.zeros((B, 1, 1, L), dtype=x.dtype).masked_fill(pad[:, None, None, :], float("-inf"))
    a = F.scaled_dot_product_attention(qkv[0], qkv[1], qkv[2], attn_mask=bias)
    x = x + sa.out_proj(a.transpose(1, 2).reshape(B, L, d))
    return x + layer.linear2(F.relu(layer.linear1(layer.norm2(x))))


class Decoder(nn.Module):
    def __init__(self, model, image_token_id: int):
        super().__init__()
        self.m = model
        self.tm = model.encoder.text_model
        self.image_token_id = image_token_id

    def forward(self, input_ids, attention_mask, option_span, qtype, marker_pos, marker_mask, image_features):
        emb = self.tm.embed_tokens(input_ids)
        is_img = input_ids == self.image_token_id
        idx = (torch.cumsum(is_img.long(), 1) - 1).clamp(min=0, max=image_features.shape[0] - 1)
        emb = torch.where(is_img[..., None], image_features[idx], emb)
        B, L = input_ids.shape
        pos = torch.arange(L, device=input_ids.device)
        allowed = (pos[None, :, None] >= pos[None, None, :]).expand(B, -1, -1)
        s, e = option_span[:, 0, None], option_span[:, 1, None]
        inr = (pos[None] >= s) & (pos[None] < e)
        allowed = (allowed | (inr[:, :, None] & inr[:, None, :])) & attention_mask.bool()[:, None, :]
        mask = torch.zeros((B, 1, L, L), dtype=emb.dtype).masked_fill(~allowed[:, None], torch.finfo(emb.dtype).min)
        h = self.tm(inputs_embeds=emb, attention_mask=mask, use_cache=False).last_hidden_state
        h = h + self.m.type_emb(qtype)[:, None, :]
        pad = ~attention_mask.bool()
        for layer in self.m.head.layers:
            h = head_layer(layer, h, pad)
        g = torch.gather(h, 1, marker_pos[:, :, None].expand(-1, -1, h.shape[-1]))
        return self.m.scorer(g).squeeze(-1).masked_fill(~marker_mask, -1e4)


def test_photo():
    """A deterministic synthetic photo larger than 512 px, so the thumbnail step runs too."""
    from PIL import Image, ImageDraw

    w, h = 1200, 800
    x = np.linspace(0, 1, w)[None, :, None]
    y = np.linspace(0, 1, h)[:, None, None]
    rgb = np.concatenate([np.broadcast_to(x, (h, w, 1)), np.broadcast_to(y, (h, w, 1)),
                          np.broadcast_to((x + y) / 2, (h, w, 1))], axis=2)
    im = Image.fromarray((rgb * 255).astype(np.uint8), "RGB")
    d = ImageDraw.Draw(im)
    d.ellipse((380, 220, 760, 600), fill=(220, 40, 30))
    d.rectangle((60, 520, 300, 760), fill=(20, 20, 20))
    d.line((0, 0, w, h), fill=(255, 255, 255), width=9)
    return im


def rows_for(agent, im, qs):
    """The rows `predict` builds for an image-only state (no permutations), collated, plus the image features."""
    import laya.vlm as V
    from laya.common import QTYPES

    prefix = V.vlm_prefix(agent.processor, [im], agent.prep)
    feats = agent.model.encode_images(prefix["pixel_values"].to(agent.device),
                                      prefix["pixel_attention_mask"].to(agent.device))
    rows = []
    for qd in qs.values():
        q = agent._to_internal(qd)
        it = V.build_vlm_inputs(agent.processor, {"image": im}, q, agent.cfg["max_len"], agent.cfg["head_max_len"],
                                prefix=prefix)
        it.update(qtype=QTYPES[q["t"]])
        rows.append(it)
    return prefix, feats, rows


def check(label: str, diff: float) -> None:
    print(f"{label}: max abs difference {diff:.2e}", flush=True)
    if not diff <= MAX_LOGIT_DIFF:
        raise SystemExit(f"{label}: ONNX differs from PyTorch by {diff}, above {MAX_LOGIT_DIFF}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--laya-new", type=Path, help="Laya new checkpoint directory (omit: Score forecast off)")
    ap.add_argument("--out", type=Path, default=REPO / "models")
    a = ap.parse_args()

    import laya
    import laya.vlm as V
    import onnxruntime as ort

    questions = json.loads(QUESTIONS.read_text())
    agents = {"base": laya.load_vlm(BASE_ID, revision=BASE_REVISION, device="cpu")}
    if a.laya_new:
        agents["new"] = laya.load_vlm(str(a.laya_new.expanduser()), device="cpu")
        b, n = agents["base"].model.encoder, agents["new"].model.encoder
        same = all(torch.equal(p, q) for m1, m2 in ((b.vision_model, n.vision_model), (b.connector, n.connector))
                   for p, q in zip(m1.state_dict().values(), m2.state_dict().values()))
        if not same:
            raise SystemExit("Laya new's vision tower differs from Laya base's; the shared vision graph cannot serve it")

    tok = agents["base"].processor.tokenizer
    image_token_id = tok.convert_tokens_to_ids(agents["base"].processor.image_token)
    im = test_photo()
    thumb = im.copy()
    thumb.thumbnail((512, 512))

    base_dir = a.out / "laya-base"
    for name in agents:
        d = a.out / f"laya-{name}"
        if d.exists():
            shutil.rmtree(d)
        (d / "reference").mkdir(parents=True)
    im.save(base_dir / "reference/photo.png")

    prefix, _, _ = rows_for(agents["base"], thumb, {})
    pv = prefix["pixel_values"].float()
    vis = Vision(agents["base"].model.encoder).eval()
    with torch.no_grad():
        ref_feats = vis(pv)
        t = time.time()
        torch.onnx.export(vis, (pv,), base_dir / "vision.onnx", input_names=["pixel_values"],
                          output_names=["image_features"], dynamo=True, external_data=False, optimize=True)
        print(f"vision exported in {time.time() - t:.0f} s", flush=True)
    got = ort.InferenceSession(str(base_dir / "vision.onnx"), providers=["CPUExecutionProvider"]).run(
        None, {"pixel_values": pv.numpy()})[0]
    check("vision", float(np.abs(got - ref_feats.numpy()).max()))
    pv.numpy().astype(np.float32).tofile(base_dir / "reference/pixel_values.f32")

    for name, agent in agents.items():
        d = a.out / f"laya-{name}"
        qs = questions[name]
        prefix, feats, rows = rows_for(agent, thumb, qs)
        b = V.collate_vlm(rows, tok.pad_token_id, with_pixels=False)
        dec = Decoder(agent.model, image_token_id).eval()
        args = (b["input_ids"], b["attention_mask"], b["option_span"], b["qtype"], b["marker_pos"],
                b["marker_mask"], feats[0].float())
        with torch.no_grad():
            ref, _ = agent.model(b["input_ids"], b["attention_mask"], b["marker_pos"], b["marker_mask"], b["qtype"],
                                 image_hidden_states=feats.repeat(len(qs), 1, 1), option_span=b["option_span"])
            check(f"{name} export wrapper vs model.forward", float((dec(*args) - ref).abs().max()))
            Bd, Ld, Kd = (torch.export.Dim("B", min=1, max=64), torch.export.Dim("L", min=80, max=1024),
                          torch.export.Dim("K", min=2, max=64))
            dyn = {"input_ids": {0: Bd, 1: Ld}, "attention_mask": {0: Bd, 1: Ld}, "option_span": {0: Bd},
                   "qtype": {0: Bd}, "marker_pos": {0: Bd, 1: Kd}, "marker_mask": {0: Bd, 1: Kd},
                   "image_features": None}
            t = time.time()
            torch.onnx.export(dec, args, d / "decoder.onnx", input_names=list(dyn), output_names=["logits"],
                              dynamic_shapes=dyn, dynamo=True, external_data=False, optimize=True)
            print(f"{name} decoder exported in {time.time() - t:.0f} s", flush=True)
        sess = ort.InferenceSession(str(d / "decoder.onnx"), providers=["CPUExecutionProvider"])
        got = sess.run(None, {k: v.detach().numpy() for k, v in zip(dyn, args)})[0]
        check(f"{name} decoder", float(np.abs(got - ref.numpy()).max()))

        agent.processor.tokenizer.save_pretrained(d / "tokenizer")
        meta = {
            "source": BASE_ID if name == "base" else str(a.laya_new),
            "revision": BASE_REVISION if name == "base" else None,
            "fine_tuned_from": agent.cfg.get("loaded_from") if name == "new" else None,
            "temperature": list(agent.temperature), "temperature_by_options": dict(agent.temperature_by_options),
            "max_len": agent.cfg["max_len"], "head_max_len": agent.cfg["head_max_len"],
            "option_attention": agent.model.option_attention, "image_token_id": image_token_id,
            "pad_token_id": tok.pad_token_id, "prefix_ids": prefix["ids"],
        }
        (d / "model.json").write_text(json.dumps(meta, indent=1))
        probs, ref_rows = {}, {}
        for i, (qid, r) in enumerate(zip(qs, rows)):
            k = len(r["markers"])
            temp = agent._checkpoint_temperature(r["qtype"], k)
            probs[qid] = torch.softmax(ref[i, :k] / max(1e-3, temp), -1).tolist()
            ref_rows[qid] = {"ids": r["ids"], "markers": r["markers"], "option_span": list(r["option_span"]),
                             "qtype": r["qtype"]}
        (d / "reference/rows.json").write_text(json.dumps(ref_rows))
        (d / "reference/probabilities.json").write_text(json.dumps(probs))
    print(f"done: {', '.join(f'laya-{n}' for n in agents)} in {a.out}", flush=True)


if __name__ == "__main__":
    main()
