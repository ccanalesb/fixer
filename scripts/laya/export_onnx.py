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
"""Convert one Laya-family model to ONNX (fp32) for this app's System One endpoint.

    uv run scripts/laya/export_onnx.py SOURCE --name NAME [--out models] [--job-id ID]

SOURCE is a folder in Hugging Face format (`vlm_agent_config.json`, `model.safetensors`, `processor/`) or a
Hugging Face id, `id` or `id@revision`. Without a revision, the commit recorded is the last one that changed
the model's files, so a commit that only touched the README is not a new model. The app's conversion job
(`laya_model_install`) runs this; it can be run by hand too. Nothing is uploaded. Writes, in
<out>/.install-<name>/ renamed to <out>/<name>/ once every check has passed:

  vision.onnx     pixel_values [1, 3, 512, 512] -> image features [64, 576]; vision tower + connector. Left out
                  when an installed model has the same vision tower (same weights): `vision` in model.json
                  names the model whose graph it reads.
  decoder.onnx    one row per question: input_ids, attention_mask [B, L], option_span [B, 2], qtype [B],
                  marker_pos / marker_mask [B, K], image_features -> option logits [B, K] before temperature.
                  Token embedding, image merge, the text model under Laya's block option mask, and the decision
                  head.
  model.json      temperatures, budgets, special ids, image prefix ids; source, revision, vision, vision_sha256.
  tokenizer/      the processor's tokenizer files.
  reference/      a synthetic test photo with PyTorch's pixel values, token rows and probabilities, for the
                  backend's parity test.

Each graph is checked against PyTorch before the reference is written. A failure ends with one line
`error: <kind>: <message>` on stderr and exit status 2; kind is `source`, `network`, `not_laya` or `parity`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import signal
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

REPO = Path(__file__).resolve().parents[2]
QUESTIONS = REPO / "apps/visualizer/backend/src/laya/questions.json"
MAX_LOGIT_DIFF = 1e-3
CONFIG_NAME = "vlm_agent_config.json"
#: What `laya.load_vlm` reads of a checkpoint: the files whose last commit is the model's revision.
MODEL_PATHS = (CONFIG_NAME, "model.safetensors", "head.safetensors", "processor", "backbone")
#: The backbones the backend's port runs: SmolVLM (Idefics3).
SUPPORTED_MODEL_TYPES = ("idefics3", "smolvlm")
NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


class InstallError(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


def step(text: str) -> None:
    """A line the conversion job shows as its current step."""
    print(f"step: {text}", flush=True)


def is_network_error(e: BaseException) -> bool:
    import httpx
    from huggingface_hub.errors import LocalEntryNotFoundError, OfflineModeIsEnabled

    return isinstance(e, (httpx.TransportError, OfflineModeIsEnabled, LocalEntryNotFoundError, ConnectionError,
                          TimeoutError))


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
        raise InstallError("parity", f"{label}: the ONNX graph differs from PyTorch by {diff:.2e}, above {MAX_LOGIT_DIFF}")


def resolve_source(source: str) -> tuple[Path, str, str | None]:
    """The directory to load, the source as recorded, and the Hugging Face commit (None for a folder)."""
    p = Path(source).expanduser()
    if source.startswith(("/", "~", ".")) or p.is_dir():
        if not p.is_dir():
            raise InstallError("source", f"No folder at {p}")
        if not (p / CONFIG_NAME).exists():
            raise InstallError("not_laya", f"{p} is not a Laya-family model: it has no {CONFIG_NAME}")
        return p.resolve(), str(p.resolve()), None

    from huggingface_hub import HfApi, snapshot_download
    from huggingface_hub.errors import HFValidationError, RepositoryNotFoundError, RevisionNotFoundError

    repo, _, rev = source.partition("@")
    api = HfApi()
    try:
        step(f"looking up {source} on Hugging Face")
        info = api.model_info(repo, revision=rev or None)
        files = [s.rfilename for s in info.siblings or []]
        if CONFIG_NAME not in files:
            raise InstallError("not_laya", f"{repo} is not a Laya-family model: it has no {CONFIG_NAME}")
        commit = info.sha
        if not rev:
            present = [m for m in MODEL_PATHS if any(f == m or f.startswith(f"{m}/") for f in files)]
            changed = [i.last_commit for i in api.get_paths_info(repo, present, revision=commit, expand=True)
                       if i.last_commit]
            if changed:
                commit = max(changed, key=lambda c: c.date).oid
        step(f"downloading {repo}@{commit[:7]}")
        path = snapshot_download(repo, revision=commit)
    except InstallError:
        raise
    except RevisionNotFoundError:
        raise InstallError("source", f"{repo} has no revision {rev}")
    except RepositoryNotFoundError:
        raise InstallError("source", f"{repo} is not a model on Hugging Face, or it is private")
    except HFValidationError:
        raise InstallError("source", f"{source} is neither a folder nor a Hugging Face id")
    except Exception as e:
        if is_network_error(e):
            raise InstallError("network", f"Could not reach Hugging Face ({type(e).__name__}: {e})")
        raise
    return Path(path), repo, commit


def check_backbone(model_dir: Path) -> None:
    """Before loading: the backbone has to be one the backend's port runs."""
    from transformers import AutoConfig

    cfg = json.loads((model_dir / CONFIG_NAME).read_text())
    local = model_dir / "backbone"
    try:
        if (local / "config.json").exists():
            bb = AutoConfig.from_pretrained(str(local))
        else:
            bb = AutoConfig.from_pretrained(cfg["backbone"], revision=cfg.get("backbone_revision"))
    except Exception as e:
        if is_network_error(e):
            raise InstallError("network", f"Could not reach Hugging Face for the backbone ({e})")
        raise InstallError("not_laya", f"Its backbone {cfg.get('backbone')!r} cannot be read ({e})")
    if bb.model_type not in SUPPORTED_MODEL_TYPES:
        raise InstallError("not_laya", f"Its backbone is {cfg.get('backbone')} ({bb.model_type}); this app runs "
                                       "Laya on SmolVLM (Idefics3) only")


