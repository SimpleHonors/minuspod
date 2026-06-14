"""Snap detected ad start edges to nearby audio cues (#350 v2).

A short ding or stinger usually plays *just before* the ad copy starts. When
the cue detector flags one within a small window of an LLM-detected ad's
``start``, we snap ``start`` to the cue end so the cut lands on the chime
boundary rather than a beat into the spoken copy.

This is start-edge only; the end edge stays at the model's choice unless a
later iteration adds outro-cue handling. The maximum snap distance is hard-
capped by ``max_boundary_shift_seconds`` (the same setting the reviewer pass
honors) so a misfiring cue cannot warp the boundary by more than the user-
permitted amount.

Pure function over ad dicts and audio signals; no DB, no LLM, no IO.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional

logger = logging.getLogger('podcast.claude.cue_snap')


# How far back from the ad start the cue is allowed to sit. Stingers usually
# land 0-3s before the spoken copy.
DEFAULT_SNAP_LEAD_SECONDS = 4.0
# How far past the ad start the cue is allowed to sit. Detection latency
# (whisper segment alignment + first-pass window edge) puts the LLM's start
# slightly after the cue some of the time, so we allow a small overshoot.
DEFAULT_SNAP_LAG_SECONDS = 2.0
# Gap between the cue's end and the snapped ad start. Tiny lead so the cut
# does not slice into the trailing decay of the ding.
SNAP_GAP_SECONDS = 0.05
# Minimum cue confidence to consider for snapping.
MIN_CUE_CONFIDENCE_FOR_SNAP = 0.80


def snap_ad_starts_to_cues(
    ads: List[Dict],
    audio_analysis_result,
    max_boundary_shift_s: float,
    snap_lead_s: float = DEFAULT_SNAP_LEAD_SECONDS,
    snap_lag_s: float = DEFAULT_SNAP_LAG_SECONDS,
) -> List[Dict]:
    """Return ``ads`` with each ``start`` snapped to a nearby cue end when one exists.

    Each ad keeps a record of the snap in ``ad['cue_snap']`` so downstream
    logging and the UI can show why the boundary moved.

    Args:
        ads: List of ad dicts (``start``, ``end``, …). Mutated in place but
            also returned for ergonomics.
        audio_analysis_result: ``AudioAnalysisResult`` from the analyzer, or
            ``None`` to no-op.
        max_boundary_shift_s: Hard cap on absolute snap distance.
        snap_lead_s: Window before ``start`` to search for a cue end.
        snap_lag_s: Window after ``start`` to search for a cue end.
    """
    if not ads or not audio_analysis_result:
        return ads
    cues = audio_analysis_result.get_signals_by_type('audio_cue') if audio_analysis_result else []
    if not cues:
        return ads
    cues = [c for c in cues if c.confidence >= MIN_CUE_CONFIDENCE_FOR_SNAP]
    if not cues:
        return ads

    for ad in ads:
        try:
            original_start = float(ad['start'])
        except (KeyError, TypeError, ValueError):
            continue
        ad_end = ad.get('end')
        candidate = _pick_cue_for_start(
            cues, original_start, ad_end, snap_lead_s, snap_lag_s,
        )
        if candidate is None:
            continue
        proposed_start = candidate.end + SNAP_GAP_SECONDS
        # Never push past the ad's end.
        if ad_end is not None and proposed_start >= float(ad_end):
            continue
        shift = abs(proposed_start - original_start)
        if shift > max_boundary_shift_s:
            continue
        if shift < 0.01:
            continue
        ad['start'] = round(proposed_start, 3)
        ad['cue_snap'] = {
            'original_start': round(original_start, 3),
            'cue_start': round(candidate.start, 3),
            'cue_end': round(candidate.end, 3),
            'cue_confidence': round(candidate.confidence, 3),
            'shift_seconds': round(proposed_start - original_start, 3),
            'template_id': (candidate.details or {}).get('template_id'),
            'label': (candidate.details or {}).get('label'),
            'source': (candidate.details or {}).get('source', 'spectral'),
        }
        logger.info(
            f"Cue snap: ad start {original_start:.3f}s -> {proposed_start:.3f}s "
            f"(Δ={proposed_start - original_start:+.3f}s, "
            f"cue={ad['cue_snap'].get('label') or 'spectral'}, "
            f"conf={candidate.confidence:.2f})"
        )
    return ads


def _pick_cue_for_start(
    cues: List, ad_start: float, ad_end: Optional[float],
    snap_lead_s: float, snap_lag_s: float,
):
    """Find the best cue to snap ``ad_start`` to.

    Best = highest confidence within the search window whose end is not past
    the ad's end. Ties broken by proximity to ``ad_start``.
    """
    low = ad_start - snap_lead_s
    high = ad_start + snap_lag_s
    best = None
    best_key = None
    for cue in cues:
        cue_end = cue.end
        if cue_end < low or cue_end > high:
            continue
        if ad_end is not None and cue_end >= float(ad_end):
            continue
        # Prefer higher confidence, then closer to ad_start.
        key = (cue.confidence, -abs(cue_end - ad_start))
        if best_key is None or key > best_key:
            best = cue
            best_key = key
    return best
