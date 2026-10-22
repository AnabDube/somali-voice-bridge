// Getting a recording from the user's device to the server, ready to transcribe.
//
// Two paths:
//  * Short, small files in a supported format are uploaded as they are and
//    transcribed in one go (as before).
//  * Everything else is converted to small mono MP3 parts in the browser (see
//    audioPrep.ts), the parts are uploaded, and the SERVER transcribes them in
//    order and keeps going if the tab is closed. The browser is only needed
//    until the parts have been uploaded.
//
// The recording is saved first and its upload is a tracked step, so a failure
// stays visible in the list with a reason instead of vanishing.

import { supabase } from "@/integrations/supabase/client";
import type { UploadMetadata } from "@/components/AudioUploader";
import { friendlyUploadError, needsPreparation } from "@/lib/audio";
import { readFunctionError } from "@/lib/functionErrors";
import type { PreparedChunk, PrepStage } from "@/lib/audioPrep";

export type UploadPhase =
  | { kind: "tools"; percent: number }
  | { kind: "analysing"; percent: number }
  | { kind: "converting"; percent: number }
  | { kind: "uploading"; part: number; total: number }
  | { kind: "playback" }
  | { kind: "starting" };

/** Phases after which the browser is no longer needed, so cancelling is not offered. */
export const isCancellable = (phase: UploadPhase | null): boolean =>
  !!phase && phase.kind !== "starting" && phase.kind !== "playback";

export class UploadError extends Error {
  constructor(message: string, public code: "cancelled" | "failed" = "failed") {
    super(message);
    this.name = "UploadError";
  }
}

export interface UploadInput {
  file: File;
  metadata: UploadMetadata;
  userId: string;
  /** Length as the browser sees it, or 0 if unknown. */
  durationSec: number;
  signal?: AbortSignal;
  onPhase?: (phase: UploadPhase) => void;
  /** Called as soon as the recording is saved, so lists can show it straight away. */
  onCreated?: () => void;
  /** Called if the server couldn't be asked to start transcribing (the recording itself is saved). */
  onStartError?: (message: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async <T>(task: () => Promise<T>, attempts: number, signal?: AbortSignal): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new UploadError("Cancelled.", "cancelled");
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(1000 * 3 ** attempt);
    }
  }
  throw lastError;
};

const partPath = (userId: string, uploadId: string, index: number) =>
  `${userId}/${uploadId}/part-${String(index).padStart(3, "0")}.mp3`;

/** Mark a recording's upload as failed, with the reason shown in the list. */
const markFailed = async (uploadId: string, reason: string) => {
  await supabase
    .from("processing_steps")
    .update({ status: "failed", error_message: reason })
    .eq("upload_id", uploadId)
    .eq("step", "upload");
  await supabase.from("audio_uploads").update({ status: "failed" }).eq("id", uploadId);
};

/** Removes a recording that was cancelled before it was handed to the server. */
const discard = async (userId: string, uploadId: string) => {
  const { data } = await supabase.storage.from("audio-uploads").list(`${userId}/${uploadId}`);
  if (data?.length) {
    await supabase.storage.from("audio-uploads").remove(data.map((f) => `${userId}/${uploadId}/${f.name}`));
  }
  await supabase.from("audio_uploads").delete().eq("id", uploadId);
};

const touchUploadStep = (uploadId: string) =>
  supabase.from("processing_steps").update({ status: "processing" }).eq("upload_id", uploadId).eq("step", "upload");

const insertRecording = async (input: UploadInput, id: string, filePath: string) => {
  const { file, metadata, userId, durationSec } = input;
  const { error } = await supabase
    .from("audio_uploads")
    .insert({
      id,
      user_id: userId,
      file_name: file.name,
      file_path: filePath,
      file_size_bytes: file.size,
      duration_seconds: durationSec > 0 ? durationSec : null,
      dialect: metadata.dialect,
      audio_quality: metadata.audio_quality,
      speaker_gender: metadata.speaker_gender,
      speaker_age_range: metadata.speaker_age_range,
      approved_for_training: metadata.training_consent,
      status: "uploaded",
    } as never);
  if (error) throw error;

  await supabase.from("processing_steps").insert({
    upload_id: id,
    user_id: userId,
    step: "upload",
    status: "processing",
    attempts: 1,
    started_at: new Date().toISOString(),
  });
};

