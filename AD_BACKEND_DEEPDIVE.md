# Ad-Detection Backend: Keep-Ours vs Adopt-Upstream — Decision Deep-Dive

**Date:** 2026-06-16
**Branch under analysis:** `simplehonors-patches` (HEAD `00d8f759`)
**Upstream ref:** `upstream/main` (HEAD `cfada6c0`, v2.8.x)
**Merge-base:** `650e98e2` — "feat(2.5.6): Podcasting 2.0 channel tags + feed-rewrite hardening (#260)", dated **2026-05-19**

---

## TL;DR — the premise is wrong, and that changes the decision

The task brief says "our fork rewrote/SIMPLIFIED the ad-detection backend, deleting ~1,080 net lines." **That is not what the git history shows.**

We never touched the detection backend. Every one of the focus files is **byte-for-byte identical to the merge-base**:

```
src/ad_detector/__init__.py : IDENTICAL to merge-base
src/ad_reviewer.py          : IDENTICAL to merge-base
src/sponsor_service.py      : IDENTICAL to merge-base
src/ad_validator.py         : IDENTICAL to merge-base
src/ad_detector/boundaries.py: IDENTICAL to merge-base
```

`git diff --numstat <merge-base>..HEAD` for these files returns **empty**. Our 46 branch-only commits touch the detection files **only through merge commits** that pulled upstream forward to the 2.5.6 point — never an edit of our own.

So "ours is simpler / has fewer lines" does **not** mean we deliberately rewrote or removed capability. It means **ours is simply older**: frozen at v2.5.6 (May 19), while upstream has moved on to v2.8.x (June 15). The "~1,080 net line" difference is **upstream adding features on top of the shared base**, not us deleting anything.

This reframes the whole question. It is not "keep our clever rewrite vs throw it away for upstream." It is **"stay pinned at an old snapshot of the detection code vs take the newer upstream version of the exact same code lineage."** There is no bespoke work of ours to lose in these files.

**Verdict: ADOPT UPSTREAM's detection backend.** There is essentially no downside — we wrote nothing here to preserve, upstream's version is a strict superset with real bug-fixes and features, and our actual differentiator (the Ad Inbox) does not depend on the detection backend's Python interface at all.

---

## 1. WHAT we changed — nothing, in the detection backend

### Line counts, ours vs upstream (every file is smaller because ours is older)

| File | OURS (lines) | UPSTREAM (lines) | upstream adds (ins/del vs ours) |
|---|---|---|---|
| `src/ad_detector/__init__.py` | 1431 | 1632 | +410 / -209 |
| `src/ad_detector/boundaries.py` | 857 | 896 | +84 / -45 |
| `src/ad_detector/prompts.py` | 396 | 414 | +18 / -0 |
| `src/ad_reviewer.py` | 650 | 768 | +151 / -33 |
| `src/ad_validator.py` | 687 | 708 | +25 / -4 |
| `src/sponsor_service.py` | 374 | 434 | +85 / -25 |
| **Total** | | | **+773 / -316** (≈ +457 net upstream) |

`git diff --stat HEAD upstream/main` over these files: **773 insertions, 316 deletions, 6 files**. All of that delta is upstream-ahead-of-us; **zero** of it is our edits.

### Characterization

The change is type **(none-of-the-above)**: we did not (a) refactor, (b) remove capability, or (c) swap an algorithm for a simpler one. We **froze** the code at an earlier point. Upstream then did (a)+(b-additions) on top. There is no "our algorithm" vs "their algorithm" — it is the same file lineage, ours just stops 4 weeks earlier.

---

## 2. WHY we did it — we didn't (no rationale exists)

`git log <merge-base>..HEAD -- <detection files>` returns only **two merge commits**:

```
6ddc4641 Merge remote-tracking branch 'origin/main' into rebase-attempt-simplehonors
4c781cfe Merge upstream v2.0.24/v2.0.25/v2.0.26 into simplehonors-patches
```

