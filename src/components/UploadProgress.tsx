import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { isCancellable, type UploadPhase } from "@/lib/uploadRecording";

interface Description {
  title: string;
  /** 0 to 100, or null when there is nothing to measure. */
  percent: number | null;
  hint: string | null;
}

const describe = (phase: UploadPhase | null): Description => {
  if (!phase) return { title: "Uploading audio…", percent: null, hint: "Please wait while your file is being saved." };
  switch (phase.kind) {
    case "tools":
      return {
        title: "Getting the audio tools ready",
        percent: phase.percent,
        hint: "A one-time download of about 30 MB. It is saved for next time.",
      };
    case "analysing":
      return { title: "Analysing the recording", percent: phase.percent, hint: "Finding the quiet pauses so parts are cut cleanly." };
    case "converting":
      return {
        title: "Preparing the audio",
        percent: phase.percent,
        hint: "Long recordings can take a few minutes to prepare, and longer on a phone. Keep this page open.",
      };
    case "uploading":
      return phase.total > 1
        ? {
            title: `Uploading part ${phase.part} of ${phase.total}`,
            percent: ((phase.part - 1) / phase.total) * 100,
            hint: "Keep this page open until every part is uploaded. Transcription then continues on our servers.",
          }
        : { title: "Uploading audio…", percent: null, hint: "Please wait while your file is being saved." };
    case "starting":
      return { title: "Starting transcription…", percent: null, hint: null };
    case "playback":
      return {
        title: "Saving a playable copy of the audio…",
        percent: null,
        hint: "Your transcript is already being made on our servers. You can leave this page.",
      };
  }
};

interface UploadProgressProps {
  phase: UploadPhase | null;
  onCancel?: () => void;
}

const UploadProgress = ({ phase, onCancel }: UploadProgressProps) => {
  const { title, percent, hint } = describe(phase);
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4 text-center" role="status" aria-live="polite">
      <Loader2 className="h-12 w-12 animate-spin text-primary" aria-hidden="true" />
      <p className="font-display text-lg font-semibold">{title}</p>
      {percent !== null && (
        <div className="w-full">
          <Progress value={percent} aria-label={title} />
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">{Math.round(percent)}%</p>
        </div>
      )}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      {onCancel && isCancellable(phase) && (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onCancel}>
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
      )}
    </div>
  );
};

export default UploadProgress;
