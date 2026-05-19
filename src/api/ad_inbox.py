"""Ad Inbox routes — thin HTTP layer around ``ad_inbox_service``."""
import logging

from flask import request

from api import api, log_request, json_response, error_response, get_database
from ad_inbox_service import (
    enumerate_inbox_items,
    VALID_INBOX_STATUSES,
)

logger = logging.getLogger('podcast.api')


@api.route('/ad-inbox', methods=['GET'])
@log_request
def get_ad_inbox():
    """Return the Ad Inbox queue with status filter + pagination.

    Query params:
        status         pending|confirmed|rejected|adjusted|all (default 'pending')
        podcast_slug   optional slug to scope results to a single podcast
        limit          1-200                                    (default 50)
        offset         ≥0                                       (default 0)

    Response also includes ``podcastsWithMatches`` -- the distinct list of
    podcasts (slug + title) that have at least one item under the current
    *status* filter (before the podcast_slug filter is applied). The UI
    uses this to populate the podcast-filter dropdown without showing
    dead-end selections.
    """
    db = get_database()

    status_filter = (request.args.get('status') or 'pending').lower()
    if status_filter not in VALID_INBOX_STATUSES:
        return error_response(
            f"status must be one of: {', '.join(sorted(VALID_INBOX_STATUSES))}",
            400)

    podcast_slug_filter = (request.args.get('podcast_slug') or '').strip().lower() or None

    try:
        limit = int(request.args.get('limit', '50'))
    except ValueError:
        return error_response('limit must be an integer', 400)
    limit = max(1, min(limit, 200))

    try:
        offset = int(request.args.get('offset', '0'))
    except ValueError:
        return error_response('offset must be an integer', 400)
    offset = max(0, offset)

    counts = {'pending': 0, 'confirmed': 0, 'rejected': 0, 'adjusted': 0}
    matched_by_status: list[dict] = []
    # Title-keyed-by-slug so the dropdown is stable when multiple episodes
    # share a podcast (which they always do).
    podcasts_with_matches: dict[str, str] = {}
    for item in enumerate_inbox_items(db):
        counts[item['status']] = counts.get(item['status'], 0) + 1
        if status_filter == 'all' or item['status'] == status_filter:
            matched_by_status.append(item)
            podcasts_with_matches[item['podcastSlug']] = item['podcastTitle']

    # Apply the podcast filter ON TOP of the status filter. We compute
    # podcastsWithMatches *before* this step so the dropdown always shows
    # every podcast with items under the current status -- not just the
    # one currently selected (which would collapse the dropdown to 1).
    if podcast_slug_filter:
        matched = [i for i in matched_by_status
                   if i['podcastSlug'].lower() == podcast_slug_filter]
    else:
        matched = matched_by_status

    total = len(matched)
    page = matched[offset:offset + limit]

    return json_response({
        'items': page,
        'total': total,
        'limit': limit,
        'offset': offset,
        'status': status_filter,
        'podcastSlug': podcast_slug_filter,
        'counts': counts,
        'podcastsWithMatches': sorted(
            [{'slug': s, 'title': t} for s, t in podcasts_with_matches.items()],
            key=lambda p: (p['title'] or '').lower(),
        ),
    })
