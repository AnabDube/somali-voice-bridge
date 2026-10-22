// Finishing a chunked transcription: once every part has its text, stitch them
// into one transcript, save it, charge the minutes once, and hand over to the
// pipeline (cleaning, translation, summary).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { finishStep } from "./steps.ts";
import { stitchChunks, type ChunkResult } from "./transcript.ts";

/** Longest recording we accept, plus a little slack for rounding. */
const MAX_TOTAL_SECONDS = 7260;

export interface FinalizeContext {
  admin: SupabaseClient;
  uploadId: string;
  userId: string;
  supabaseUrl: string;
  anonKey: string;
  authHeader: string;
}

export type FinalizeResult =
  | { ok: true; minutes: number; characters: number }
  | { ok: false; reason: "incomplete" | "too_long" | "save_failed"; message: string };

export const finalizeChunkedTranscription = async (ctx: FinalizeContext): Promise<FinalizeResult> => {
  const { admin, uploadId, userId } = ctx;

  const { data: rows, error } = await admin
    .from("audio_chunks")
    .select("idx, start_seconds, duration_seconds, whisper_seconds, text, segments, status, file_path")
    .eq("upload_id", uploadId)
    .order("idx");
  if (error || !rows || rows.length === 0) {
    return { ok: false, reason: "incomplete", message: "The recording's parts could not be found." };
  }
  if (rows.some((r) => r.status !== "done")) {
    return { ok: false, reason: "incomplete", message: "Some parts have not been transcribed yet." };
  }

  const stitched = stitchChunks(
    rows.map((r) => ({
      idx: r.idx,
      start_seconds: Number(r.start_seconds),
      duration_seconds: Number(r.duration_seconds),
      whisper_seconds: r.whisper_seconds === null ? null : Number(r.whisper_seconds),
      text: r.text,
      segments: r.segments,
    })) as ChunkResult[],
  );

  if (stitched.totalSeconds > MAX_TOTAL_SECONDS) {
    const message = "This recording is longer than 120 minutes, which is the limit. Please upload a shorter one.";
    await finishStep(admin, uploadId, "transcription", false, message);
    await admin.from("audio_uploads").update({ status: "failed" }).eq("id", uploadId);
    return { ok: false, reason: "too_long", message };
  }

  const { error: saveError } = await admin.from("transcriptions").upsert(
    {
      upload_id: uploadId,
      user_id: userId,
      somali_text: stitched.text,
      confidence_score: null,
      speaker_timestamps: stitched.segments.length > 0 ? stitched.segments : null,
    },
    { onConflict: "upload_id" },
  );
  if (saveError) {
    console.error("finalize: saving the transcript failed:", saveError);
    const message = "We couldn't save the transcript. Please retry.";
    await finishStep(admin, uploadId, "transcription", false, message);
    await admin.from("audio_uploads").update({ status: "failed" }).eq("id", uploadId);
    return { ok: false, reason: "save_failed", message };
  }

  await admin
    .from("audio_uploads")
    .update({ status: "completed", duration_seconds: stitched.totalSeconds })
    .eq("id", uploadId);

  // Charged once for the whole recording (rounded up to whole minutes) no
  // matter how many parts or retries it took. Admins are recorded too; they
  // are just never blocked by the limit.
  const minutes = Math.max(1, Math.ceil(stitched.totalSeconds / 60));
  const { error: chargeError } = await admin.rpc("charge_upload_minutes", { p_upload: uploadId, p_minutes: minutes });
  if (chargeError) console.error("finalize: charge_upload_minutes failed:", chargeError);

  await finishStep(admin, uploadId, "transcription", true);
  await admin.rpc("init_pipeline_steps", { p_upload: uploadId });

  // The parts have done their job (the playback copy stays). Tidy up, best effort.
  const paths = rows.map((r) => r.file_path as string);
  const { error: removeError } = await admin.storage.from("audio-uploads").remove(paths);
  if (removeError) console.error("finalize: could not remove part files:", removeError);
  await admin.from("audio_chunks").delete().eq("upload_id", uploadId);

  // Cleaning, translation and summary run server side, one call at a time.
  await fetch(`${ctx.supabaseUrl}/functions/v1/run-pipeline`, {
    method: "POST",
    headers: { Authorization: ctx.authHeader, apikey: ctx.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ upload_id: uploadId }),
  })
    .then((r) => r.body?.cancel())
    .catch((e) => console.error("finalize: could not start run-pipeline:", e));

  return { ok: true, minutes, characters: stitched.text.length };
};
