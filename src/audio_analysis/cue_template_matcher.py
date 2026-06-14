"""Per-feed audio cue template matcher (#350 v2).

Each template is a short MFCC matrix the user marked on one episode. This
detector decodes the full episode to MFCC once, then for every template runs a
normalized cross-correlation against the episode-MFCC time axis. Each above-
threshold peak becomes an ``audio_cue`` ``AudioSegmentSignal`` that rides the
existing pipeline -- prompt injection in ``AudioEnforcer`` and start-edge snap
in ``cue_boundary_snap``.

Why MFCC NCC and not Chromaprint / spectrogram pixel match:
- Chromaprint's sub-fingerprint resolution is ~124 ms, too coarse to snap an
  ad start edge to the millisecond-resolution we need for short stingers.
- MFCC NCC is the canonical short-acoustic-event template match in the
  literature. ~1-2s wall time per template on a 1-hour episode at 16 kHz.
- Cepstral mean normalization in ``cue_features`` cancels channel EQ
  differences between the user's marked occurrence and other occurrences.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Dict, List, Optional

import numpy as np

from .base import AudioSegmentSignal, SignalType
from .cue_features import (
    FRAME_HOP_MS,
    SAMPLE_RATE_HZ,
    compute_mfcc,
    decode_pcm_window,
    deserialize_mfcc,
)
from utils.audio import get_audio_duration

logger = logging.getLogger('podcast.audio_analysis.cue_template')


# Default threshold; tuneable via DB setting `audio_cue_template_score`.
DEFAULT_MATCH_SCORE = 0.85
# Max matches we report per template per episode -- bounds prompt size.
MAX_MATCHES_PER_TEMPLATE = 50
# Episode is decoded in chunks of this many seconds with `OVERLAP_S` overlap
# so a template straddling a chunk boundary still matches. Keep memory bounded
# on very long episodes.
CHUNK_SECONDS = 600
CHUNK_OVERLAP_SECONDS = 30


@dataclass
class _Template:
    template_id: int
    label: str
    mfcc: np.ndarray             # (n_frames, n_coeffs) float32
    duration_s: float
    n_coeffs: int


class AudioCueTemplateMatcher:
    """Detect occurrences of stored cue templates in an episode."""

    def __init__(
        self,
        templates: List[Dict],
        score_threshold: float = DEFAULT_MATCH_SCORE,
        max_matches_per_template: int = MAX_MATCHES_PER_TEMPLATE,
    ):
        self.score_threshold = score_threshold
        self.max_matches_per_template = max_matches_per_template
        self._templates: List[_Template] = []
        for row in templates:
            try:
                mfcc = deserialize_mfcc(row['mfcc_blob'], int(row['n_coeffs']))
            except (ValueError, KeyError) as e:
                logger.warning(
                    f"Skipping cue template {row.get('id')}: bad mfcc blob ({e})"
                )
                continue
            if mfcc.shape[0] < 3:
                logger.warning(
                    f"Skipping cue template {row.get('id')}: only "
                    f"{mfcc.shape[0]} frames"
                )
                continue
            self._templates.append(_Template(
                template_id=int(row['id']),
                label=row.get('label') or f"template-{row['id']}",
                mfcc=mfcc,
                duration_s=float(row['duration_s']),
                n_coeffs=int(row['n_coeffs']),
            ))

    @property
    def is_usable(self) -> bool:
        return bool(self._templates)

    def detect(self, audio_path: str) -> List[AudioSegmentSignal]:
        """Run all templates against the episode at ``audio_path``."""
        if not self._templates:
            return []

        duration = get_audio_duration(audio_path)
        if not duration:
            logger.warning("Could not determine audio duration for cue template detection")
            return []

        signals: List[AudioSegmentSignal] = []
        per_template_matches: Dict[int, List[AudioSegmentSignal]] = {
            t.template_id: [] for t in self._templates
        }

        start_wall = time.time()
        chunk_start = 0.0
        while chunk_start < duration:
            chunk_end = min(duration, chunk_start + CHUNK_SECONDS)
            try:
                pcm = decode_pcm_window(
                    audio_path, chunk_start, chunk_end, SAMPLE_RATE_HZ,
                )
            except RuntimeError as e:
                logger.warning(f"Cue chunk decode failed at {chunk_start:.1f}s: {e}")
                break
            chunk_mfcc = compute_mfcc(pcm)
            if chunk_mfcc.shape[0]:
                self._scan_chunk(chunk_mfcc, chunk_start, per_template_matches)

            if chunk_end >= duration:
                break
            chunk_start = chunk_end - CHUNK_OVERLAP_SECONDS

        for template_id, matches in per_template_matches.items():
            if not matches:
                continue
            matches.sort(key=lambda s: s.confidence, reverse=True)
            kept = matches[:self.max_matches_per_template]
            # Drop duplicates from chunk overlap: peaks within one template
            # duration of each other are the same event.
            kept = self._dedupe(kept)
            signals.extend(kept)

        elapsed = time.time() - start_wall
        logger.info(
            f"Cue template match: {len(self._templates)} template(s), "
            f"{len(signals)} signal(s) in {elapsed:.1f}s"
        )
        return signals

    def _scan_chunk(
        self,
        chunk_mfcc: np.ndarray,
        chunk_offset_s: float,
        per_template_matches: Dict[int, List[AudioSegmentSignal]],
    ) -> None:
        hop_s = FRAME_HOP_MS / 1000.0
        for tpl in self._templates:
            if tpl.mfcc.shape[1] != chunk_mfcc.shape[1]:
                logger.warning(
                    f"Template {tpl.template_id} n_coeffs={tpl.mfcc.shape[1]} "
                    f"!= chunk n_coeffs={chunk_mfcc.shape[1]}; skipping"
                )
                continue
            if chunk_mfcc.shape[0] < tpl.mfcc.shape[0]:
                continue
            scores = _sliding_cosine(chunk_mfcc, tpl.mfcc)
            if not scores.size:
                continue
            # Local-maximum peak pick within a window of template duration.
            tpl_frames = tpl.mfcc.shape[0]
            suppress_frames = max(1, tpl_frames)
            peaks = _peak_pick(scores, self.score_threshold, suppress_frames)
            for frame_idx, score in peaks:
                start_s = chunk_offset_s + frame_idx * hop_s
                end_s = start_s + tpl.duration_s
                confidence = float(min(0.99, max(0.0, score)))
                per_template_matches[tpl.template_id].append(AudioSegmentSignal(
                    start=round(start_s, 3),
                    end=round(end_s, 3),
                    signal_type=SignalType.AUDIO_CUE.value,
                    confidence=round(confidence, 3),
                    details={
                        'source': 'template',
                        'template_id': tpl.template_id,
                        'label': tpl.label,
                        'score': round(score, 3),
                    },
                ))

    @staticmethod
    def _dedupe(matches: List[AudioSegmentSignal]) -> List[AudioSegmentSignal]:
        """Drop matches whose start is within 0.25s of a kept higher-score match.

        Templates are short so cross-chunk overlap and near-peaks of the same
        event can land within a hundred ms of each other.
        """
        matches.sort(key=lambda s: s.confidence, reverse=True)
        kept: List[AudioSegmentSignal] = []
        for m in matches:
            if any(abs(m.start - k.start) < 0.25 for k in kept):
                continue
            kept.append(m)
        kept.sort(key=lambda s: s.start)
        return kept


def _sliding_cosine(haystack: np.ndarray, needle: np.ndarray) -> np.ndarray:
    """Cosine similarity of ``needle`` against every ``len(needle)`` slice of ``haystack``.

    Both inputs are float32 ``(n_frames, n_coeffs)``. Returns a 1D array of
    length ``haystack.shape[0] - needle.shape[0] + 1``.

    Uses FFT-based cross-correlation per coefficient (``np.convolve`` would be
    ``O(N*M)`` and dominates wall time on long episodes); the per-coeff
    correlations are summed then normalized by the L2 norm of each haystack
    window. This is mathematically identical to per-window flattened cosine
    similarity, just vectorized across all windows.
    """
    n_haystack, n_coeffs = haystack.shape
    n_needle = needle.shape[0]
    n_out = n_haystack - n_needle + 1
    if n_out <= 0:
        return np.zeros(0, dtype=np.float32)

    needle_flat_norm = float(np.linalg.norm(needle))
    if needle_flat_norm == 0:
        return np.zeros(n_out, dtype=np.float32)

    # Per-coefficient correlation along axis 0, then sum across coeffs.
    # `oaconvolve` (overlap-add FFT) is faster than fftconvolve on long inputs.
    # We use `scipy.signal.fftconvolve(haystack, needle[::-1])` for each coeff
    # to get the cross-correlation (valid mode).
    from scipy.signal import fftconvolve
    numerator = np.zeros(n_out, dtype=np.float32)
    for c in range(n_coeffs):
        corr = fftconvolve(haystack[:, c], needle[::-1, c], mode='valid')
        numerator += corr[:n_out].astype(np.float32)

    # Haystack window L2 norm: use rolling sum-of-squares.
    sq = (haystack ** 2).sum(axis=1).astype(np.float64)
    csum = np.concatenate([[0.0], np.cumsum(sq)])
    window_sq = csum[n_needle:] - csum[:-n_needle]
    window_sq = window_sq[:n_out]
    window_norm = np.sqrt(np.maximum(window_sq, 1e-12)).astype(np.float32)

    denom = window_norm * needle_flat_norm
    scores = numerator / np.maximum(denom, 1e-12)
    return scores.astype(np.float32)


def _peak_pick(scores: np.ndarray, threshold: float,
               suppress_frames: int) -> List[tuple]:
    """Greedy peak picker: take the global max, suppress a window around it, repeat.

    Returns a list of ``(frame_index, score)`` tuples ordered by descending score.
    """
    if not scores.size:
        return []
    work = scores.copy()
    peaks: List[tuple] = []
    while True:
        idx = int(np.argmax(work))
        score = float(work[idx])
        if score < threshold:
            break
        peaks.append((idx, score))
        lo = max(0, idx - suppress_frames)
        hi = min(len(work), idx + suppress_frames + 1)
        work[lo:hi] = -np.inf
        if len(peaks) >= 200:  # absolute safety cap
            break
    return peaks
