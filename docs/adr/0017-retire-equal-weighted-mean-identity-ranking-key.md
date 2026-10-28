# ADR-0017: Retire the equal-weighted mean as an identity ranking key

## Status
Accepted (2026-07)

## Context
Identity surfaces (best-photos, and upcoming Mirror / Advisor slices in #205) need a
single cross-perspective ranking primitive so "most exceptional at something" is
comparable across lenses.

The prior key was an **equal-weighted mean** of raw rubric scores
(`compute_image_aggregate_scores`, `weighting: equal`). Research for #200
(`docs/research/identity-data-sufficiency.md`) showed that raw scores are **not on a
comparable scale across perspectives**: one lens (`environmental-context-legibility`)
runs ~1–2 points hotter than the others, so a naive **raw peak / argmax** — and by
extension any ranking that treats raw scores as commensurate — is dominated by rubric
calibration, not personal strength. On a representative library, raw argmax picked
that lens on **80.4%** of images.

The mean partially dilutes that bias but still blends incomparable scales and does
not answer "most exceptional at something." **Within-perspective percentile** (midrank
ties, computed over the eligible population) is the replacement: each score is ranked
inside its own lens distribution before any cross-perspective comparison.

Parent initiative: #205 — reconceive the identity page (Mirror + Advisor).

## Decision
1. **Introduce a shared percentile layer** in
   `lightroom_tagger/core/identity_service/percentiles.py`, computed **once** over the
   eligible population (`is_current=1`, `image_type='catalog'`, `not_attempted=0`,
   active perspectives), reusing `_SCORES_BASE_SQL`. Output is percentile-rank in
   **[0, 1]** per `(image_key, perspective_slug)`, with **midrank** for ties.
2. **Cross-perspective ranking key** for consumers that need a single sortable scalar:
   **peak within-perspective percentile** — `max(percentile)` across the image's
   scored lenses ("most exceptional at something"). Consumers sort on
   **`ranking_percentile`**, which equals peak unless corroboration is revoked (see
   amendment below). **`peak_percentile`** remains exposed for display and still
   means the max percentile across lenses.
3. **Migrate `GET /api/identity/best-photos` first** (dashboard best-photos widgets;
   lowest-risk consumer: ranking-key change only, no UI restructure). Response exposes
   `peak_percentile` and per-perspective `percentile`; meta `weighting` becomes
   `peak_within_perspective_percentile`.
4. **Keep `compute_image_aggregate_scores` temporarily** — Mirror and Advisor still
   consume the mean until their #205 slices land; delete the mean path in the final
   slice once the last consumer migrates.

### Amendment (2026-09, #280 / #291)

The cross-perspective **sort key** is now **`ranking_percentile`**: when any rendered
lens scored raw **1** (rubric verdict: absent), the image ranks on its
**second-highest** percentile instead of peak; a single lens scoring 1 with no backup
gets `0.0`. `peak_percentile` is unchanged for display. Meta `ranking_key` is
`ranking_percentile`; `corroboration_rule` documents the veto. Measurement and
rationale: [#280](https://github.com/ccanalesb/fixer/issues/280).

## Consequences
- Best-photos and dashboard highlights rank on comparable cross-lens strength instead
  of a scale-mixed mean or raw argmax.
- Mirror and Advisor slices (#205) can import the same percentile module without
  re-deriving distributions per consumer.
- API contract for `/best-photos` changes (`peak_percentile` replaces
  `aggregate_score` on list items); OpenAPI types must be regenerated.
- Detail endpoints and post-next suggestions still expose the mean until migrated;
  clients must not assume one global identity scalar across all routes during the
  transition.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| **Keep equal-weighted mean** | Blends incomparable rubric scales; does not surface "spikes on a lens." |
| **Raw peak (argmax on raw scores)** | #200 finding: ~80% env-context from calibration, not signature. |
| **Z-score per perspective** | Equivalent normalization goal; percentile chosen for bounded [0,1] output and intuitive ranking. |
| **Per-consumer percentile math** | Duplicates eligible-population logic and risks drift; one module is the SSOT. |
