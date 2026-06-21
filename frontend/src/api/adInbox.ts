import { apiRequest, buildQueryString } from './client';

export type InboxStatus = 'pending' | 'confirmed' | 'rejected' | 'adjusted';
export type InboxStatusFilter = InboxStatus | 'all';

// Lightweight peer descriptor: other ads on the same episode, regardless
// of status. Used by the modal to render overlay markers showing where
// already-actioned ads sit, and by the list view to hide pending ads
// that fall fully inside a confirmed/adjusted peer's bounds.
export interface InboxItemPeer {
  adIndex: number;
  start: number;
  end: number;
  sponsor: string | null;
  status: InboxStatus;
}

export interface InboxItem {
  podcastSlug: string;
  podcastTitle: string;
  episodeId: string;
  episodeTitle: string | null;
  publishedAt: string | null;
  processedVersion: number | null;
  originalDuration: number | null;
  adIndex: number;
  start: number;
  end: number;
  duration: number;
  sponsor: string | null;
  reason: string | null;
  confidence: number | null;
  detectionStage: string | null;
  patternId: number | null;
  status: InboxStatus;
  correctedBounds: { start: number; end: number } | null;
  // Other ads on the same episode (any status). Omitted by the backend
  // when no peers exist, so check truthiness before iterating.
  episodePeers?: InboxItemPeer[];
}

export interface InboxResponse {
  items: InboxItem[];
  total: number;
  limit: number;
  offset: number;
  status: InboxStatusFilter;
  podcastSlug: string | null;
  counts: {
    pending: number;
    confirmed: number;
    rejected: number;
    adjusted: number;
  };
  podcastsWithMatches: { slug: string; title: string }[];
}

export async function getAdInbox(
  status: InboxStatusFilter = 'pending',
  limit = 50,
  offset = 0,
  podcastSlug: string | null = null,
): Promise<InboxResponse> {
  // buildQueryString already returns the leading "?" (or "" when empty).
  // Omit podcast_slug when null/empty so the backend doesn't see a literal
  // "null" string -- the slug filter is case-folded server-side.
  const params: Record<string, string | number> = { status, limit, offset };
  if (podcastSlug) params.podcast_slug = podcastSlug;
  const qs = buildQueryString(params);
  return apiRequest<InboxResponse>(`/ad-inbox${qs}`);
}

export interface PeaksResponse {
  episodeId: string;
  start: number;
  end: number | null;
  resolutionMs: number;
  peaks: number[];
}

export async function getEpisodePeaks(
  slug: string,
  episodeId: string,
  start: number,
  end: number,
  resolutionMs = 50,
): Promise<PeaksResponse> {
  const qs = buildQueryString({ start, end, resolution_ms: resolutionMs });
  return apiRequest<PeaksResponse>(
    `/feeds/${slug}/episodes/${episodeId}/peaks${qs}`,
  );
}
