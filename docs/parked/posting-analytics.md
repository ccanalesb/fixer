# Parked: Posting analytics

Retired 2026-08-12 · tag `parked/posting-analytics` · sha `dab3ac9` · [map #218](https://github.com/ccanalesb/fixer/issues/218)

## What it did

A photographer could open the Analytics page to see how often they posted to Instagram over a chosen date range — as a frequency chart (daily, weekly, or monthly buckets), a day-of-week × hour heatmap, and caption/hashtag aggregates (top hashtags, average caption length, and similar summary stats). The Insights home showed a mini frequency chart for the last twelve months and linked the “Posted to Instagram” KPI to that page. A separate panel listed catalog images not yet marked posted (`instagram_posted = 0`), filterable by date, rating, and month. All of this drew from **validated matches** only: rows in `instagram_dump_media` joined to `matches` where `validated_at IS NOT NULL`, with event time from `created_at` or a `date_folder` fallback.

## Why it was retired

Analytics is also not worth it anymore. Structurally, the feature read only `instagram_dump_media ⋈ matches WHERE validated_at IS NOT NULL`, so it could not have survived the Instagram dump-import removal regardless of preference. No per-query cost, precision threshold, or population size for analytics was measured or recorded in the repo.

## To revive this, one of these would have to change

- The Instagram dump import and validated-match pipeline would need to return (or be replaced by another source of confirmed Instagram post timestamps and captions tied to catalog images).
- Posting cadence would need a data source that does not depend on `instagram_dump_media` — for example, a maintained export API, manual post-date entry at scale, or syncing from a platform that outlives the dump workflow.
- If the judgement stands on usefulness alone, nothing would revive it; the retirement was not only a dependency issue.

---

**Where it lives:** `git checkout parked/posting-analytics` · key paths: `apps/visualizer/backend/api/analytics.py`, `apps/visualizer/backend/api/schemas/analytics.py`, `lightroom_tagger/core/posting_analytics.py`, `lightroom_tagger/core/posting_analytics_captions.py`, `apps/visualizer/frontend/src/pages/AnalyticsPage.tsx`, `apps/visualizer/frontend/src/components/analytics/*`, `apps/visualizer/frontend/src/components/insights/MiniPostingFrequencyChart.tsx` · data dropped: none in this PR (table drops tracked separately in [#228](https://github.com/ccanalesb/fixer/issues/228)) · prior design docs: no `docs/plans/`, `docs/research/`, or `docs/brainstorms/` entries for analytics — this file is the only artifact.
