# Parked: Instagram import + vision matching

Retired 2026-08-12 · tag `parked/instagram-matching` · sha `2fcc99a` · [map #218](https://github.com/ccanalesb/fixer/issues/218)

## What it did

A photographer could import an Instagram export dump (ZIP or folder — no API access), run vision matching to pair each dump JPEG with catalog RAWs/JPEGs, review proposed matches in the visualizer, and validate pairings. The pipeline combined EXIF date-window candidate selection, perceptual-hash and description-text similarity, CLIP shortlisting, and side-by-side vision comparison into a single **match score** (`total_score`). Validated matches could drive posting analytics (removed in [#222](https://github.com/ccanalesb/fixer/issues/222)); the matcher also auto-set `instagram_posted` on catalog images when a match was validated — replaced in [#224](https://github.com/ccanalesb/fixer/issues/224) by a manual toggle. Console entry points: `lightroom-import-dump`, `lightroom-match-dump`, `lightroom-run-matching`, `lightroom-analyze-instagram`, `lightroom-generate-report`. Removal spanned three slices ([#225](https://github.com/ccanalesb/fixer/issues/225)): slice 1 dropped the UI, slice 2 the HTTP/job surfaces, slice 3 the library, scripts, and this doc. [#228](https://github.com/ccanalesb/fixer/issues/228) exported irreplaceable rows and dropped the dead tables.

## Why it was retired

Vision-comparing Instagram JPEGs against catalog RAWs was too expensive per image and not precise enough to trust at the thresholds actually used. Default weights in `lightroom_tagger/core/config.py` were `phash_weight` 0.4, `desc_weight` 0.3, `vision_weight` 0.3; `match_threshold` defaulted to 0.7. Per-image vision cost, wall-clock time for a full dump run, and precision/recall on validated pairs were never measured in the repo. Batch vision API timing notes in `docs/BATCH_API_TESTING_RESULTS.md` (~20–90 seconds per batch call, not per matched image) do not substitute for end-to-end matching economics.

## To revive this, one of these would have to change

- Vision comparison would need to become cheap enough per Instagram↔catalog pair that a full dump run is acceptable — with measured cost, not assumed.
- Match precision would need to meet the bar implied by the default `match_threshold` of 0.7 (or the threshold would need to be lowered with evidence that false positives are acceptable).
- A different data source or scope (e.g. same-format exports, narrower date windows, or human-in-the-loop at smaller scale) would need to make the pairing problem tractable without the retired multi-signal stack.

If neither cost nor precision improves, nothing would revive it; the retirement was empirical, not a timing issue.

## Export artifact ([#228](https://github.com/ccanalesb/fixer/issues/228))

On first `init_database()` after upgrading to a build that includes the `user_version` 6→7 migration, the library writes **`instagram-matching-export.json`** in the same directory as `library.db` (resolved from `LIBRARY_DB`, default `./library.db`). The file is written **before** any `DROP` or orphan `DELETE`; opening the visualizer or any job handler triggers the migration.

### Schema (`schema_version` 1)

| Top-level key | Contents |
|---|---|
| `exported_at` | UTC ISO timestamp of the final write |
| `library_db` | Absolute path to the database file |
| `tables.matches` | `{ present, row_count, rows }` — validated/proposed catalog↔Instagram pairings |
| `tables.instagram_dump_media` | `{ present, row_count, rows }` — dump JPEG metadata (captions, `created_at`, paths) |
| `tables.rejected_matches` | `{ present, row_count, rows }` — human "not a match" corrections |
| `image_descriptions_instagram` | `{ row_count, rows }` — vision-model description output for dump media |
| `image_scores_instagram` | `{ row_count, rows }` — per-perspective scores for dump media |
| `catalog_counts_verified` | `image_descriptions_catalog` / `image_scores_catalog` counts before and after (must match) |
| `deleted` | Row counts removed from `image_descriptions` / `image_scores` where `image_type = 'instagram'` |

When a source table never existed (fresh DB after code removal), `present` is `false` and `row_count` is 0 — not an empty artifact that implies data loss.

### Reading it back

```python
import json
from pathlib import Path

export = json.loads(Path("/path/to/library.db").with_name("instagram-matching-export.json").read_text())
matches = export["tables"]["matches"]["rows"]
dump_media = export["tables"]["instagram_dump_media"]["rows"]
rejected = export["tables"]["rejected_matches"]["rows"]
ig_descriptions = export["image_descriptions_instagram"]["rows"]
ig_scores = export["image_scores_instagram"]["rows"]
```

`images.instagram_posted` was **not** exported — it remains in `library.db` as the manual posted flag.

---

**OpenCLI scraping bridge:** The `.opencli/clis/instagram/` and `.opencli/explore/instagram/` adapter trees were removed with the rest of the Instagram surface (2026-08-13, map #218). They exposed `opencli instagram profile|posts|images` via a Chrome extension bridge — the same scraping path this pipeline no longer depends on.

**Visualizer dump-path config:** `GET`/`PUT /api/config/instagram-dump`, the `instagram_dump_path` `Config` field, `INSTAGRAM_DUMP_PATH` env override, and `update_config_yaml_instagram_dump_path` were removed in [#253](https://github.com/ccanalesb/fixer/issues/253) after the importer was deleted in [#225](https://github.com/ccanalesb/fixer/issues/225); frontend clients went in [#252](https://github.com/ccanalesb/fixer/issues/252).

**Where it lives:** `git checkout parked/instagram-matching` · key paths: `lightroom_tagger/instagram/` (`dump_reader.py`, `deduplicator.py`), `lightroom_tagger/core/matcher/`, `lightroom_tagger/core/analyzer/compare.py`, `lightroom_tagger/core/analyzer/vision_compare.py`, `lightroom_tagger/core/database/instagram.py`, `matches.py`, `match_pool_snapshots.py`, matching console scripts under `lightroom_tagger/scripts/`, visualizer Instagram/match pages and APIs (slices 1–2) · data: `instagram-matching-export.json` next to `library.db` · prior design docs: `docs/comparison-pool-report.md` (removed with slice 3), `docs/plans/2026-03-17-multi-signal-matching*.md`, `docs/plans/2026-03-17-vision-model-matching.md`, `docs/plans/2026-04-06-parallel-batch-vision-matching.md`