def check_loaded(agent) -> None:
    """After loading: the image path and readout the backend's port reproduces."""
    c = agent.cfg
    problems = []
    if c.get("preprocess", "processor") != "processor":
        problems.append(f"preprocess {c.get('preprocess')!r}")
    if c.get("image_size", 512) != 512:
        problems.append(f"image size {c.get('image_size')}")
    if c.get("image_split_edge") or 0:
        problems.append("image splitting")
    if c.get("readout", "terminator") != "terminator":
        problems.append(f"readout {c.get('readout')!r}")
    if problems:
        raise InstallError("not_laya", f"This app runs Laya on one 512 px image through the processor with a "
                                       f"terminator readout; this model has {', '.join(problems)}")


def vision_sha256(agent) -> str:
    """The vision tower and connector weights: equal hashes can share one vision graph."""
    h = hashlib.sha256()
    enc = agent.model.encoder
    for prefix, module in (("vision_model", enc.vision_model), ("connector", enc.connector)):
        for k, v in sorted(module.state_dict().items()):
            h.update(f"{prefix}.{k}".encode())
            h.update(v.detach().cpu().contiguous().flatten().view(torch.uint8).numpy().tobytes())
    return h.hexdigest()


def write_json(path: Path, value) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(value, indent=1))
    tmp.replace(path)


def installed_vision(out: Path, wanted: str) -> str | None:
    """The installed model whose own vision graph has these weights. A model converted before the hash was
    recorded gets it now, from its recorded source, and keeps it."""
    import laya

    own = []
    for d in sorted(out.iterdir()) if out.is_dir() else []:
        if d.name.startswith(".") or not (d / "vision.onnx").exists() or not (d / "model.json").exists():
            continue
        meta = json.loads((d / "model.json").read_text())
        if meta.get("vision", d.name) == d.name:
            own.append((d, meta))
    for d, meta in own:
        if meta.get("vision_sha256") == wanted:
            return d.name
    for d, meta in own:
        if meta.get("vision_sha256"):
            continue
        source, revision = meta.get("source"), meta.get("revision")
        if not source or (not revision and not Path(source).is_dir()):
            continue
        step(f"reading {d.name}'s vision tower")
        try:
            other = laya.load_vlm(source, revision=revision, device="cpu")
        except Exception as e:
            print(f"{d.name}: its source {source} could not be loaded ({e}); not compared", flush=True)
            continue
        meta["vision_sha256"] = vision_sha256(other)
        del other
        write_json(d / "model.json", meta)
        if meta["vision_sha256"] == wanted:
            return d.name
    return None


