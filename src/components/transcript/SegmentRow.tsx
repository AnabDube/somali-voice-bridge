import { memo, useEffect, useRef, useState } from "react";
import { AlertTriangle, Pencil, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import SpeakerPicker from "@/components/transcript/SpeakerPicker";
import { formatTimestamp, type TranscriptSegment } from "@/lib/segments";
import { splitByMatches } from "@/lib/transcriptSearch";
import { cn } from "@/lib/utils";

interface SegmentRowProps {
  segment: TranscriptSegment;
  hours: boolean;
  /** The audio is playing this segment right now. */
  active: boolean;
  /** Roving tab stop: only one row is in the tab order at a time. */
  tabbable: boolean;
  flagged: boolean;
  pattern: RegExp | null;
  currentMatch: boolean;
  editing: boolean;
  speakers: string[];
  canSeek: boolean;
  onSeek: (segment: TranscriptSegment) => void;
  onStartEdit: (id: string) => void;
  onSave: (id: string, text: string) => void;
  onCancelEdit: () => void;
  onSpeaker: (id: string, name: string | null) => void;
  onFocusRow: (id: string) => void;
}

const SegmentRow = ({
  segment,
  hours,
  active,
  tabbable,
  flagged,
  pattern,
  currentMatch,
  editing,
  speakers,
  canSeek,
  onSeek,
  onStartEdit,
  onSave,
  onCancelEdit,
  onSpeaker,
  onFocusRow,
}: SegmentRowProps) => {
  const [draft, setDraft] = useState(segment.text);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const timestamp = formatTimestamp(segment.start_seconds, hours);
  const seekable = canSeek && segment.start_seconds !== null;
  const hasOriginal = segment.original_text !== segment.text;

  // Start each edit from the current text, with the cursor at the end.
  useEffect(() => {
    if (!editing) return;
    setDraft(segment.text);
    const area = areaRef.current;
    if (area) {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Grow the box to fit what is typed.
  useEffect(() => {
    const area = areaRef.current;
    if (editing && area) {
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight}px`;
    }
  }, [draft, editing]);

  const save = () => {
    if (draft.trim() === segment.text) onCancelEdit();
    else onSave(segment.id, draft);
  };

  const pieces = splitByMatches(segment.text, pattern);

  return (
    <div
      id={`seg-${segment.idx}`}
      role="listitem"
      data-segment-id={segment.id}
      tabIndex={tabbable ? 0 : -1}
      aria-current={active ? "true" : undefined}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusRow(segment.id);
      }}
      className={cn(
        "group grid gap-x-3 gap-y-1 rounded-lg px-3 py-2 sm:grid-cols-[7rem_minmax(0,1fr)]",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-muted/50",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-start sm:gap-1.5">
        <button
          type="button"
          disabled={!seekable}
          onClick={() => onSeek(segment)}
          aria-label={seekable ? `Play from ${timestamp}` : "No audio timing for this segment"}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            seekable ? "text-foreground hover:bg-primary/10" : "text-muted-foreground",
          )}
        >
          {seekable && <Play className="h-3 w-3 text-primary" aria-hidden="true" />}
          {timestamp || "—"}
        </button>
        <SpeakerPicker value={segment.speaker} speakers={speakers} onChange={(name) => onSpeaker(segment.id, name)} />
      </div>

      <div className="min-w-0">
        {editing ? (
          <div className="space-y-2">
            <Textarea
              ref={areaRef}
              value={draft}
              aria-label={`Edit text of the segment at ${timestamp || "this position"}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelEdit();
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  save();
                }
              }}
              className="min-h-[3.5rem] resize-none leading-relaxed"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={save}>Save</Button>
              <Button size="sm" variant="ghost" onClick={onCancelEdit}>Cancel</Button>
              {draft !== segment.original_text && (
                <Button size="sm" variant="ghost" className="gap-1" onClick={() => setDraft(segment.original_text)}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Restore model text
                </Button>
              )}
              <span className="text-xs text-muted-foreground">Ctrl+Enter to save · Esc to cancel</span>
            </div>
            {(hasOriginal || draft !== segment.original_text) && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Model’s text:</span> {segment.original_text || "—"}
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed">
              <span className={cn(flagged && "underline decoration-amber-500 decoration-dotted decoration-2 underline-offset-4")}>
                {pieces.map((p, i) =>
                  p.match ? (
                    <mark
                      key={i}
                      className={cn("rounded px-0.5 text-foreground", currentMatch ? "bg-primary/50" : "bg-yellow-200 dark:bg-yellow-500/30")}
                    >
                      {p.text}
                    </mark>
                  ) : (
                    <span key={i}>{p.text}</span>
                  ),
                )}
                {segment.text === "" && <span className="italic text-muted-foreground">(empty)</span>}
              </span>
              {flagged && <span className="sr-only"> (low confidence: check this part)</span>}
            </p>
            <button
              type="button"
              onClick={() => onStartEdit(segment.id)}
              aria-label={`Edit the segment at ${timestamp || "this position"}`}
              className={cn(
                "shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100",
              )}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {!editing && (flagged || segment.edited_at) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            {flagged && (
              <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Check this part
              </span>
            )}
            {segment.edited_at && <span className="text-muted-foreground">Edited</span>}
          </div>
        )}
      </div>
    </div>
  );
};

export default memo(SegmentRow);
