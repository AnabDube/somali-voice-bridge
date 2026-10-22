import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import type { TranscriptSegment } from "@/lib/segments";

export interface SegmentUpdate {
  id: string;
  text?: string;
  speaker?: string | null;
}

const COLUMNS =
  "id, idx, start_seconds, end_seconds, text, original_text, avg_logprob, no_speech_prob, compression_ratio, speaker, edited_at";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);

const toSegment = (row: Record<string, unknown>): TranscriptSegment => ({
  id: row.id as string,
  idx: Number(row.idx),
  start_seconds: num(row.start_seconds),
  end_seconds: num(row.end_seconds),
  text: (row.text as string) ?? "",
  original_text: (row.original_text as string) ?? "",
  avg_logprob: num(row.avg_logprob),
  no_speech_prob: num(row.no_speech_prob),
  compression_ratio: num(row.compression_ratio),
  speaker: (row.speaker as string | null) ?? null,
  edited_at: (row.edited_at as string | null) ?? null,
});

/** The server accepts at most 2000 changes per call; stay well under. */
const BATCH = 500;

/**
 * The segments of a transcript, with saving. Edits show immediately and are
 * saved in the background; if saving fails the change is undone and the user is
 * told. The model's original text is never touched (the database enforces it).
 */
export const useSegments = (transcriptionId: string | null | undefined) => {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingSaves, setPendingSaves] = useState(0);
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  const load = useCallback(async () => {
    if (!transcriptionId) return;
    // Older transcripts get their segments created on first open (safe to repeat).
    const { error: ensureError } = await supabase.rpc("ensure_segments", { p_transcription: transcriptionId });
    if (ensureError) console.error("ensure_segments failed:", ensureError);

    const { data, error: loadError } = await supabase
      .from("transcript_segments")
      .select(COLUMNS)
      .eq("transcription_id", transcriptionId)
      .order("idx");
    if (loadError) {
      setError("We couldn't load the transcript segments. Please refresh the page.");
    } else {
      setError(null);
      setSegments((data ?? []).map((row) => toSegment(row as Record<string, unknown>)));
    }
    setLoading(false);
  }, [transcriptionId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  /** Apply edits. Resolves to true when they were saved. */
  const applyUpdates = useCallback(async (updates: SegmentUpdate[]): Promise<boolean> => {
    if (updates.length === 0) return true;
    const before = segmentsRef.current;
    const byId = new Map(updates.map((u) => [u.id, u]));
    const now = new Date().toISOString();

    // Show the change at once.
    setSegments((prev) =>
      prev.map((s) => {
        const u = byId.get(s.id);
        if (!u) return s;
        const text = u.text !== undefined ? u.text.trim() : s.text;
        const speaker = u.speaker !== undefined ? (u.speaker?.trim() || null) : s.speaker;
        return { ...s, text, speaker, edited_at: text !== s.text ? now : s.edited_at };
      }),
    );

    setPendingSaves((n) => n + 1);
    try {
      for (let i = 0; i < updates.length; i += BATCH) {
        const { error: saveError } = await supabase.rpc("update_segments", {
          p_updates: updates.slice(i, i + BATCH) as unknown as Json,
        });
        if (saveError) throw saveError;
      }
      return true;
    } catch (e) {
      console.error("Saving segments failed:", e);
      setSegments(before); // undo
      toast.error("Your change couldn't be saved, so it was undone. Please try again.");
      return false;
    } finally {
      setPendingSaves((n) => n - 1);
    }
  }, []);

  /** Rename one speaker everywhere (null = the segments with no speaker yet). */
  const renameSpeaker = useCallback(
    async (from: string | null, to: string): Promise<boolean> => {
      if (!transcriptionId) return false;
      const before = segmentsRef.current;
      const next = to.trim() || null;
      setSegments((prev) => prev.map((s) => (s.speaker === from ? { ...s, speaker: next } : s)));
      setPendingSaves((n) => n + 1);
      try {
        const { error: renameError } = await supabase.rpc("rename_speaker", {
          p_transcription: transcriptionId,
          p_from: from as string,
          p_to: to,
        });
        if (renameError) throw renameError;
        return true;
      } catch (e) {
        console.error("Renaming speaker failed:", e);
        setSegments(before);
        toast.error("The speaker couldn't be renamed. Please try again.");
        return false;
      } finally {
        setPendingSaves((n) => n - 1);
      }
    },
    [transcriptionId],
  );

  return { segments, loading, error, saving: pendingSaves > 0, applyUpdates, renameSpeaker, reload: load };
};