def convert(source_arg: str, name: str, out: Path, partial: Path, job_id: str | None) -> None:
    import laya
    import laya.vlm as V
    import onnxruntime as ort

    model_dir, source, revision = resolve_source(source_arg)
    check_backbone(model_dir)
    step("loading the model")
    try:
        agent = laya.load_vlm(str(model_dir), device="cpu")
    except Exception as e:
        if is_network_error(e):
            raise InstallError("network", f"Could not reach Hugging Face while loading ({e})")
        raise InstallError("not_laya", f"It does not load as a Laya-family model ({type(e).__name__}: {e})")
    check_loaded(agent)
    vhash = vision_sha256(agent)
    step("looking for an installed model with the same vision tower")
    shared = installed_vision(out, vhash)

    questions = json.loads(QUESTIONS.read_text())
    qs = {**questions["base"], **questions["new"]}
    tok = agent.processor.tokenizer
    image_token_id = tok.convert_tokens_to_ids(agent.processor.image_token)
    im = test_photo()
    thumb = im.copy()
    thumb.thumbnail((512, 512))
    (partial / "reference").mkdir(parents=True)
    im.save(partial / "reference/photo.png")

    prefix, _, _ = rows_for(agent, thumb, {})
    pv = prefix["pixel_values"].float()
    vis = Vision(agent.model.encoder).eval()
    with torch.no_grad():
        ref_feats = vis(pv)
        if shared:
            print(f"vision: same weights as {shared}, reusing its graph", flush=True)
            vision_path = out / shared / "vision.onnx"
        else:
            step("exporting the vision graph")
            vision_path = partial / "vision.onnx"
            t = time.time()
            torch.onnx.export(vis, (pv,), vision_path, input_names=["pixel_values"],
                              output_names=["image_features"], dynamo=True, external_data=False, optimize=True)
            print(f"vision exported in {time.time() - t:.0f} s", flush=True)
    got = ort.InferenceSession(str(vision_path), providers=["CPUExecutionProvider"]).run(
        None, {"pixel_values": pv.numpy()})[0]
    check("vision", float(np.abs(got - ref_feats.numpy()).max()))
    pv.numpy().astype(np.float32).tofile(partial / "reference/pixel_values.f32")

    prefix, feats, rows = rows_for(agent, thumb, qs)
    b = V.collate_vlm(rows, tok.pad_token_id, with_pixels=False)
    dec = Decoder(agent.model, image_token_id).eval()
    args = (b["input_ids"], b["attention_mask"], b["option_span"], b["qtype"], b["marker_pos"],
            b["marker_mask"], feats[0].float())
    with torch.no_grad():
        ref, _ = agent.model(b["input_ids"], b["attention_mask"], b["marker_pos"], b["marker_mask"], b["qtype"],
                             image_hidden_states=feats.repeat(len(qs), 1, 1), option_span=b["option_span"])
        check("export wrapper vs model.forward", float((dec(*args) - ref).abs().max()))
        Bd, Ld, Kd = (torch.export.Dim("B", min=1, max=64), torch.export.Dim("L", min=80, max=1024),
                      torch.export.Dim("K", min=2, max=64))
        dyn = {"input_ids": {0: Bd, 1: Ld}, "attention_mask": {0: Bd, 1: Ld}, "option_span": {0: Bd},
               "qtype": {0: Bd}, "marker_pos": {0: Bd, 1: Kd}, "marker_mask": {0: Bd, 1: Kd},
               "image_features": None}
        step("exporting the decoder graph")
        t = time.time()
        torch.onnx.export(dec, args, partial / "decoder.onnx", input_names=list(dyn), output_names=["logits"],
                          dynamic_shapes=dyn, dynamo=True, external_data=False, optimize=True)
        print(f"decoder exported in {time.time() - t:.0f} s", flush=True)
    step("checking the decoder graph")
    sess = ort.InferenceSession(str(partial / "decoder.onnx"), providers=["CPUExecutionProvider"])
    got = sess.run(None, {k: v.detach().numpy() for k, v in zip(dyn, args)})[0]
    check("decoder", float(np.abs(got - ref.numpy()).max()))

    tok.save_pretrained(partial / "tokenizer")
    write_json(partial / "model.json", {
        "source": source, "revision": revision, "fine_tuned_from": agent.cfg.get("loaded_from"),
        "vision": shared or name, "vision_sha256": vhash, "job_id": job_id,
        "temperature": list(agent.temperature), "temperature_by_options": dict(agent.temperature_by_options),
        "max_len": agent.cfg["max_len"], "head_max_len": agent.cfg["head_max_len"],
        "option_attention": agent.model.option_attention, "image_token_id": image_token_id,
        "pad_token_id": tok.pad_token_id, "prefix_ids": prefix["ids"],
    })
    probs, ref_rows = {}, {}
    for i, (qid, r) in enumerate(zip(qs, rows)):
        k = len(r["markers"])
        temp = agent._checkpoint_temperature(r["qtype"], k)
        probs[qid] = torch.softmax(ref[i, :k] / max(1e-3, temp), -1).tolist()
        ref_rows[qid] = {"ids": r["ids"], "markers": r["markers"], "option_span": list(r["option_span"]),
                         "qtype": r["qtype"]}
    (partial / "reference/rows.json").write_text(json.dumps(ref_rows))
    (partial / "reference/probabilities.json").write_text(json.dumps(probs))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("source", help="a folder in Hugging Face format, or a Hugging Face id (id or id@revision)")
    ap.add_argument("--name", required=True, help="the model's name in this app, e.g. laya-base")
    ap.add_argument("--out", type=Path, default=REPO / "models")
    ap.add_argument("--job-id", help="the conversion job running this, recorded in model.json")
    a = ap.parse_args()
    if not NAME.match(a.name):
        raise InstallError("source", f"{a.name!r} is not a model name (lowercase letters, digits, '.', '_', '-')")

    out = a.out.expanduser().resolve()
    final, partial = out / a.name, out / f".install-{a.name}"
    if final.exists():
        raise InstallError("source", f"{final} already exists")
    out.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(partial, ignore_errors=True)
    try:
        convert(a.source, a.name, out, partial, a.job_id)
        partial.rename(final)
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)
        raise
    print(f"done: {a.name} in {out}", flush=True)


if __name__ == "__main__":
    # The job cancels with SIGTERM: exit through `main`'s cleanup rather than leave a half-written model.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        main()
    except InstallError as e:
        print(f"error: {e.kind}: {e}", file=sys.stderr, flush=True)
        sys.exit(2)
