import CollapsibleSection from '../../components/CollapsibleSection';
import ToggleSwitch from '../../components/ToggleSwitch';

interface GlobalDefaultsSectionProps {
  autoProcessEnabled: boolean;
  onAutoProcessEnabledChange: (enabled: boolean) => void;
  maxFeedEpisodes: number;
  onMaxFeedEpisodesChange: (n: number) => void;
  combinedFeedEpisodeLimit: number;
  onCombinedFeedEpisodeLimitChange: (n: number) => void;
  onlyExposeProcessedDefault: boolean;
  onOnlyExposeProcessedDefaultChange: (enabled: boolean) => void;
}

function GlobalDefaultsSection({
  autoProcessEnabled,
  onAutoProcessEnabledChange,
  maxFeedEpisodes,
  onMaxFeedEpisodesChange,
  combinedFeedEpisodeLimit,
  onCombinedFeedEpisodeLimitChange,
  onlyExposeProcessedDefault,
  onOnlyExposeProcessedDefaultChange,
}: GlobalDefaultsSectionProps) {
  const combinedFeedUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/all` : '/all';

  const handleCopyCombinedUrl = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(combinedFeedUrl).catch(() => {
        /* clipboard may be unavailable on insecure origins; ignore */
      });
    }
  };
  return (
    <CollapsibleSection
      title="Global Defaults"
      subtitle="Applied to every feed unless overridden on the feed's own settings."
    >
      <div className="space-y-6">
        {/* Auto-process new episodes */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <ToggleSwitch
              checked={autoProcessEnabled}
              onChange={onAutoProcessEnabledChange}
              ariaLabel="Auto-process new episodes"
            />
            <span className="text-sm font-medium text-foreground">
              Auto-process new episodes
            </span>
          </label>
          <p className="mt-2 text-sm text-muted-foreground">
            When a feed refresh discovers a new episode, queue it for processing automatically. Per-feed Auto-Process can override this.
          </p>
        </div>

        {/* Max feed episodes */}
        <div className="pt-4 border-t border-border">
          <label
            htmlFor="maxFeedEpisodesGlobal"
            className="block text-sm font-medium text-foreground mb-2"
          >
            Max episodes per served feed
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              id="maxFeedEpisodesGlobal"
              value={maxFeedEpisodes}
              onChange={(e) =>
                onMaxFeedEpisodesChange(parseInt(e.target.value, 10) || 0)
              }
              min={10}
              max={500}
              className="w-24 px-3 py-1.5 rounded-lg border border-input bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            <span className="text-sm text-muted-foreground">episodes (10-500)</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Caps how many recent episodes appear in each podcast's served RSS feed. Per-feed Max Episodes can override this.
          </p>
        </div>

        {/* Combined feed (/all) episode limit + subscribe URL */}
        <div className="pt-4 border-t border-border">
          <label
            htmlFor="combinedFeedEpisodeLimit"
            className="block text-sm font-medium text-foreground mb-2"
          >
            Combined feed (/all) episode limit
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              id="combinedFeedEpisodeLimit"
              value={combinedFeedEpisodeLimit}
              onChange={(e) =>
                onCombinedFeedEpisodeLimitChange(parseInt(e.target.value, 10) || 0)
              }
              min={1}
              max={500}
              className="w-24 px-3 py-1.5 rounded-lg border border-input bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            <span className="text-sm text-muted-foreground">episodes (1-500)</span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Number of most-recent processed episodes to include in the unified <code>/all</code> feed (newest first, across every podcast). The combined feed only ever exposes processed episodes.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={combinedFeedUrl}
              className="flex-1 px-3 py-1.5 rounded-lg border border-input bg-muted text-muted-foreground text-sm font-mono focus:outline-hidden"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              onClick={handleCopyCombinedUrl}
              className="px-3 py-1.5 rounded-lg border border-input bg-background text-foreground text-sm hover:bg-muted focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              Copy Feed URL
            </button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Subscribe to this single URL in your podcast app to get every cleaned episode from every show in MinusPod.
          </p>
        </div>

        {/* Only expose processed episodes */}
        <div className="pt-4 border-t border-border">
          <label className="flex items-center gap-3 cursor-pointer">
            <ToggleSwitch
              checked={onlyExposeProcessedDefault}
              onChange={onOnlyExposeProcessedDefaultChange}
              ariaLabel="Only expose processed episodes in feed"
            />
            <span className="text-sm font-medium text-foreground">
              Only expose processed episodes in feed
            </span>
          </label>
          <p className="mt-2 text-sm text-muted-foreground">
            Hides upstream episodes that haven't finished processing from served RSS feeds, so podcast apps don't auto-download an episode that would 503. Per-feed override is available on each feed's settings.
          </p>
        </div>
      </div>
    </CollapsibleSection>
  );
}

export default GlobalDefaultsSection;