export const uploadRecording = async (input: UploadInput): Promise<{ uploadId: string }> => {
  const { file, userId, durationSec, signal, onPhase, onCreated, onStartError } = input;
  const uploadId = crypto.randomUUID();
  const chunked = needsPreparation(file, durationSec);

  // ---------------------------------------------------------------- short path
  if (!chunked) {
    const filePath = `${userId}/${Date.now()}-${file.name}`;
    try {
      await insertRecording(input, uploadId, filePath);
      onCreated?.();
      onPhase?.({ kind: "uploading", part: 1, total: 1 });
      const { error } = await supabase.storage.from("audio-uploads").upload(filePath, file, { contentType: file.type });
      if (error) throw error;
      await supabase
        .from("processing_steps")
        .update({ status: "done", error_message: null })
        .eq("upload_id", uploadId)
        .eq("step", "upload");
    } catch (error) {
      const reason = friendlyUploadError(error);
      await markFailed(uploadId, reason).catch(() => undefined);
      throw new UploadError(reason);
    }

    // Transcription (and everything after it) runs on the server from here.
    void supabase.functions.invoke("transcribe-audio", { body: { upload_id: uploadId } }).then(async ({ error }) => {
      if (error) {
        console.error("Transcription function error:", error);
        onStartError?.((await readFunctionError(error)) ?? "Transcription could not start. Use Retry on the recording.");
      }
    });
    return { uploadId };
  }

  // ----------------------------------------------------------------- long path
  const playbackPath = `${userId}/${uploadId}/audio.mp3`;
  try {
    await insertRecording(input, uploadId, playbackPath);
    onCreated?.();
  } catch (error) {
    throw new UploadError(friendlyUploadError(error));
  }

  // The audio tools are only loaded for files that need them.
  const { PrepError, prepareAudio } = await import("@/lib/audioPrep");
  let prepared: Awaited<ReturnType<typeof prepareAudio>>;
  try {
    prepared = await prepareAudio(file, {
      signal,
      onProgress: ({ stage, percent }: { stage: PrepStage; percent: number }) =>
        onPhase?.({ kind: stage, percent } as UploadPhase),
    });
  } catch (error) {
    if (error instanceof PrepError && error.code === "cancelled") {
      await discard(userId, uploadId).catch(() => undefined);
      throw new UploadError("Cancelled.", "cancelled");
    }
    const reason = error instanceof PrepError ? error.message : "Preparing the audio failed. Please try again.";
    await markFailed(uploadId, reason).catch(() => undefined);
    throw new UploadError(reason);
  }

  const { chunks } = prepared;
  const total = chunks.length;

  try {
    // Tell the server what the parts are (it checks the limits and the user's minutes).
    const { error: registerError } = await supabase.rpc("register_chunks", {
      p_upload: uploadId,
      p_chunks: chunks.map((c) => ({
        idx: c.index,
        start: Number(c.start.toFixed(2)),
        duration: Number(c.duration.toFixed(2)),
        path: partPath(userId, uploadId, c.index),
      })),
    });
    if (registerError) {
      if (/insufficient_minutes/.test(registerError.message)) {
        throw new UploadError("You don't have enough minutes left for this recording. Upgrade your plan to continue.");
      }
      if (/120 minutes/.test(registerError.message)) {
        throw new UploadError("This recording is longer than 120 minutes, which is the limit.");
      }
      throw registerError;
    }

    for (const chunk of chunks as PreparedChunk[]) {
      if (signal?.aborted) throw new UploadError("Cancelled.", "cancelled");
      onPhase?.({ kind: "uploading", part: chunk.index + 1, total });
      await withRetry(
        async () => {
          const { error } = await supabase.storage
            .from("audio-uploads")
            .upload(partPath(userId, uploadId, chunk.index), chunk.blob, { contentType: "audio/mpeg", upsert: true });
          if (error) throw error;
        },
        3,
        signal,
      );
      await touchUploadStep(uploadId); // a sign of life, so a slow connection isn't mistaken for a stall
    }
  } catch (error) {
    if (error instanceof UploadError && error.code === "cancelled") {
      await discard(userId, uploadId).catch(() => undefined);
      throw error;
    }
    const reason = error instanceof UploadError ? error.message : friendlyUploadError(error);
    await markFailed(uploadId, reason).catch(() => undefined);
    throw error instanceof UploadError ? error : new UploadError(reason);
  }

  await supabase
    .from("processing_steps")
    .update({ status: "done", error_message: null })
    .eq("upload_id", uploadId)
    .eq("step", "upload");

  // Hand over to the server. From here the browser is optional.
  onPhase?.({ kind: "starting" });
  const started = await withRetry(
    async () => {
      const { error } = await supabase.functions.invoke("process-chunks", { body: { upload_id: uploadId } });
      if (error) throw error;
    },
    3,
  ).then(
    () => true,
    async (error) => {
      console.error("process-chunks could not be started:", error);
      onStartError?.((await readFunctionError(error)) ?? "Transcription could not start. Use Retry on the recording.");
      return false;
    },
  );

  // A playable copy for the transcript page: the parts joined byte for byte.
  // Optional, so a failure here never affects the transcript.
  if (started) {
    onPhase?.({ kind: "playback" });
    try {
      await withRetry(
        async () => {
          const { error } = await supabase.storage
            .from("audio-uploads")
            .upload(playbackPath, new Blob(chunks.map((c) => c.blob), { type: "audio/mpeg" }), {
              contentType: "audio/mpeg",
              upsert: true,
            });
          if (error) throw error;
        },
        3,
      );
    } catch (error) {
      console.error("Could not upload the playback copy:", error);
      onStartError?.("Your transcript is on its way, but the audio player copy couldn't be saved.");
    }
  }

  return { uploadId };
};
