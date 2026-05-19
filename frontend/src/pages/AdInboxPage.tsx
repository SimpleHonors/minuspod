import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAdInbox,
  type InboxItem,
  type InboxStatusFilter,
} from '../api/adInbox';
import LoadingSpinner from '../components/LoadingSpinner';
import AdReviewModal, {
  type AdReviewItem,
  type AdReviewSubmit,
  type PeerAdMarker,
} from '../components/AdReviewModal';
import { submitCorrection } from '../api/patterns';

const STATUS_TABS: { id: InboxStatusFilter; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'adjusted', label: 'Adjusted' },
  { id: 'all', label: 'All' },
];

function formatTime(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(seconds);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${sign}${m}:${String(s).padStart(2, '0')}`;
}

function formatStage(stage: string | null): string {
  if (!stage) return '—';
  return stage === 'fingerprint'
    ? 'Fingerprint'
    : stage === 'text'
      ? 'Text pattern'
      : stage === 'llm'
        ? 'LLM'
        : stage;
}

function statusPillClass(status: InboxItem['status']): string {
  switch (status) {
    case 'confirmed':
      return 'bg-green-500/15 text-green-500 border-green-500/30';
    case 'rejected':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    case 'adjusted':
      return 'bg-amber-500/15 text-amber-500 border-amber-500/30';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

function itemKey(it: { podcastSlug: string; episodeId: string; adIndex: number }): string {
  return `${it.podcastSlug}:${it.episodeId}:${it.adIndex}`;
}

// Adapter: project an inbox-shaped item onto the per-episode AdEditor's
// AdReviewItem interface. Drops inbox-only metadata (title, status, etc.)
// since the modal doesn't need it.
function inboxItemToReviewItem(it: InboxItem): AdReviewItem {
  return {
    podcastSlug: it.podcastSlug,
    episodeId: it.episodeId,
    start: it.start,
    end: it.end,
    sponsor: it.sponsor,
    reason: it.reason,
    confidence: it.confidence,
    detectionStage: it.detectionStage,
    patternId: it.patternId,
    correctedBounds: it.correctedBounds,
  };
}

// Adapter: translate the modal's onSubmit intent into the
// pattern-correction API call the inbox previously made internally.
async function applySubmission(item: InboxItem, s: AdReviewSubmit): Promise<void> {
  await submitCorrection(item.podcastSlug, item.episodeId, {
    type: s.kind,
    original_ad: {
      start: item.start,
      end: item.end,
      sponsor: item.sponsor ?? undefined,
      pattern_id: item.patternId ?? undefined,
    },
    adjusted_start: s.adjustedStart,
    adjusted_end: s.adjustedEnd,
    sponsor: s.sponsor,
  });
}

const PAGE_SIZE = 50;
// Max parallel POSTs when applying a bulk action. Five strikes a
// balance: a 50-item confirm finishes in ~500ms instead of 2.5s,
// without overwhelming gunicorn's worker pool while it's also
// servicing the queue processor's writes.
const BULK_CONCURRENCY = 5;

type BulkAction = 'confirm' | 'reject' | 'skip';

// Group items by episode and surface time-range overlaps. Two ads
// "touch" when their [start, end] ranges intersect at all -- intentionally
// looser than the backend's 50% overlap rule, because for a *triage hint*
// we want to flag anything worth a second look. Used by the inbox row to
// show an overlap badge so the user can decide between case-A (distinct
// back-to-back ads, confirm individually) vs case-B (same ad detected
// twice with different bounds, confirm one + reject the other).
function computeOverlapPeers(items: InboxItem[]): Map<string, InboxItem[]> {
  const byEpisode = new Map<string, InboxItem[]>();
  for (const it of items) {
    const list = byEpisode.get(it.episodeId);
    if (list) list.push(it);
    else byEpisode.set(it.episodeId, [it]);
  }
  const out = new Map<string, InboxItem[]>();
  for (const list of byEpisode.values()) {
    if (list.length < 2) continue;
    for (const a of list) {
      const peers = list.filter(
        (b) => b !== a && b.start < a.end && a.start < b.end,
      );
      if (peers.length > 0) out.set(itemKey(a), peers);
    }
  }
  return out;
}

function AdInboxPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<InboxStatusFilter>('pending');
  const [page, setPage] = useState(0);
  // Podcast filter: null means "all podcasts". Cleared whenever the
  // status tab changes so the user doesn't end up on (status=adjusted,
  // podcast=X) and see zero results because X has no adjusted ads.
  const [podcastSlug, setPodcastSlug] = useState<string | null>(null);
  // Reset to page 0 whenever the status filter changes. Also clears
  // bulk selection so we never carry stale row IDs across views.
  const setStatusAndResetPage = (s: InboxStatusFilter) => {
    setStatus(s);
    setPage(0);
    setPodcastSlug(null);
    setSelected(new Set());
  };
  const setPodcastAndResetPage = (slug: string | null) => {
    setPodcastSlug(slug);
    setPage(0);
    setSelected(new Set());
  };
  const setPageAndResetSelection = (p: number) => {
    setPage(p);
    setSelected(new Set());
  };
  // Track the active item by identity (not index). Index-based tracking
  // gets out of sync after refetch when the just-actioned item drops out
  // of the pending list — using the item itself + a `key` prop on the
  // modal guarantees a clean remount per item with fresh state.
  const [activeItem, setActiveItem] = useState<InboxItem | null>(null);
  // Session-only skip set: keeps the user from being bounced back to
  // ads they explicitly skipped during this triage pass. Cleared on
  // page reload, so DB stays the source of truth.
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [showSkipped, setShowSkipped] = useState(false);
  // Bulk-action selection state. Keyed by itemKey() for stability across
  // refetches. Cleared whenever the visible item set changes underneath
  // (status tab, podcast filter, page) so stale selections don't carry.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingBulk, setPendingBulk] = useState<BulkAction | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['ad-inbox', status, page, podcastSlug],
    queryFn: () => getAdInbox(status, PAGE_SIZE, page * PAGE_SIZE, podcastSlug),
    staleTime: 5_000,
  });

  const allItems = data?.items ?? [];
  // An ad is "contained" when an episodePeer with status confirmed or
  // adjusted (i.e. one you've already endorsed) fully encloses its
  // time range. These are almost always redundant LLM re-detections
  // of the same already-known ad, so we hide them from the pending
  // list by default. Show-contained toggle below lets the user audit
  // if needed. Only applies to status='pending' items -- the confirmed,
  // rejected, etc. tabs always render the full set.
  const isContainedByEndorsedPeer = (it: InboxItem): boolean => {
    if (it.status !== 'pending') return false;
    const peers = it.episodePeers;
    if (!peers || peers.length === 0) return false;
    return peers.some(
      (p) => (p.status === 'confirmed' || p.status === 'adjusted')
        && p.start <= it.start && p.end >= it.end,
    );
  };
  const [showContained, setShowContained] = useState(false);
  const containedCount = allItems.filter(isContainedByEndorsedPeer).length;

  const afterSkippedFilter = showSkipped
    ? allItems
    : allItems.filter((it) => !skipped.has(itemKey(it)));
  const items = showContained
    ? afterSkippedFilter
    : afterSkippedFilter.filter((it) => !isContainedByEndorsedPeer(it));
  // Existing skippedCount semantic: how many session-skipped rows are
  // hidden right now. Used by the existing "Show skipped" toggle copy.
  const skippedCount = showSkipped ? 0 : (allItems.length - afterSkippedFilter.length);
  const hiddenAsContainedCount = showContained ? 0 : (afterSkippedFilter.length - items.length);
  const counts = data?.counts;
  // Compute overlap peers from the full loaded set (not just visible)
  // so even hidden skipped items are considered when judging overlap.
  const overlapPeers = useMemo(() => computeOverlapPeers(allItems), [allItems]);

  const closeModal = () => setActiveItem(null);

  const handleSaveAndNext = () => {
    if (!activeItem) {
      queryClient.invalidateQueries({ queryKey: ['ad-inbox'] });
      return;
    }
    // Pick the next item from the *current* list (the actioned item is
    // still in here until the refetch completes), then trigger refetch.
    const idx = items.findIndex(
      (i) =>
        i.podcastSlug === activeItem.podcastSlug &&
        i.episodeId === activeItem.episodeId &&
        i.adIndex === activeItem.adIndex,
    );
    const next = idx >= 0 && idx + 1 < items.length ? items[idx + 1] : null;
    setActiveItem(next);
    queryClient.invalidateQueries({ queryKey: ['ad-inbox'] });
  };

  const handleSkip = () => {
    if (!activeItem) return;
    const key = itemKey(activeItem);
    // Mark skipped first, then advance using the remaining queue. The
    // current activeItem is filtered OUT of the next list, so we want
    // the item that follows it in the original list.
    setSkipped((s) => {
      const next = new Set(s);
      next.add(key);
      return next;
    });
    const idx = items.findIndex(
      (i) =>
        i.podcastSlug === activeItem.podcastSlug &&
        i.episodeId === activeItem.episodeId &&
        i.adIndex === activeItem.adIndex,
    );
    const next = idx >= 0 && idx + 1 < items.length ? items[idx + 1] : null;
    setActiveItem(next);
  };

  // ----- Bulk-action helpers ----------------------------------------

  const toggleSelected = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Select-all-visible toggle: when ANY visible row is unselected, this
  // selects all of them; otherwise it clears the selection. Matches the
  // common tri-state-header inbox pattern (Gmail/GitHub/etc.).
  const visibleKeys = items.map(itemKey);
  const allVisibleSelected = visibleKeys.length > 0
    && visibleKeys.every((k) => selected.has(k));
  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const k of visibleKeys) next.delete(k);
        return next;
      }
      const next = new Set(prev);
      for (const k of visibleKeys) next.add(k);
      return next;
    });
  };

  const selectedItems = items.filter((it) => selected.has(itemKey(it)));

  // Apply the chosen bulk action with bounded concurrency. confirm/reject
  // POST per item; skip just adds to the session skip set (no API call).
  const applyBulk = async (action: BulkAction) => {
    if (selectedItems.length === 0) return;

    if (action === 'skip') {
      setSkipped((s) => {
        const next = new Set(s);
        for (const it of selectedItems) next.add(itemKey(it));
        return next;
      });
      setSelected(new Set());
      return;
    }

    const submit: AdReviewSubmit =
      action === 'confirm' ? { kind: 'confirm' } : { kind: 'reject' };

    setBulkProgress({ done: 0, total: selectedItems.length });
    let done = 0;
    const queue = [...selectedItems];
    const workers = Array.from({ length: BULK_CONCURRENCY }, async () => {
      while (queue.length) {
        const it = queue.shift();
        if (!it) break;
        try {
          await applySubmission(it, submit);
        } catch (e) {
          // Don't abort the batch on a single failure; surface it via
          // the dev console for now. A toast/error-list would be a
          // worthwhile follow-up if you start seeing partial-failures.
          console.error('bulk action failed for', itemKey(it), e);
        }
        done += 1;
        setBulkProgress({ done, total: selectedItems.length });
      }
    });
    await Promise.all(workers);
    setBulkProgress(null);
    setSelected(new Set());
    queryClient.invalidateQueries({ queryKey: ['ad-inbox'] });
    queryClient.invalidateQueries({ queryKey: ['inbox-pending-count'] });
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Ad Inbox</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Review every detected ad. Confirm, reject, or adjust the boundaries — your decisions train the pattern matcher.
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_TABS.map((tab) => {
          const isActive = status === tab.id;
          const count =
            tab.id === 'all'
              ? (counts ? counts.pending + counts.confirmed + counts.rejected + counts.adjusted : null)
              : (counts?.[tab.id] ?? null);
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatusAndResetPage(tab.id)}
              className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${
                isActive
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card text-foreground border-border hover:bg-accent'
              }`}
            >
              {tab.label}
              {count !== null && (
                <span
                  className={`ml-2 inline-flex items-center justify-center rounded-full px-2 text-xs ${
                    isActive ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
        {(skipped.size > 0 || showSkipped) && (
          <button
            type="button"
            onClick={() => setShowSkipped((v) => !v)}
            className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ml-2 ${
              showSkipped
                ? 'bg-amber-500/15 text-amber-500 border-amber-500/30'
                : 'bg-card text-muted-foreground border-border hover:bg-accent'
            }`}
            title={
              showSkipped
                ? 'Hide ads you skipped this session'
                : 'Show ads you skipped this session (still in the inbox)'
            }
          >
            {showSkipped ? 'Hide skipped' : `Show skipped (${skipped.size})`}
          </button>
        )}

        {/* Podcast filter: only render when there's >1 podcast with items
            under the current status tab (otherwise the dropdown is just
            "All" + a single podcast = pointless UI). */}
        {data && data.podcastsWithMatches.length > 1 && (
          <select
            className="ml-auto px-3 py-1.5 rounded-lg border border-border bg-card text-foreground text-sm hover:bg-accent transition-colors"
            value={podcastSlug ?? ''}
            onChange={(e) => setPodcastAndResetPage(e.target.value || null)}
            aria-label="Filter by podcast"
          >
            <option value="">All podcasts ({data.podcastsWithMatches.length})</option>
            {data.podcastsWithMatches.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.title}
              </option>
            ))}
          </select>
        )}
        {skipped.size > 0 && (
          <button
            type="button"
            onClick={() => setSkipped(new Set())}
            className="px-3 py-1.5 rounded-lg border text-sm text-muted-foreground border-border bg-card hover:bg-accent transition-colors"
            title="Clear the session skip list"
          >
            Clear skip list
          </button>
        )}
      </div>

      {skippedCount > 0 && !showSkipped && (
        <p className="mb-3 text-xs text-muted-foreground">
          {skippedCount} skipped this session — still pending in the inbox.
        </p>
      )}

      {(hiddenAsContainedCount > 0 || (showContained && containedCount > 0)) && (
        <div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground bg-secondary/40 border border-border rounded-md px-3 py-2">
          <span>
            {showContained
              ? `${containedCount} contained — these pending ads fall entirely inside a confirmed/adjusted ad on the same episode.`
              : `${hiddenAsContainedCount} hidden as contained — pending detections that fall entirely inside a confirmed/adjusted ad on the same episode (very likely duplicates).`}
          </span>
          <button
            type="button"
            onClick={() => setShowContained((v) => !v)}
            className="px-2 py-1 rounded border border-border bg-card text-foreground hover:bg-accent transition-colors whitespace-nowrap"
          >
            {showContained ? 'Hide contained' : 'Show contained'}
          </button>
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner className="py-12" />
      ) : error ? (
        <div className="text-center py-12 bg-card rounded-lg border border-border">
          <p className="text-destructive">Failed to load inbox: {error instanceof Error ? error.message : String(error)}</p>
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 bg-card rounded-lg border border-border">
          <p className="text-muted-foreground">No ads in this view.</p>
        </div>
      ) : (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    aria-label="Select all visible"
                    className="cursor-pointer"
                  />
                </th>
                <th className="text-left px-4 py-2">Podcast / Episode</th>
                <th className="text-left px-4 py-2">Sponsor</th>
                <th className="text-left px-4 py-2">When</th>
                <th className="text-left px-4 py-2">Length</th>
                <th className="text-left px-4 py-2">Stage</th>
                <th className="text-left px-4 py-2">Confidence</th>
                <th className="text-left px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const key = `${it.podcastSlug}:${it.episodeId}:${it.adIndex}`;
                const isSelected = selected.has(key);
                return (
                <tr
                  key={key}
                  onClick={() => setActiveItem(it)}
                  className={`border-t border-border cursor-pointer transition-colors ${
                    isSelected ? 'bg-accent/60' : 'hover:bg-accent'
                  }`}
                >
                  <td
                    className="px-3 py-2 w-8"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelected(key)}
                      aria-label={`Select ${it.episodeTitle ?? it.episodeId}`}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <div className="font-medium text-foreground truncate max-w-md">
                      {it.podcastTitle}
                    </div>
                    <div className="text-xs text-muted-foreground truncate max-w-md">
                      {it.episodeTitle ?? it.episodeId}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-foreground">
                    <div className="flex items-center gap-2">
                      <span>
                        {it.sponsor ?? <span className="text-muted-foreground italic">unknown</span>}
                      </span>
                      {(() => {
                        const peers = overlapPeers.get(key);
                        if (!peers || peers.length === 0) return null;
                        const tooltip = peers
                          .map((p) => `${p.sponsor ?? 'unknown'} (${formatTime(p.start)}–${formatTime(p.end)})`)
                          .join('\n');
                        return (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 cursor-help whitespace-nowrap"
                            title={`Overlaps with ${peers.length} other ad${peers.length === 1 ? '' : 's'} on this episode:\n${tooltip}`}
                          >
                            ↔ {peers.length} overlap{peers.length === 1 ? '' : 's'}
                          </span>
                        );
                      })()}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground tabular-nums">
                    {formatTime(it.start)} – {formatTime(it.end)}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground tabular-nums">
                    {Math.round(it.duration)}s
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{formatStage(it.detectionStage)}</td>
                  <td className="px-4 py-2 text-muted-foreground tabular-nums">
                    {it.confidence !== null ? `${Math.round(it.confidence * 100)}%` : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${statusPillClass(it.status)}`}>
                      {it.status}
                    </span>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {data && data.total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between gap-3 flex-wrap text-sm">
          <div className="text-muted-foreground tabular-nums">
            Showing {page * PAGE_SIZE + 1}–
            {Math.min(data.total, page * PAGE_SIZE + items.length)} of{' '}
            <span className="text-foreground font-medium">{data.total}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPageAndResetSelection(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 rounded-lg border border-border bg-card text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              ← Prev
            </button>
            <span className="text-muted-foreground tabular-nums">
              Page {page + 1} of {Math.max(1, Math.ceil(data.total / PAGE_SIZE))}
            </span>
            <button
              type="button"
              onClick={() => setPageAndResetSelection(page + 1)}
              disabled={(page + 1) * PAGE_SIZE >= data.total}
              className="px-3 py-1.5 rounded-lg border border-border bg-card text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {activeItem && (
        <AdReviewModal
          key={itemKey(activeItem)}
          item={inboxItemToReviewItem(activeItem)}
          episodeDuration={activeItem.originalDuration ?? undefined}
          peerAds={
            activeItem.episodePeers?.map<PeerAdMarker>((p) => ({
              adIndex: p.adIndex,
              start: p.start,
              end: p.end,
              sponsor: p.sponsor,
              status: p.status,
            }))
          }
          onClose={closeModal}
          onSubmit={async (s) => {
            await applySubmission(activeItem, s);
            handleSaveAndNext();
          }}
          onSkip={handleSkip}
          hasNext={items.length > 1}
        />
      )}

      {/* Sticky bulk-action bar: pinned to bottom of viewport when any
          item is selected. Disappears as soon as selection is empty. */}
      {selected.size > 0 && (
        <div
          className="fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-card shadow-2xl"
          role="region"
          aria-label="Bulk actions"
        >
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="text-sm">
              <span className="font-medium text-foreground">{selected.size}</span>
              <span className="text-muted-foreground"> selected</span>
              {bulkProgress && (
                <span className="ml-3 text-xs text-muted-foreground">
                  Applying… {bulkProgress.done} / {bulkProgress.total}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                disabled={!!bulkProgress}
                className="px-3 py-1.5 rounded-lg border border-border bg-card text-foreground hover:bg-accent disabled:opacity-40 transition-colors text-sm"
              >
                Deselect
              </button>
              <button
                type="button"
                onClick={() => setPendingBulk('skip')}
                disabled={!!bulkProgress}
                className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 disabled:opacity-40 transition-colors text-sm"
              >
                Skip {selected.size}
              </button>
              <button
                type="button"
                onClick={() => setPendingBulk('reject')}
                disabled={!!bulkProgress}
                className="px-3 py-1.5 rounded-lg border border-red-500/40 bg-red-500/10 text-red-500 hover:bg-red-500/20 disabled:opacity-40 transition-colors text-sm"
              >
                Reject {selected.size}
              </button>
              <button
                type="button"
                onClick={() => setPendingBulk('confirm')}
                disabled={!!bulkProgress}
                className="px-3 py-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors text-sm font-medium"
              >
                Confirm {selected.size}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation dialog. Blocks misfires from a missed click on
          the action bar. */}
      {pendingBulk && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm bulk action"
          onClick={() => setPendingBulk(null)}
        >
          <div
            className="bg-card border border-border rounded-lg shadow-2xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-foreground mb-2">
              Apply <span className="font-bold">{pendingBulk}</span> to {selected.size} {selected.size === 1 ? 'item' : 'items'}?
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {pendingBulk === 'confirm' && 'Each ad will be marked as a confirmed correction, adding it to the pattern matcher.'}
              {pendingBulk === 'reject' && 'Each ad will be marked as a false positive. The pattern matcher will learn to avoid similar boundaries.'}
              {pendingBulk === 'skip' && 'Items will be hidden from this session only (no DB write). Reload to see them again.'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingBulk(null)}
                className="px-4 py-2 rounded-lg border border-border bg-card text-foreground hover:bg-accent transition-colors text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const action = pendingBulk;
                  setPendingBulk(null);
                  await applyBulk(action);
                }}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity text-sm font-medium"
              >
                {pendingBulk === 'confirm' && 'Confirm all'}
                {pendingBulk === 'reject' && 'Reject all'}
                {pendingBulk === 'skip' && 'Skip all'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdInboxPage;
