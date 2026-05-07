import CollapsibleSection from '../../components/CollapsibleSection';
import ToggleSwitch from '../../components/ToggleSwitch';

interface AudioSectionProps {
  audioBitrate: string;
  onAudioBitrateChange: (bitrate: string) => void;
  audioNormalizeEnabled: boolean;
  onAudioNormalizeEnabledChange: (enabled: boolean) => void;
  audioNormalizeIntensity: string;
  onAudioNormalizeIntensityChange: (intensity: string) => void;
}

function AudioSection({
  audioBitrate,
  onAudioBitrateChange,
  audioNormalizeEnabled,
  onAudioNormalizeEnabledChange,
  audioNormalizeIntensity,
  onAudioNormalizeIntensityChange,
}: AudioSectionProps) {
  return (
    <CollapsibleSection title="Audio">
      <div className="space-y-6">
        <div>
          <label htmlFor="audioBitrate" className="block text-sm font-medium text-foreground mb-2">
            Output Bitrate
          </label>
          <select
            id="audioBitrate"
            value={audioBitrate}
            onChange={(e) => onAudioBitrateChange(e.target.value)}
            className="w-full px-4 py-2 rounded-lg border border-input bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            <option value="64k">64 kbps - Smallest file size</option>
            <option value="96k">96 kbps - Good for speech</option>
            <option value="128k">128 kbps - Standard quality (recommended)</option>
            <option value="192k">192 kbps - High quality</option>
            <option value="256k">256 kbps - Maximum quality</option>
          </select>
          <p className="mt-1 text-sm text-muted-foreground">
            Higher bitrates produce better audio quality but larger file sizes
          </p>
        </div>

        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <ToggleSwitch
              checked={audioNormalizeEnabled}
              onChange={onAudioNormalizeEnabledChange}
              ariaLabel="Flatten Loud Ads"
            />
            <span className="text-sm font-medium text-foreground">Flatten Loud Ads / Music Inserts</span>
          </label>
          <p className="mt-2 text-sm text-muted-foreground ml-14">
            Runs a second ffmpeg pass (dynaudnorm) on the final audio to even out
            volume between quiet hosts and loud ads or music. Adds ~3-5s per episode.
          </p>
        </div>

        {audioNormalizeEnabled && (
          <div>
            <label htmlFor="audioNormalizeIntensity" className="block text-sm font-medium text-foreground mb-2">
              Normalization Intensity
            </label>
            <select
              id="audioNormalizeIntensity"
              value={audioNormalizeIntensity}
              onChange={(e) => onAudioNormalizeIntensityChange(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border border-input bg-background text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="gentle">Gentle - Light leveling, preserves dynamics</option>
              <option value="normal">Normal - Balanced flattening</option>
              <option value="aggressive">Aggressive - Strong leveling for loud ads (recommended)</option>
            </select>
            <p className="mt-1 text-sm text-muted-foreground">
              More aggressive settings flatten harder but reduce natural dynamics
            </p>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

export default AudioSection;
