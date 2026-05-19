import { useQuery } from '@tanstack/react-query';
import { getAdInbox } from '../api/adInbox';

// Lightweight hook that surfaces the number of pending Ad Inbox items
// for nav-badge display. Uses limit=1 so the payload is just metadata
// (we only read `counts.pending`, never the items themselves).
//
// 60s poll + refetch on window focus is a good middle ground for a
// homelab single-user app: live enough that the badge feels responsive
// when ads land, but doesn't hammer the API.
export function useInboxPendingCount(): number {
  const { data } = useQuery({
    queryKey: ['inbox-pending-count'],
    queryFn: () => getAdInbox('pending', 1, 0),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  return data?.counts?.pending ?? 0;
}
