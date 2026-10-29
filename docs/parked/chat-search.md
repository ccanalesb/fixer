# Parked: Chat / NL / semantic search

Retired 2026-08-12 · tag `parked/chat-search` · sha `bdd390f` · [map #218](https://github.com/ccanalesb/fixer/issues/218)

## What it did

A photographer could open the Search page and query the catalog in plain language — for example asking for unposted photos, mountains in spring, or photos sorted by a perspective score. The UI was a chat-style form: each message went through one of several backend strategies (one-shot NL filter, multi-turn NL with structured output, LLM tool-calling over catalog metadata, or semantic hybrid search). Semantic mode combined FTS5 BM25 over AI description text with sqlite-vec KNN over **text** embeddings in `image_text_embeddings` (768-d, `sentence-transformers/all-mpnet-base-v2`), fused with reciprocal-rank fusion. A similarity pin could restrict results to CLIP neighbors of a chosen catalog image. Results showed match scores and short “why matched” snippets where the pipeline produced them.

**Keyword search over descriptions was not part of this surface.** The Images tab already had a separate description-search filter (`description_search` → `image_descriptions_fts`, FTS5 `porter unicode61`) with no LLM and no text embeddings. That filter survives this removal.

## Why it was retired

The chat is trash. The Search page leaned on an LLM tool-calling / semantic / NL-filter runner stack over `image_text_embeddings`; the query experience it bought was not better than a plain keyword match over `image_descriptions` in the existing Images `FilterBar` — no embeddings and no LLM. Per-image latency, cost, and precision for the conversational layer were never measured in the repo; the judgement was made on feel and on the adequacy of the keyword replacement.

## To revive this, one of these would have to change

- The conversational query experience would need to beat deterministic keyword search over `image_descriptions_fts` on precision and speed — with measured evidence, not assumption.
- Text embedding search would need a clear win over FTS for the kinds of queries photographers actually type (or a cheaper embedding path that makes hybrid search worthwhile).
- Tool-calling / NL filter would need to be more reliable and faster than typing filters in the Images bar, at a model cost the owner accepts.

If the keyword filter remains sufficient, nothing would revive the chat layer; retirement is the right diagnosis rather than early timing.

---

**Where it lives:** `git checkout parked/chat-search` · key paths: `apps/visualizer/backend/api/images/search.py`, `apps/visualizer/backend/api/schemas/search.py`, `lightroom_tagger/core/catalog_search.py`, `lightroom_tagger/core/nl_catalog_search.py`, `lightroom_tagger/core/catalog_nl_filter.py`, `lightroom_tagger/core/semantic_search.py`, `lightroom_tagger/core/search_tools.py`, `lightroom_tagger/core/search_tools_definitions.py`, `lightroom_tagger/core/embedding_service.py`, `apps/visualizer/frontend/src/pages/SearchPage.tsx`, `apps/visualizer/frontend/src/types/search.ts` · data dropped: none in this PR (`image_text_embeddings` table retained until [#228](https://github.com/ccanalesb/fixer/issues/228)) · prior design docs: none in `docs/plans/`, `docs/research/`, or `docs/brainstorms/` — this file is the only artifact.
