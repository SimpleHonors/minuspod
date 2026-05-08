import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAdInbox,
  type InboxItem,
  type InboxStatusFilter,
} from '../api/adInbox';
import LoadingSpinner from '../components/LoadingSpinner';
import AdReviewModal from '../components/AdReviewModal';

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

function AdInboxPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<InboxStatusFilter>('pending');
  // Track the active item by identity (not index). Index-based tracking
  // gets out of sync after refetch when the just-actioned item drops out
  // of the pending list — using the item itself + a `key` prop on the
  // modal guarantees a clean remount per item with fresh state.
  const [activeItem, setActiveItem] = useState<InboxItem | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['ad-inbox', status],
    queryFn: () => getAdInbox(status, 100, 0),
    staleTime: 5_000,
  });

  const items = data?.items ?? [];
  const counts = data?.counts;

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
              onClick={() => setStatus(tab.id)}
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
      </div>

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
              {items.map((it) => (
                <tr
                  key={`${it.podcastSlug}:${it.episodeId}:${it.adIndex}`}
                  onClick={() => setActiveItem(it)}
                  className="border-t border-border cursor-pointer hover:bg-accent transition-colors"
                >
                  <td className="px-4 py-2">
                    <div className="font-medium text-foreground truncate max-w-md">
                      {it.podcastTitle}
                    </div>
                    <div className="text-xs text-muted-foreground truncate max-w-md">
                      {it.episodeTitle ?? it.episodeId}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-foreground">{it.sponsor ?? <span className="text-muted-foreground italic">unknown</span>}</td>
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeItem && (
        <AdReviewModal
          key={`${activeItem.podcastSlug}:${activeItem.episodeId}:${activeItem.adIndex}`}
          item={activeItem}
          onClose={closeModal}
          onSaveAndNext={handleSaveAndNext}
        />
      )}
    </div>
  );
}

export default AdInboxPage;
