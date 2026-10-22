import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatTimestamp, type TranscriptSegment } from "@/lib/segments";
import {
  buildPattern,
  planReplace,
  planReplaceAll,
  splitByMatches,
  type SearchOptions,
  type TextUpdate,
} from "@/lib/transcriptSearch";
import type { GlossaryEntry } from "@/hooks/useGlossary";
import { toast } from "sonner";

interface FindReplaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  segments: TranscriptSegment[];
  /** What to look for when the dialog opens (the current search). */
  initialFind: string;
  initialOptions: SearchOptions;
  glossary: { entries: GlossaryEntry[]; remember: (find: string, replace: string) => Promise<void>; forget: (id: string) => Promise<void> };
  onApply: (updates: TextUpdate[]) => Promise<boolean>;
}

const PREVIEW_LIMIT = 5;

const FindReplaceDialog = ({ open, onOpenChange, segments, initialFind, initialOptions, glossary, onApply }: FindReplaceDialogProps) => {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [options, setOptions] = useState<SearchOptions>(initialOptions);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFind(initialFind);
      setReplace("");
      setOptions(initialOptions);
      setRemember(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const plan = useMemo(() => planReplace(segments, find, replace, options), [segments, find, replace, options]);
  const saved = useMemo(() => planReplaceAll(segments, glossary.entries, options), [segments, glossary.entries, options]);
  const pattern = useMemo(() => buildPattern(find, options), [find, options]);
  const byId = useMemo(() => new Map(segments.map((s) => [s.id, s])), [segments]);
  const hours = segments.some((s) => (s.end_seconds ?? 0) >= 3600);

  const run = async (updates: TextUpdate[], replacements: number) => {
    setBusy(true);
    const ok = await onApply(updates);
    setBusy(false);
    if (ok) {
      toast.success(`Replaced ${replacements} ${replacements === 1 ? "match" : "matches"} in ${updates.length} ${updates.length === 1 ? "segment" : "segments"}.`);
      return true;
    }
    return false;
  };

  const replaceAll = async () => {
    if (!(await run(plan.updates, plan.replacements))) return;
    if (remember) await glossary.remember(find, replace);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Find and replace</DialogTitle>
          <DialogDescription>
            Fix a name or term the model gets wrong, everywhere in this transcript. The model’s original text is always kept.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="fr-find">Find</Label>
              <Input id="fr-find" value={find} onChange={(e) => setFind(e.target.value)} autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fr-replace">Replace with</Label>
              <Input id="fr-replace" value={replace} onChange={(e) => setReplace(e.target.value)} />
            </div>
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={options.matchCase} onCheckedChange={(v) => setOptions((o) => ({ ...o, matchCase: v === true }))} />
              Match case
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={options.wholeWord} onCheckedChange={(v) => setOptions((o) => ({ ...o, wholeWord: v === true }))} />
              Whole word
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} disabled={!find.trim()} />
              Remember for my other transcripts
            </label>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm" aria-live="polite">
            {!find ? (
              <p className="text-muted-foreground">Type what to find to see how many places would change.</p>
            ) : plan.updates.length === 0 ? (
              <p className="text-muted-foreground">No matches.</p>
            ) : (
              <>
                <p className="font-medium">
                  {plan.replacements} {plan.replacements === 1 ? "match" : "matches"} in {plan.updates.length}{" "}
                  {plan.updates.length === 1 ? "segment" : "segments"}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {plan.updates.slice(0, PREVIEW_LIMIT).map((u) => {
                    const seg = byId.get(u.id);
                    if (!seg) return null;
                    return (
                      <li key={u.id} className="text-xs">
                        <span className="mr-2 font-mono text-muted-foreground">{formatTimestamp(seg.start_seconds, hours)}</span>
                        {splitByMatches(seg.text, pattern).map((p, i) =>
                          p.match ? (
                            <mark key={i} className="rounded bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-500/30">{p.text}</mark>
                          ) : (
                            <span key={i}>{p.text}</span>
                          ),
                        )}
                      </li>
                    );
                  })}
                </ul>
                {plan.updates.length > PREVIEW_LIMIT && (
                  <p className="mt-1.5 text-xs text-muted-foreground">…and {plan.updates.length - PREVIEW_LIMIT} more.</p>
                )}
              </>
            )}
          </div>

          {glossary.entries.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Saved corrections</h3>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || saved.updates.length === 0}
                  onClick={async () => {
                    if (await run(saved.updates, saved.replacements)) onOpenChange(false);
                  }}
                >
                  Apply all ({saved.replacements})
                </Button>
              </div>
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {glossary.entries.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{entry.find_text}</span> → {entry.replace_text || <em>(nothing)</em>}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      aria-label={`Forget the correction ${entry.find_text}`}
                      onClick={() => glossary.forget(entry.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          <Button disabled={busy || plan.updates.length === 0} onClick={replaceAll}>
            Replace all ({plan.replacements})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default FindReplaceDialog;
