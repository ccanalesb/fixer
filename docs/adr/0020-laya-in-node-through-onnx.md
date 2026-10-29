# ADR-0020: Laya runs in Node through ONNX, in a worker thread, from git-ignored files

**Status:** Accepted (2026-10-19), amended by ADR-0021 (2026-10-22) and by
[#365](https://github.com/ccanalesb/fixer/issues/365) (2026-10-22)
**Date:** 2026-10-19

> **Amended by #365.** The setup step converts one Laya-family model at a time,
> from a folder in Hugging Face format or a Hugging Face id (`id` or
> `id@revision`): `uv run scripts/laya/export_onnx.py <source> --name <name>`, run
> by the `laya_model_install` job when a model is added in Processing → Settings →
> Models in this app. Without a revision the script records the last commit that
> changed the model files (`8b318c9` for `thaitea/laya-vision`). Every directory
> in `models/` with complete files is one installed model; its `model.json` records
> its source, revision, the job that converted it, and which directory holds its
> vision graph (`vision`). A model whose vision tower and connector hash
> (`vision_sha256`) matches an installed one's reuses that graph, as Laya new
> always did; a model without the hash gets it computed once from its recorded
> source. The script writes to `models/.install-<name>/` and renames it when every
> check passes, so a failed or cancelled install leaves nothing listed. The worker
> loads each model's decoder and vision graph on its first request, not all at
> start. A model with no revision keeps its decoder-hash id, so `laya-new` keeps
> the id its answers hash (ADR-0021, Decision 4).

> **Amended by ADR-0021.** Culling no longer calls the worker: it asks this app's
> System One endpoint, which owns the worker. The worker starts on the endpoint's
> first request and closes after two idle minutes, not at a job's start and end
> (Decision 3). The start check is per stage, through the endpoint, on a test image
> (Decision 5). Without `laya-new/` this app does not list `laya-new`, and a
> Score forecast that is on fails the job instead of turning itself off
> (Decision 2).

## Context

The cull before scoring ([#336](https://github.com/ccanalesb/fixer/issues/336))
asks two local models about every photo: Laya base (`thaitea/laya-vision`, a
SmolVLM-256M backbone with a decision head) answers the culling recipe's four
questions at 7 and 10 levels, and Laya new (Laya base fine-tuned on kimi's scores
of this library) gives the Score forecast. Both were only ever run from Python, on
the GPU, at 1.4 s / photo. The backend is TypeScript with no Python at run time
(see the README's Installation), and CLIP already runs in it through
`onnxruntime-node`.

Measured on the M4 against 500 catalog photos (research ticket 22, branch
`research/laya-vision`):

| | |
|---|---|
| Both stages, Node, CPU execution provider | 2.32 s / photo on the main thread, 2.01 s in a worker thread |
| Verdicts changed vs the Python outputs | 0 of 500 |
| Largest probability difference | 0.009 (Laya new), 0.004 (Laya base) |
| Files (fp32) | vision encoder 375 MB, shared; one decoder per model, 433 MB each |
| Memory | 1.97 GB loaded, 3.47 GB peak |
| Longest `session.run` on the main thread | 801 ms |
| CoreML execution provider | MLProgram fails at session creation; NeuralNetwork 6.37 s / photo |

Laya new's vision tower, connector, embeddings and first sixteen text layers are
byte-identical to Laya base's, so one vision graph serves both.

## Decision

1. **Ported to Node, no Python at run time.** `scripts/laya/export_onnx.py`, run
   once through `uv` (its dependencies are pinned inline, so `uv` builds a
   throwaway environment), downloads Laya base at revision `8b318c9`, converts it
   and Laya new on this machine, checks every graph against PyTorch, and writes a
   PyTorch reference (a synthetic photo, its pixel values, token rows and
   probabilities). The block option mask, the image merge and the decision head
   are inside the decoder graphs; image prep, token rows, temperatures and softmax
   are TypeScript (`src/laya/`).
2. **Files in a git-ignored `models/`** (`models/laya-base/`, `models/laya-new/`;
   `laya_models_dir` in `config.yaml`). The repo is public: no model, tokenizer or
   converted graph is committed or published. Without `laya-new/` the Score
   forecast stage is off and the culling recipe still runs.
3. **Inference in one persistent worker thread.** ADR-0018 keeps job handlers on
   the main event loop and yielding; that still holds. What moves is the model
   call: a native `session.run` cannot yield, and at up to 0.8 s per pass it would
   hold `/api/status` close to ADR-0018's one-second bar for every pass of a cull
   that runs for hours. ADR-0018's amendment named this exact shape — a
   persistent worker for a large model — and declined it for CLIP because CLIP
   blocks for 90 ms. The handler awaits the worker's answers; in the worker the
   longest main-thread delay measured was 13.9 ms. The worker loads at cull-job
   start and is terminated at its end, which frees the memory.
4. **CPU execution provider**, default threads.
5. **A start check before any photo:** files present, models load, the reference
   photo answered; otherwise a `LayaSetupError` naming what is missing and the
   setup command. `lightroom-tagger cull-check` runs the same check by hand.

## Consequences

- A fresh checkout cannot cull until the setup step has run, and the setup step
  needs `uv`, network access for the first download, and Laya new's checkpoint
  directory for the Score forecast.
- CI has no models. Pure parts (image sizes, token-row rules, file check) are
  tested there; parity with PyTorch is `tests/laya-parity.test.ts`, gated by
  `LT_LAYA_PARITY=1` like the CLIP parity test, and run on a machine with the
  export.
- `onnxruntime-node` is a direct dependency pinned to the version
  `@huggingface/transformers` pins, so one native binding loads.
- About 2–3.5 GB of RAM while a cull job runs.
- An Intel Mac and GPU execution providers are not measured.

## Alternatives considered

- **Keep Python: a local Python service or a subprocess per job** — rejected in
  research ticket 21 in favour of no Python at run time, provided the Node port
  met ≤ 3 s / photo for both stages; it does.
- **Laya on the main thread** — rejected; see Decision (3).
- **CoreML** — slower or fails; see Context.
- **A private repo for the model files** — to be evaluated later; the git-ignored
  folder is the first step.
