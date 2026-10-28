# Parked capabilities

Capabilities that were built, used, and then removed from `master` during the consolidation
tracked by [map #218](https://github.com/ccanalesb/fixer/issues/218).

**Removed is not lost.** Git holds every deleted line forever, and each capability has an
annotated tag pointing at the last commit that contained it — `git checkout parked/<slug>`
puts you back in a tree where the feature works. What git cannot hold is *why* it was
retired and what the attempt taught. That is the only job of these docs.

| Capability | Status | Tag | Doc |
| --- | --- | --- | --- |
| Chat / NL / semantic search | retired 2026-08-12 ([#223](https://github.com/ccanalesb/fixer/issues/223)) | `parked/chat-search` | [chat-search.md](chat-search.md) |
| Instagram import + vision matching | retired 2026-08-12 ([#225](https://github.com/ccanalesb/fixer/issues/225)) | `parked/instagram-matching` | [instagram-matching.md](instagram-matching.md) |
| Posting analytics | retired 2026-08-12 ([#222](https://github.com/ccanalesb/fixer/issues/222)) | `parked/posting-analytics` | [posting-analytics.md](posting-analytics.md) |

Each removal PR fills in its own row — adding the retirement date and linking the doc it
writes — so this table is never a promise of a file that does not exist.

## Writing one

Copy [`_TEMPLATE.md`](_TEMPLATE.md). Three sections and a few paragraphs; the header and
footer lines carry the history pointer. **Longer is not better** — a park doc nobody
finishes is worth less than a short one that lands, and the reasoning is the payload, not
the description.

Cut the tag on the last commit that still contains the capability, **before** the removal
PR merges. Run these four steps in order and do not skip the last two — the first two
removals each got this wrong, in different ways:

```sh
# 1. Cut and push, anchored to master as it stands before the removal merges.
git tag -a parked/<slug> -m "last commit containing <capability> (map #218)" origin/master
git push origin parked/<slug>

# 2. Read the SHA back OUT of the tag. Never type it from memory or from a
#    commit you happened to be looking at -- that is how they drift apart.
git rev-list -n1 parked/<slug> | cut -c1-7

# 3. Prove the tag actually contains the capability.
git cat-file -e parked/<slug>:<a path this PR deletes> && echo present

# 4. Prove the tag reached the remote. A local-only tag helps nobody.
git ls-remote --tags origin | grep parked/<slug>
```

Record the tag name and the short SHA from step 2 in the doc header. The tag is what you
check out; the SHA is what survives if the tag is ever deleted or a mirror drops it — so a
SHA that disagrees with its tag is worse than no SHA at all.

**Both failure modes have already happened.** Posting analytics cut the tag but recorded a
different SHA in the doc. Chat search recorded the correct SHA but never cut the tag, so
the doc pointed at a `git checkout` that would fail. Steps 2–4 exist to catch exactly
these, and each is one command.

## Not parked

**Catalog similarity** is not in this directory and should not be added to it. It survives
the consolidation and is being *reframed* rather than retired — see
[#226](https://github.com/ccanalesb/fixer/issues/226). CLIP embeddings,
`clip_similarity` and `sqlite-vec` all stay. Only the Instagram-dump side of CLIP goes,
with [#225](https://github.com/ccanalesb/fixer/issues/225).

Removal and reframe are different diagnoses. The three capabilities above failed on cost,
precision, or a dependency that was itself being deleted — no change of presentation fixes
any of those. A capability that goes unused because it was *framed* badly is a design
problem, and belongs in a design ticket, not here.