No feature/fix/refactor commit of ours ever lands in the detection backend. There is no design rationale to honor because there was no design decision — only "we stopped pulling upstream after 2.5.6."

Where our 46 commits **did** do real work is the **Ad Inbox** (see §4):
```
c694e9..916feb  feat/fix(ad-inbox): ... 10 commits
```
That is our differentiator, and it lives in *different* files.

---

## 3. CAPABILITY DELTA — upstream is a strict superset; ours is missing real fixes

Because our files are an older snapshot, **everything upstream added since 2.5.6 is capability we currently lack.** Headline upstream commits on these files (`git log <merge-base>..upstream/main`):

| SHA | What it adds (that we don't have) |
|---|---|
| `f1624daa` | **#320 fix: keep multi-word sponsors intact; honor reviewer boundary keys.** `_extract_ad_keywords` no longer lets a generic token like "one" (decomposed from a multi-word sponsor) relocate an ad onto unrelated editorial; normalizes sponsor whitespace. `ad_reviewer` reads `corrected_/adjusted_` boundary keys when `start/end` absent, and rejects NaN/Inf/bool. **This is a correctness fix we are missing.** |
| `cbbf940a` | **#360 learned ad positions experiment (2.8.9).** Per-feed ad-break zones learned from cut history + user corrections; per-feed position boosts replacing global pre/mid/post-roll boosts. Off by default behind `positional_prior_enabled`. Adds `src/positional_prior.py` (+274) and touches `ad_detector/__init__.py`, `ad_validator.py`. New capability we lack. |
| `ca38b947` | **#325 sponsors management UI + pattern-stats enrichment + real delete.** Backend `sponsor_service.py`/`database/sponsors.py` gain pattern-stats on sponsor list/detail and a hard-delete path. We lack the pattern-stats enrichment. |
| `89f71d9f` | 2.8.7: LLM-only reprocess, audio-cue experiment, cut-accuracy improvements. |
| `9f342777` | 2.8.8: fixes for six deferred 2.8.x defects. |
| `e9e18538` | **v2.6.0 audit remediation: security + correctness fixes.** We are below this — we do **not** have these security/correctness fixes. |
| `77bc039c` | 2.5.27: parallel detection/reviewer, env-backed settings, skip-FLAC. |

**Concrete boundary-key contract gap** (`ad_reviewer.py`): upstream's parser falls back through `("start", "corrected_start", "adjusted_start")` and `("end", "corrected_end", "adjusted_end")` (lines ~412-417), with an explicit docstring "fall back to corrected_/adjusted_ only when start/end absent." **Ours has no `corrected_*` handling at all** — only `adjusted_*`. If an LLM or a stored correction emits `corrected_start`/`corrected_end`, our version silently ignores it; upstream honors it. This is the #320 robustness fix, and we are on the wrong side of it.

**Does ours have anything upstream lacks?** No. Ours is a pure subset of upstream's git lineage for these files. There is no behavior in our detection backend that upstream removed or regressed — upstream's diff is overwhelmingly additive (+773/-316, and the deletions are refactors that replace older lines in the same functions, not capability removal).

**Net:** Keeping ours = permanently running detection code that is missing a multi-word-sponsor correctness fix (#320), a v2.6.0 security/correctness audit pass, and the learned-positions feature (#360). Adopting upstream = gaining all of it.

---

## 4. COUPLING RISK — the Ad Inbox does NOT touch the detection backend (near-zero risk)

This is the decisive structural fact. Our must-keep feature is the Ad Inbox:
```
src/ad_inbox_service.py        (136 lines, OURS — upstream has 0)
src/api/ad_inbox.py            (OURS — upstream has 0)
frontend/src/api/adInbox.ts    (OURS — upstream has 0)
frontend/src/components/AdReviewModal.tsx
tests/unit/test_ad_inbox.py
```

**`ad_inbox_service.py` imports only `json` and `typing.Iterator`.** It imports **nothing** from `ad_detector`, `ad_reviewer`, `sponsor_service`, `ad_validator`, or `boundaries`:
```python
import json
from typing import Iterator
```
`api/ad_inbox.py` imports only `enumerate_inbox_items` and `VALID_INBOX_STATUSES` from `ad_inbox_service` — again nothing from the detection backend.

**What the Ad Inbox actually depends on is the DATABASE layer, not the detection Python API:**
- `db.get_all_ad_markers()` → rows carrying `ad_markers_json`, `podcast_slug`, `podcast_title`, `episode_id`, `episode_title`, `published_at`, `processed_version`, `original_duration`.
- `db.get_corrections_for_episodes()` → `pattern_corrections` rows with `correction_type` and `corrected_bounds` (JSON).
- Per-ad marker fields it reads: `start`, `end`, `sponsor`, `confidence`, `pattern_id`, `status`.
- It maps `pattern_corrections.correction_type` (`confirm`/`false_positive`/`boundary_adjustment`/`promotion`/`create`) → inbox status.

**Contract implication:** The interface between detection and the Ad Inbox is the **shape of `ad_markers_json` and the `pattern_corrections` table** — both of which are DB artifacts produced by the *processing pipeline*, not by signatures inside the detection modules. Adopting upstream's detection backend changes those DB shapes **only if** upstream changed the marker JSON keys or `pattern_corrections` schema.

- The ad-marker fields the Inbox reads (`start`, `end`, `sponsor`, `confidence`, `pattern_id`, `status`) are stable, long-standing keys; upstream's #360 work *adds* per-feed position data but does not remove these.
- `pattern_corrections.corrected_bounds` and `correction_type` are pre-existing columns; upstream #320 actually *strengthens* reading of `corrected_*` keys, which is aligned with what the Inbox already writes.

**So the realistic break surface on adopting upstream is: verify the `ad_markers_json` key set and `pattern_corrections` columns still match what `ad_inbox_service.enumerate_inbox_items` reads.** That is a small, testable check (we already have `tests/unit/test_ad_inbox.py`), not a rewrite. Notably, our most recent Inbox commits (`916febfc` "adapt AdInboxPage to upstream AdReviewModal API", `5825cecf`) show we have *already* been adapting the Inbox UI toward upstream conventions — the team is implicitly tracking upstream, not diverging from it.

---

## 5. FUTURE MERGE-ABILITY — keeping ours is permanent, recurring friction

`git log <merge-base>..upstream/main -- <detection files> | wc -l` = **10 commits** in ~4 weeks (2.5.6 → 2.8.x), i.e. upstream touches the detection backend roughly **every few days**. Headline cadence:

```
4f210875 release 2.8.11 (#376/#378)
cbbf940a feat: learned ad positions #360 (2.8.9)
9f342777 release 2.8.8: six deferred defects
89f71d9f release 2.8.7: LLM-only reprocess, cut accuracy
7aca76ad feat(openrouter) (2.7.5)
ca38b947 feat: sponsors management UI + pattern stats (#325)
f1624daa fix(ad-detection): multi-word sponsors #320
e9e18538 v2.6.0 audit remediation: security + correctness
77bc039c 2.5.27: parallel detection/reviewer
5087d5c9 2.5.13: pattern false-positive fixes
```

These are **active, high-churn files** (the heart of the product). Every upstream upgrade will keep modifying them.

- **If we keep ours:** every future upgrade re-creates a 6-file, ~hundreds-of-line divergence to reconcile by hand — *and we have no local edits that justify the friction*. We'd be paying a recurring merge tax to preserve nothing.
- **If we adopt theirs:** because our files are byte-identical to the merge-base, **adopting upstream is a clean fast-forward of these files — no conflicts to resolve.** Future upgrades then merge cleanly too, since we'd carry zero local modifications in the detection backend going forward.

This is the rare case where "adopt theirs" is not just easier long-term but is *free right now*: there is nothing of ours to overwrite.

---

## 6. RECOMMENDATION — ADOPT UPSTREAM (clean, low-risk, no loss)

**Call: ADOPT UPSTREAM's detection backend.** Take upstream's `ad_detector/`, `ad_reviewer.py`, `ad_validator.py`, `sponsor_service.py`, `boundaries.py`, `prompts.py` wholesale. Keep our Ad Inbox files (they're ours and upstream has none of them).

### Why
1. **We have no work to lose here.** All six files are identical to the merge-base; "simplified" was a misread — it just means "older v2.5.6." (Facts: `git diff --quiet` clean on every file; `MB..HEAD` numstat empty.)
2. **Upstream is a strict superset with real fixes** we currently lack: #320 multi-word-sponsor correctness + `corrected_*` boundary keys, v2.6.0 security/correctness audit, #360 learned positions. (Facts: per-file +773/-316 all upstream-ahead; `corrected_*` handling present upstream, absent ours.)
3. **Our differentiator is decoupled.** `ad_inbox_service.py` imports only `json`/`typing`; the Inbox talks to the DB layer, not the detection Python API. Adopting upstream cannot break the Inbox through import/signature changes. (Fact: grep shows no detection imports anywhere in the Inbox.)
4. **It's clean both now and forever.** Identical-to-base files fast-forward without conflict; carrying zero local detection edits keeps all future upgrades clean. Upstream touches these files ~every few days (10 commits/4 weeks).

### Cost of each path

| Path | Effort | Risk | What's lost |
|---|---|---|---|
| **ADOPT THEIRS (recommended)** | Low. Fast-forward the 6 files to upstream; then run `tests/unit/test_ad_inbox.py` + verify `ad_markers_json` keys and `pattern_corrections` columns still match `enumerate_inbox_items`. | Low. Only real check: marker-JSON / corrections-schema shape feeding the Inbox. Both appear unchanged (keys the Inbox reads are stable; #320 strengthens `corrected_*` which aligns with us). | **Nothing** — we wrote nothing in these files. |
| **KEEP OURS** | High and recurring. Re-reconcile a 6-file, hundreds-of-line divergence on every future upstream upgrade, forever. | Medium-rising. We permanently run detection missing a correctness fix (#320) and a security/correctness audit (v2.6.0); the gap widens each release. | The #320 multi-word fix, v2.6.0 security fixes, #360 learned positions, 2.8.x cut-accuracy work — and engineering time. |
| **HYBRID** | N/A | N/A | Not applicable. A hybrid only makes sense when you have bespoke local logic worth carrying forward. We have none in the detection backend, so there is nothing to cherry-pick or preserve — a hybrid would be strictly worse than a clean adopt. |

### Concrete next steps if adopting
1. `git checkout upstream/main -- src/ad_detector src/ad_reviewer.py src/ad_validator.py src/sponsor_service.py` (plus any new files upstream introduced, e.g. `src/positional_prior.py`, and the matching `src/config.py`/`database/*` deltas those features need — check `git show cbbf940a --stat`).
2. Pull the DB/migration and `database/patterns.py`, `database/sponsors.py`, `database/episodes.py` changes those features depend on (they ship together in #325/#360).
3. Run `tests/unit/test_ad_inbox.py`; confirm `ad_markers_json` keys (`start/end/sponsor/confidence/pattern_id/status`) and `pattern_corrections` columns (`correction_type`, `corrected_bounds`) are unchanged.
4. Keep all `*ad_inbox*` / `adInbox.ts` / `AdReviewModal.tsx` files as-is.

---

*Method note: all line counts and ancestry derived from `git diff --numstat`, `git diff --quiet`, `git show <ref>:<file> | wc -l`, and `git log <merge-base>..<ref>` against merge-base `650e98e2`. No files were modified during analysis.*
