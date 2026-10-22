import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { TranscriptSegment } from "@/lib/segments";
import { speakersOf } from "@/lib/segments";
import { toast } from "sonner";

interface SpeakersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  segments: TranscriptSegment[];
  /** from = null renames the segments that have no speaker yet. */
  onRename: (from: string | null, to: string) => Promise<boolean>;
}

/** Rename a speaker everywhere in one action, or label all the segments that have no speaker. */
const SpeakersDialog = ({ open, onOpenChange, segments, onRename }: SpeakersDialogProps) => {
  const speakers = speakersOf(segments);
  const unassigned = segments.filter((s) => !s.speaker).length;
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setNames(Object.fromEntries(speakers.map((s) => [s, s])));
      setNewName("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = (name: string) => segments.filter((s) => s.speaker === name).length;

  const rename = async (from: string | null, to: string) => {
    setBusy(true);
    const ok = await onRename(from, to);
    setBusy(false);
    if (ok) toast.success(from === null ? `Labelled ${unassigned} segments as “${to}”.` : to ? `Renamed “${from}” to “${to}”.` : `Removed the label “${from}”.`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Speakers</DialogTitle>
          <DialogDescription>
            Renaming a speaker changes every segment they have, in one go. To label an individual segment, use the speaker
            button beside it.
          </DialogDescription>
        </DialogHeader>

        {speakers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No speakers yet. Use the “Speaker” button beside a segment to add one, or label everything at once below.
          </p>
        ) : (
          <ul className="space-y-3">
            {speakers.map((name) => {
              const value = names[name] ?? name;
              const changed = value.trim() !== name;
              return (
                <li key={name} className="flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <Label htmlFor={`speaker-${name}`} className="text-xs text-muted-foreground">
                      {name} · {count(name)} {count(name) === 1 ? "segment" : "segments"}
                    </Label>
                    <Input
                      id={`speaker-${name}`}
                      value={value}
                      onChange={(e) => setNames((prev) => ({ ...prev, [name]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && changed) rename(name, value);
                      }}
                    />
                  </div>
                  <Button size="sm" disabled={busy || !changed} onClick={() => rename(name, value)}>
                    {value.trim() ? "Rename" : "Remove label"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {unassigned > 0 && (
          <div className="space-y-1.5 border-t border-border pt-3">
            <Label htmlFor="speaker-new" className="text-xs text-muted-foreground">
              {unassigned} {unassigned === 1 ? "segment has" : "segments have"} no speaker. Label them all as:
            </Label>
            <div className="flex gap-2">
              <Input
                id="speaker-new"
                value={newName}
                placeholder="e.g. Interviewee"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) rename(null, newName);
                }}
              />
              <Button size="sm" variant="outline" disabled={busy || !newName.trim()} onClick={() => rename(null, newName)}>
                Apply
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SpeakersDialog;
