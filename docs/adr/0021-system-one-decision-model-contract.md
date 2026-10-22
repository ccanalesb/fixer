# ADR-0021: Culling reaches its models through System One; the app serves its own

**Status:** Accepted (2026-10-22)
**Date:** 2026-10-22
**Amends:** ADR-0020

## Context

Culling's two stages, the culling profile and the Score forecast, called Laya base
and Laya new directly: one worker call per photo, with model files the setup step
exports into `models/` (ADR-0020). The PRD
([#361](https://github.com/ccanalesb/lightroom-tagger/issues/361)) lets the user
choose each stage's model, including models this app does not hold (oMLX,
`jevtrainer serve`, another machine). Those servers speak System One (TypeSafe
Jev): `POST /v1/systemone` with `{model, state, images, questions}`, answering
every question with its level probabilities, and `GET /v1/models`.

45,793 photos already carry answers from each of the three current stage versions.
A stage version hashes its model id with its questions, so whatever the models are
called after this change decides whether those answers stay current.

## Decision

1. **System One is the only way a culling stage reaches a model.** The cull pass
   holds a System One client (`src/systemone/client.ts`) per stage and does not
   know whether the endpoint is this app or another server. Each stage asks its
   own endpoint once per photo, with every question it is missing.
2. **Per-stage config in `config.yaml`**, every stage with the same three keys:

   ```yaml
   culling_models:
     culling_profile: {endpoint: this_app, model: laya-base, api_key: ""}
     score_forecast: {endpoint: this_app, model: laya-new, api_key: ""}
   ```

   These are the defaults when the block is absent. `endpoint` is `this_app` or a
   URL; a non-empty `api_key` is sent as `Authorization: Bearer`, and is ignored for
   `this_app`. Culling ignores a culling profile's own `model` field.
3. **This app serves its own endpoint**, `GET /v1/models` and `POST /v1/systemone`
   (`src/api/systemone.ts`), over the Laya worker of ADR-0020, as `laya-base` and
   `laya-new`. Culling reaches it in-process, through the route group's own
   `request`: the same HTTP requests and validation, with no socket.
4. **Model identity.** A listed model may carry `x_model_id`; this app's give the
   ids the stage versions already hash (Laya base's Hugging Face revision, Laya new's
   decoder SHA-256), so this library's stored answers stay current with no
   migration. A model without one is `<model>@<endpoint>`. The client reads both
   `models[].name` and OpenAI-style `data[].id` lists.
5. **Answers keep today's shape.** Scores are read from `probabilities` by level
   (`"0"`…`"k-1"`), choices by criteria order. For `noul` answers this app adds
   `probabilities: {false, true}`, so the stored pair is exactly the model's; from a
   server without it, `[1 − noul, noul]`. `state` is `""`; this app answers 422 to
   any other state.
   Servers disagree on the image: oMLX accepts only a data URL
   (`data:image/jpeg;base64,…`), Ollama only raw base64. The client sends a data
   URL; when the start check gets a 400 back, it asks once more in raw base64 and,
   if that works, the stage sends raw base64 for the rest of the job. This app
   accepts both.
6. **A stage that is on must be usable.** Before any photo, the job lists each
   stage's models and checks its model is there; on the first photo that needs an
   answer, a start check asks each stage its questions about a plain grey image.
   Either failing fails the job with the stage and the cause ("Score forecast:
   laya-new is not listed by this app. Run the setup step…", "Culling profile:
   http://… refused the API key"). There is no longer a Score forecast that turns
   itself off because Laya new is missing.
7. **Failures during the job.** An endpoint that does not answer (refused
   connection, timeout) or answers 503 stops the job, like the worker dying did:
   the photo is pending as `endpoint_down` and the next job asks it last. Any other
   HTTP error or an answer that cannot be read leaves that photo pending as
   `model_failed: <stage>: <cause>` and the job goes on.
8. **Stage answers record their endpoint** in `produced_by` (`this_app` or the URL),
   and the job result gives `stage_seconds` per stage instead of Laya's timings.
9. **The worker is the endpoint's, not the job's.** It starts on the first request
   and closes after two idle minutes. Laya new reuses the vision features of the
   last image Laya base read, so a photo still runs the vision encoder once.

## Consequences

- An external model's answers live under their own stage versions: they never
  read as current for this library's Laya answers, and switching back to this app
  makes the Laya versions current again.
- `/v1/*` is mounted outside `/api` and its CORS. It is reachable from another
  machine only when the backend already listens beyond localhost (`HOST`), which
  ADR-0019 already treats as a trusted-network choice; nothing new is opened.
- Culling through HTTP still keeps the main event loop free (ADR-0018): the model
  call is in the worker thread, the in-process request is a few JSON objects, and
  an external endpoint is network I/O.
- A library that has Laya base but not Laya new, with the default pipeline setting
  (Score forecast on), now fails culling jobs until the Score forecast is turned off
  or given a model.
- Photos are sent to whatever endpoint the user configures. That is the user's
  choice of model; this app never chooses an external endpoint by itself.
- The `state` text other System One models may need is not built here.

## Alternatives considered

- **Keep the direct worker calls for this app's models, System One only for
  external ones** — rejected: two paths to keep equal, and the PRD wants one.
- **Reach this app's endpoint over its own TCP port** — rejected: the job would
  depend on the port the server bound and on `HOST`, for the same requests the
  route group answers in-process.
- **Identity as `<model>@<endpoint>` for every model, migrating stored versions** —
  rejected: rewriting 137,379 answers' versions to rename a model that did not
  change, when the endpoint can say what the model is.
