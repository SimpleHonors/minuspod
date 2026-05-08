"""Server-side waveform peak generation for the Ad Inbox review modal.

Pipes the requested audio window through ffmpeg → raw 16-bit mono PCM at
8 kHz, then groups into ``resolution_ms`` chunks and emits one peak
(max absolute amplitude, normalized to [0, 1]) per chunk.

Designed for on-demand, *windowed* requests: typical ad-review window is
4-10 minutes which renders in well under a second on a 2-hour MP3, so we
don't pre-compute or cache. HTTP caching on the endpoint is enough.
"""
from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import List

import numpy as np

from utils.subprocess_registry import tracked_run

logger = logging.getLogger('podcast.peaks')

PEAKS_SAMPLE_RATE_HZ = 8000   # mono downsample target — only need amplitude
PEAKS_TIMEOUT_SECONDS = 30
MAX_PEAKS_DURATION_SECONDS = 60 * 60  # 1h cap per request — bigger windows are fetched in pieces


class PeaksError(RuntimeError):
    """Raised when ffmpeg fails or the window is invalid."""


def compute_peaks(audio_path: Path | str,
                  start_seconds: float = 0.0,
                  end_seconds: float | None = None,
                  resolution_ms: int = 50) -> List[float]:
    """Return one peak in [0, 1] per ``resolution_ms`` chunk for the window.

    Args:
        audio_path: Path to the source audio file (any format ffmpeg reads).
        start_seconds: Window start. Negative values are clamped to 0.
        end_seconds: Window end. ``None`` means "to end of file".
        resolution_ms: Width of each peak bucket in milliseconds. Lower is
            higher fidelity / larger response. 20-100ms is the useful range
            for ad-boundary work.

    Raises:
        PeaksError on ffmpeg failure, invalid window, or zero-byte output.
    """
    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise PeaksError(f"audio file not found: {audio_path}")

    if resolution_ms < 1 or resolution_ms > 1000:
        raise PeaksError(f"resolution_ms must be 1-1000, got {resolution_ms}")

    start = max(0.0, float(start_seconds))
    duration = None
    if end_seconds is not None:
        end = float(end_seconds)
        if end <= start:
            raise PeaksError(f"end ({end}) must be > start ({start})")
        duration = end - start
        if duration > MAX_PEAKS_DURATION_SECONDS:
            raise PeaksError(
                f"window {duration:.0f}s exceeds {MAX_PEAKS_DURATION_SECONDS}s cap")

    cmd = [
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', f'{start:.3f}',
        '-i', str(audio_path),
    ]
    if duration is not None:
        cmd += ['-t', f'{duration:.3f}']
    cmd += ['-ac', '1', '-ar', str(PEAKS_SAMPLE_RATE_HZ),
            '-f', 's16le', 'pipe:1']

    try:
        proc = tracked_run(cmd, capture_output=True, timeout=PEAKS_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as e:
        raise PeaksError(f"ffmpeg timed out after {PEAKS_TIMEOUT_SECONDS}s") from e

    if proc.returncode != 0:
        stderr = (proc.stderr or b'').decode('utf-8', errors='replace')[:500]
        raise PeaksError(f"ffmpeg exit {proc.returncode}: {stderr}")

    raw = proc.stdout or b''
    if not raw:
        raise PeaksError("ffmpeg produced no audio data (empty window?)")

    samples = np.frombuffer(raw, dtype='<i2')
    samples_per_bucket = max(1, int(PEAKS_SAMPLE_RATE_HZ * resolution_ms / 1000))

    n_buckets = len(samples) // samples_per_bucket
    if n_buckets == 0:
        return []

    trimmed = samples[: n_buckets * samples_per_bucket].reshape(-1, samples_per_bucket)
    # Peak amplitude per bucket, normalized to [0, 1]. int16 max abs is 32768.
    peaks = (np.abs(trimmed).max(axis=1).astype(np.float32) / 32768.0)
    return peaks.tolist()
