import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CollapsibleSection from '../../components/CollapsibleSection';
import LoadingSpinner from '../../components/LoadingSpinner';
import CueMarkModal from '../../components/CueMarkModal';
import {
  deleteCueTemplate,
  listCueTemplates,
  updateCueTemplate,
  type CueTemplate,
} from '../../api/cueTemplates';
import { getEpisode, getEpisodes } from '../../api/feeds';
import type { Episode } from '../../api/types';
import { formatTime } from '../../utils/adReviewHelpers';

const PICKER_PAGE_SIZE = 50;

interface Props {
  slug: string;
}

// Per-feed cue template management. Templates take precedence over the
// global spectral cue detector when at least one is enabled for the feed.
function CueTemplatesPanel({ slug }: Props) {
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openModal, setOpenModal] = useState<{ episodeId: string; episodeTitle: string; duration: number } | null>(null);

  const templatesQuery = useQuery({
    queryKey: ['cue-templates', slug],
    queryFn: () => listCueTemplates(slug),
    enabled: !!slug,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { label?: string; enabled?: boolean } }) =>
      updateCueTemplate(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cue-templates', slug] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteCueTemplate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cue-templates', slug] }),
  });

  const templates: CueTemplate[] = useMemo(
    () => templatesQuery.data ?? [],
    [templatesQuery.data],
  );

  const handleToggle = (template: CueTemplate) => {
    updateMutation.mutate({
      id: template.id,
      patch: { enabled: !template.enabled },
    });
  };

  const handleRename = (template: CueTemplate) => {
    const next = window.prompt('Rename cue', template.label);
    if (next && next.trim() && next.trim() !== template.label) {
      updateMutation.mutate({
        id: template.id,
        patch: { label: next.trim() },
      });
    }
  };

  const handleDelete = (template: CueTemplate) => {
    if (window.confirm(`Delete cue template "${template.label}"?`)) {
      deleteMutation.mutate(template.id);
    }
  };

  const handlePickEpisode = async (ep: Episode) => {
    try {
      // Trust the list-endpoint flag when present, fall back to a detail
      // fetch (older API releases or stale clients).
      let originalAvailable = ep.hasOriginalAudio;
      if (originalAvailable === undefined) {
        const detail = await getEpisode(slug, ep.id);
        originalAvailable = detail.hasOriginalAudio;
      }
      if (!originalAvailable) {
        window.alert(
          'This episode has no retained original audio. Pick a processed episode whose original audio was retained.',
        );
        return;
      }
      setPickerOpen(false);
      setOpenModal({
        episodeId: ep.id,
        episodeTitle: ep.title,
        duration: ep.duration ?? 0,
      });
    } catch (e) {
      window.alert(
        e instanceof Error ? e.message : 'Could not open this episode',
      );
    }
  };

  return (
    <div className="mb-6">
      <CollapsibleSection
        title="Audio Cue Templates"
        subtitle="User-marked ding/stinger samples. When at least one is enabled the matcher snaps ad start edges to these cues."
        defaultOpen={false}
        storageKey={`feed-cue-templates-${slug}`}
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm text-muted-foreground">
            Mark a short non-spoken cue (chime, stinger) from one episode and the
            matcher will find it on every other episode. Per-feed only.
          </p>
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 text-sm shrink-0"
            onClick={() => setPickerOpen(true)}
          >
            + Mark cue
          </button>
        </div>

        {templatesQuery.isLoading && <LoadingSpinner size="sm" className="my-2" />}
        {templatesQuery.error && (
          <p className="text-sm text-destructive">Could not load cue templates.</p>
        )}

        {!templatesQuery.isLoading && templates.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No cue templates yet. Mark one from a recent episode to start.
          </p>
        )}

        {templates.length > 0 && (
          <ul className="divide-y divide-border border rounded">
            {templates.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={t.enabled}
                  onChange={() => handleToggle(t)}
                  aria-label={`Enable cue ${t.label}`}
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{t.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {t.durationS.toFixed(2)}s · marked at {formatTime(t.sourceOffsetS)}
                    {t.sourceEpisodeId ? ` of episode ${t.sourceEpisodeId.slice(0, 8)}…` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => handleRename(t)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="text-xs text-destructive hover:text-destructive/80"
                  onClick={() => handleDelete(t)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleSection>

      {pickerOpen && (
        <EpisodePicker
          slug={slug}
          onClose={() => setPickerOpen(false)}
          onPick={handlePickEpisode}
        />
      )}

      {openModal && (
        <CueMarkModal
          podcastSlug={slug}
          episodeId={openModal.episodeId}
          episodeTitle={openModal.episodeTitle}
          episodeDuration={openModal.duration}
          onClose={() => setOpenModal(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['cue-templates', slug] });
          }}
        />
      )}
    </div>
  );
}

interface EpisodePickerProps {
  slug: string;
  onClose: () => void;
  onPick: (ep: Episode) => void;
}

function EpisodePicker({ slug, onClose, onPick }: EpisodePickerProps) {
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed'>('completed');
  const [onlyWithOriginal, setOnlyWithOriginal] = useState(true);
  const [page, setPage] = useState(0);

  const query = useQuery({
    queryKey: ['cue-template-picker', slug, statusFilter, page],
    queryFn: () =>
      getEpisodes(slug, {
        limit: PICKER_PAGE_SIZE,
        offset: page * PICKER_PAGE_SIZE,
        status: statusFilter === 'all' ? undefined : statusFilter,
        sortBy: 'published',
        sortDir: 'desc',
      }),
    enabled: !!slug,
  });

  const allEpisodes = query.data?.episodes ?? [];
  const episodes = onlyWithOriginal
    ? allEpisodes.filter((ep) => ep.hasOriginalAudio !== false)
    : allEpisodes;
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PICKER_PAGE_SIZE));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-background text-foreground rounded-lg shadow-xl w-full max-w-2xl p-5 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-base font-semibold">Pick an episode</h3>
            <p className="text-xs text-muted-foreground">
              Choose any episode that still has its original audio retained.
              Cues from any episode will apply to the whole feed.
            </p>
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
          <div className="flex items-center gap-2">
            <label htmlFor="cue-picker-filter">Show:</label>
            <select
              id="cue-picker-filter"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as 'all' | 'completed');
                setPage(0);
              }}
              className="px-2 py-1 text-sm bg-secondary border border-border rounded"
            >
              <option value="completed">Processed only</option>
              <option value="all">All episodes</option>
            </select>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={onlyWithOriginal}
              onChange={(e) => setOnlyWithOriginal(e.target.checked)}
            />
            With original audio only
          </label>
        </div>

        <div className="flex-1 overflow-y-auto border rounded">
          {query.isLoading && (
            <div className="p-4">
              <LoadingSpinner size="sm" />
            </div>
          )}
          {query.error && (
            <p className="p-3 text-sm text-destructive">
              Could not load episodes.
            </p>
          )}
          {!query.isLoading && episodes.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">
              No episodes match this filter.
            </p>
          )}
          {episodes.length > 0 && (
            <ul className="divide-y divide-border">
              {episodes.map((ep) => {
                const noOriginal = ep.hasOriginalAudio === false;
                return (
                  <li key={ep.id}>
                    <button
                      type="button"
                      onClick={() => onPick(ep)}
                      disabled={noOriginal}
                      className={`w-full text-left px-3 py-2 ${
                        noOriginal
                          ? 'opacity-50 cursor-not-allowed'
                          : 'hover:bg-muted/50'
                      }`}
                      title={noOriginal ? 'Original audio not retained for this episode' : undefined}
                    >
                      <p className="text-sm font-medium truncate">{ep.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {ep.published ? new Date(ep.published).toLocaleDateString() : 'unknown date'} ·
                        {' '}{ep.status}
                        {typeof ep.duration === 'number' && ep.duration > 0
                          ? ` · ${Math.round(ep.duration / 60)} min`
                          : ''}
                        {noOriginal ? ' · no original audio' : ''}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-3 text-sm">
            <button
              type="button"
              className="px-2 py-1 border rounded disabled:opacity-50"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              ← Prev
            </button>
            <span className="text-muted-foreground">
              Page {page + 1} / {totalPages} ({total} episodes)
            </span>
            <button
              type="button"
              className="px-2 py-1 border rounded disabled:opacity-50"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page + 1 >= totalPages}
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default CueTemplatesPanel;
