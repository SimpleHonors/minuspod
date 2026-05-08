import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import type { InboxItem } from '../api/adInbox';
import { getEpisodePeaks } from '../api/adInbox';
import { submitCorrection } from '../api/patterns';

interface Props {
  item: InboxItem;
  onClose: () => void;
  onSaveAndNext: () => void;
}

const CONTEXT_SECONDS = 120;             // initial padding before/after the ad
const WINDOW_STEP_SECONDS = 60;          // expand/shrink button granularity
const PEAK_RESOLUTION_MS = 50;
const MIN_WINDOW_PAD = 10;               // can't shrink window past this many seconds of context

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${sign}${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function AdReviewModal({ item, onClose, onSaveAndNext }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const adRegionRef = useRef<ReturnType<RegionsPlugin['addRegion']> | null>(null);

  // Window in EPISODE-coordinates. Default = ad ± CONTEXT_SECONDS.
  const [windowStart, setWindowStart] = useState(Math.max(0, item.start - CONTEXT_SECONDS));
  const [windowEnd, setWindowEnd] = useState(item.end + CONTEXT_SECONDS);

  // Ad selection in EPISODE-coordinates. Initialized from corrected bounds if any.
  const initialAd = item.correctedBounds ?? { start: item.start, end: item.end };
  const [adStart, setAdStart] = useState(initialAd.start);
  const [adEnd, setAdEnd] = useState(initialAd.end);

  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [peaksError, setPeaksError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sponsorInput, setSponsorInput] = useState(item.sponsor ?? '');
  const [showSponsorPrompt, setShowSponsorPrompt] = useState(!item.sponsor);

  const audioUrl = `/api/v1/feeds/${item.podcastSlug}/episodes/${item.episodeId}/original.mp3`;
  const windowDuration = useMemo(
    () => Math.max(0.001, windowEnd - windowStart),
    [windowStart, windowEnd],
  );

  // ------------------------------------------------------------------
  // Fetch peaks whenever window changes.
  useEffect(() => {
    let cancelled = false;
    setPeaksError(null);
    setPeaks(null);
    getEpisodePeaks(item.podcastSlug, item.episodeId, windowStart, windowEnd, PEAK_RESOLUTION_MS)
      .then((res) => {
        if (!cancelled) setPeaks(res.peaks);
      })
      .catch((e) => {
        if (!cancelled) setPeaksError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [item.podcastSlug, item.episodeId, windowStart, windowEnd]);

  // ------------------------------------------------------------------
  // Mount / re-mount wavesurfer when peaks arrive or window changes.
  useEffect(() => {
    if (!containerRef.current || !peaks) return;

    // Tear down any prior instance — peaks/duration aren't reactive on
    // wavesurfer instances, so a clean rebuild is the simplest path.
    wsRef.current?.destroy();
    wsRef.current = null;

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      peaks: [peaks],
      duration: windowDuration,
      waveColor: '#64748b',          // slate-500
      progressColor: '#22d3ee',      // cyan-400
      cursorColor: '#f59e0b',        // amber-500
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      height: 120,
      interact: true,
      plugins: [regions],
    });

    regionsRef.current = regions;
    wsRef.current = ws;

    // Initial ad region in WINDOW-coords
    const region = regions.addRegion({
      start: Math.max(0, adStart - windowStart),
      end: Math.min(windowDuration, adEnd - windowStart),
      color: 'rgba(245, 158, 11, 0.25)', // amber tint
      drag: true,
      resize: true,
    });
    adRegionRef.current = region;

    region.on('update-end', () => {
      setAdStart(windowStart + region.start);
      setAdEnd(windowStart + region.end);
    });

    // Click-to-seek on the waveform syncs the audio element.
    ws.on('interaction', (relTime: number) => {
      if (audioRef.current) {
        audioRef.current.currentTime = windowStart + relTime;
      }
    });

    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      adRegionRef.current = null;
    };
  }, [peaks, windowDuration, windowStart, adStart, adEnd]);
  // NOTE: adStart/adEnd in deps so we rebuild after the user keyboard-nudges.
  // Could be optimized but the rebuild is fast given peaks come from the cache.

  // ------------------------------------------------------------------
  // Keep wavesurfer cursor in sync with <audio> currentTime via RAF.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const audio = audioRef.current;
      const ws = wsRef.current;
      if (audio && ws) {
        const rel = audio.currentTime - windowStart;
        if (rel >= 0 && rel <= windowDuration) {
          // setTime is the v7 API for nudging the visual cursor.
          // Falls through silently if backend not ready.
          try {
            (ws as unknown as { setTime: (t: number) => void }).setTime(rel);
          } catch {
            // ignore
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [windowStart, windowDuration]);

  // ------------------------------------------------------------------
  // Audio playback handlers.
  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // If playhead is outside selection, snap to ad start for a useful preview.
      if (audio.currentTime < adStart - 1 || audio.currentTime > adEnd + 1) {
        audio.currentTime = Math.max(0, adStart - 2);
      }
      audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  };

  // ------------------------------------------------------------------
  // Window expand / shrink.
  const expandBack = () => setWindowStart((s) => Math.max(0, s - WINDOW_STEP_SECONDS));
  const expandForward = () => setWindowEnd((e) => e + WINDOW_STEP_SECONDS);
  const shrinkBack = () =>
    setWindowStart((s) => Math.min(adStart - MIN_WINDOW_PAD, s + WINDOW_STEP_SECONDS));
  const shrinkForward = () =>
    setWindowEnd((e) => Math.max(adEnd + MIN_WINDOW_PAD, e - WINDOW_STEP_SECONDS));

  // ------------------------------------------------------------------
  // Mutations
  const confirmMutation = useMutation({
    mutationFn: () =>
      submitCorrection(item.podcastSlug, item.episodeId, {
        type: 'confirm',
        original_ad: {
          start: item.start,
          end: item.end,
          pattern_id: item.patternId ?? undefined,
          confidence: item.confidence ?? undefined,
          reason: item.reason ?? undefined,
          sponsor: item.sponsor ?? undefined,
        },
        sponsor: sponsorInput.trim() || undefined,
      }),
  });

  const rejectMutation = useMutation({
    mutationFn: () =>
      submitCorrection(item.podcastSlug, item.episodeId, {
        type: 'reject',
        original_ad: {
          start: item.start,
          end: item.end,
          pattern_id: item.patternId ?? undefined,
          confidence: item.confidence ?? undefined,
          reason: item.reason ?? undefined,
          sponsor: item.sponsor ?? undefined,
        },
      }),
  });

  const adjustMutation = useMutation({
    mutationFn: () =>
      submitCorrection(item.podcastSlug, item.episodeId, {
        type: 'adjust',
        original_ad: {
          start: item.start,
          end: item.end,
          pattern_id: item.patternId ?? undefined,
          confidence: item.confidence ?? undefined,
          reason: item.reason ?? undefined,
          sponsor: item.sponsor ?? undefined,
        },
        adjusted_start: adStart,
        adjusted_end: adEnd,
        sponsor: sponsorInput.trim() || undefined,
      }),
  });

  const isBusy =
    confirmMutation.isPending || rejectMutation.isPending || adjustMutation.isPending;

  const boundariesMoved =
    Math.abs(adStart - item.start) > 0.05 || Math.abs(adEnd - item.end) > 0.05;

  const handleConfirm = async () => {
    if (boundariesMoved) {
      await adjustMutation.mutateAsync();
    } else {
      await confirmMutation.mutateAsync();
    }
    onSaveAndNext();
  };

  const handleReject = async () => {
    await rejectMutation.mutateAsync();
    onSaveAndNext();
  };

  // ------------------------------------------------------------------
  // Hotkeys
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't hijack input typing
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        if (e.key !== 'Escape') return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (e.key === ',') {
        e.preventDefault();
        expandBack();
        return;
      }
      if (e.key === '.') {
        e.preventDefault();
        expandForward();
        return;
      }
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        if (!isBusy) handleConfirm();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        if (!isBusy) handleReject();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const audio = audioRef.current;
        if (!audio) return;
        e.preventDefault();
        const delta = e.shiftKey ? 5 : 1;
        audio.currentTime += e.key === 'ArrowRight' ? delta : -delta;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isBusy, onClose, sponsorInput, adStart, adEnd, item.start, item.end]);

  // ------------------------------------------------------------------

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-card rounded-lg border border-border w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              {item.podcastTitle}
            </div>
            <h2 className="text-lg font-semibold text-foreground truncate">
              {item.episodeTitle ?? item.episodeId}
            </h2>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Stage: {item.detectionStage ?? '—'}</span>
              {item.confidence !== null && <span>Confidence: {Math.round(item.confidence * 100)}%</span>}
              {item.patternId !== null && <span>Pattern #{item.patternId}</span>}
              {item.reason && <span className="italic truncate max-w-md" title={item.reason}>{item.reason}</span>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Waveform */}
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground tabular-nums">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={expandBack}
                className="px-2 py-1 rounded border border-border hover:bg-accent"
                title="Expand window 1 min earlier ( , )"
              >
                « +1m
              </button>
              <button
                type="button"
                onClick={shrinkBack}
                disabled={windowStart >= adStart - MIN_WINDOW_PAD - WINDOW_STEP_SECONDS}
                className="px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-40"
                title="Shrink window from the left"
              >
                » −1m
              </button>
              <span className="ml-2">{formatTime(windowStart)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span>{formatTime(windowEnd)}</span>
              <button
                type="button"
                onClick={shrinkForward}
                disabled={windowEnd <= adEnd + MIN_WINDOW_PAD + WINDOW_STEP_SECONDS}
                className="ml-2 px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-40"
                title="Shrink window from the right"
              >
                « −1m
              </button>
              <button
                type="button"
                onClick={expandForward}
                className="px-2 py-1 rounded border border-border hover:bg-accent"
                title="Expand window 1 min later ( . )"
              >
                +1m »
              </button>
            </div>
          </div>

          <div className="bg-secondary/40 rounded-lg p-3 min-h-[140px] flex items-center justify-center">
            {peaksError ? (
              <p className="text-sm text-destructive">Failed to load waveform: {peaksError}</p>
            ) : !peaks ? (
              <p className="text-sm text-muted-foreground">Loading waveform…</p>
            ) : (
              <div ref={containerRef} className="w-full" />
            )}
          </div>

          {/* Boundaries readout */}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground tabular-nums">
            <span>
              Selection: <span className="text-foreground">{formatTime(adStart)}</span> –{' '}
              <span className="text-foreground">{formatTime(adEnd)}</span>{' '}
              <span className="text-xs">({Math.round(adEnd - adStart)}s)</span>
            </span>
            {boundariesMoved && (
              <span className="text-xs text-amber-500">
                (was {formatTime(item.start)} – {formatTime(item.end)})
              </span>
            )}
          </div>

          {/* Hidden audio for playback. Browser handles MP3 range/seek. */}
          <audio
            ref={audioRef}
            src={audioUrl}
            preload="metadata"
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
          />

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={togglePlay}
              className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm hover:bg-primary/90"
              title="Play / pause (Space)"
            >
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <span className="text-xs text-muted-foreground">
              Drag the amber region edges to adjust • <kbd>Space</kbd> play • <kbd>,</kbd>/<kbd>.</kbd> expand window • <kbd>C</kbd> confirm • <kbd>R</kbd> reject
            </span>
          </div>
        </div>

        {/* Sponsor prompt (shown when extractor returned empty) */}
        {showSponsorPrompt && (
          <div className="px-6 py-4 border-t border-border bg-secondary/30">
            <label htmlFor="sponsor" className="block text-sm font-medium text-foreground mb-1">
              Sponsor name
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                (so this confirmation can train Stage 2 — leave blank to skip pattern creation)
              </span>
            </label>
            <input
              id="sponsor"
              type="text"
              value={sponsorInput}
              onChange={(e) => setSponsorInput(e.target.value)}
              placeholder="e.g. BetterHelp, Squarespace, Progressive"
              className="w-full px-3 py-1.5 rounded-lg border border-input bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring text-sm"
            />
          </div>
        )}
        {!showSponsorPrompt && (
          <div className="px-6 py-2 border-t border-border text-xs text-muted-foreground">
            Sponsor: <span className="text-foreground">{item.sponsor}</span>{' '}
            <button
              type="button"
              onClick={() => setShowSponsorPrompt(true)}
              className="ml-2 underline hover:text-foreground"
            >
              edit
            </button>
          </div>
        )}

        {/* Action bar */}
        <div className="px-6 py-4 border-t border-border bg-secondary/40 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs text-muted-foreground">
            {boundariesMoved
              ? 'Confirm will save adjusted boundaries.'
              : 'Confirm will record this ad as-detected.'}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleReject}
              disabled={isBusy}
              className="px-4 py-1.5 rounded-lg bg-destructive text-destructive-foreground text-sm hover:bg-destructive/90 disabled:opacity-50"
              title="Mark as not an ad (R)"
            >
              {rejectMutation.isPending ? 'Rejecting…' : 'Reject'}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isBusy}
              className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
              title="Save & next (C)"
            >
              {confirmMutation.isPending || adjustMutation.isPending
                ? 'Saving…'
                : boundariesMoved
                  ? 'Save adjustment & next'
                  : 'Confirm & next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AdReviewModal;
