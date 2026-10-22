import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { getCorsHeaders } from "../_shared/cors.ts";
import { claimStep, finishStep } from "../_shared/steps.ts";
import { finalizeChunkedTranscription } from "../_shared/finalize.ts";
import { promptTail, toSegment, type WhisperSegment } from "../_shared/transcript.ts";

// Transcribes the uploaded parts of a long recording, in order, on the server.
//
// The browser only converts, splits and uploads; once the parts are in storage
// this function does the rest, so it carries on if the tab is closed. Each call
// works for about 100 seconds (the edge-function limit is 150), then starts the
// next call and stops: the work is a chain of short calls. Progress is kept in
// the database after every part, so nothing is repeated and a stalled chain can
// simply be retried.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const BUDGET_MS = 100_000;
/** Don't start another part with less time than this left. */
const MIN_TIME_FOR_PART_MS = 30_000;
const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 130;
const WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Ctx {
  admin: SupabaseClient;
  uploadId: string;
  userId: string;
  groqKey: string;
  supabaseUrl: string;
  anonKey: string;
  authHeader: string;
}

interface Part {
  idx: number;
  start_seconds: number;
  duration_seconds: number;
  whisper_seconds: number | null;
  file_path: string;
  status: string;
  attempts: number;
  text: string | null;
  error_message: string | null;
}

type PartResult =
  | { kind: "ok"; text: string; seconds: number | null; segments: WhisperSegment[] }
  | { kind: "rate_limited"; waitSeconds: number }
  | { kind: "failed"; message: string };

const transcribePart = async (ctx: Ctx, part: Part, previousText: string | null): Promise<PartResult> => {
  const { data: file, error } = await ctx.admin.storage.from("audio-uploads").download(part.file_path);
  if (error || !file) return { kind: "failed", message: "we couldn't read this part's audio file." };

  const form = new FormData();
  form.append("file", new File([file], `part-${part.idx}.mp3`, { type: "audio/mpeg" }));
  form.append("model", "whisper-large-v3");
  form.append("language", "so");
  form.append("response_format", "verbose_json");
  // The end of the previous part keeps spelling and context consistent across the cut.
  const prompt = promptTail(previousText);
  if (prompt) form.append("prompt", prompt);

  const resp = await fetch(WHISPER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.groqKey}` },
    body: form,
  });

  if (resp.status === 429) {
    const retryAfter = Number(resp.headers.get("retry-after"));
    await resp.body?.cancel();
    return { kind: "rate_limited", waitSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 600) : 30 };
  }
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Whisper error for part ${part.idx}:`, resp.status, body.slice(0, 300));
    if (resp.status === 402 || /insufficient_quota/.test(body)) {
      return { kind: "failed", message: "the transcription service is out of credits. Please try again later." };
    }
    if (resp.status === 413) return { kind: "failed", message: "this part is too large for the transcription service." };
    return { kind: "failed", message: `the transcription service had a problem (code ${resp.status}).` };
  }

  const result = await resp.json();
  const segments = ((result.segments ?? []) as WhisperSegment[]).map((s, i) => toSegment(s, i));
  return { kind: "ok", text: result.text ?? "", seconds: typeof result.duration === "number" ? result.duration : null, segments };
};

const failRecording = async (ctx: Ctx, part: Part, total: number, reason: string) => {
  await finishStep(
    ctx.admin,
    ctx.uploadId,
    "transcription",
    false,
    `Part ${part.idx + 1} of ${total} could not be transcribed: ${reason} Click Retry to try again. Finished parts are kept.`,
  );
  await ctx.admin.from("audio_uploads").update({ status: "failed" }).eq("id", ctx.uploadId);
};

/** 'finished' | 'stopped' (done, failed or cancelled: nothing more to do) | 'chain' (more work, out of time) */
const work = async (ctx: Ctx, timeLeft: () => number): Promise<"finished" | "stopped" | "chain"> => {
  const { admin, uploadId, userId } = ctx;

  const { data: adminRole } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  const isAdmin = !!adminRole;

  for (let guard = 0; guard < 200; guard++) {
    // Stop if the recording was deleted, cancelled, or the watchdog gave up on it.
    const { data: step } = await admin
      .from("processing_steps")
      .select("status")
      .eq("upload_id", uploadId)
      .eq("step", "transcription")
      .maybeSingle();
    if (step?.status !== "processing") return "stopped";

    const { data, error } = await admin
      .from("audio_chunks")
      .select("idx, start_seconds, duration_seconds, whisper_seconds, file_path, status, attempts, text, error_message")
      .eq("upload_id", uploadId)
      .order("idx");
    const parts = (data ?? []) as Part[];
    if (error || parts.length === 0) return "stopped";

    const next = parts.find((p) => p.status !== "done");
    if (!next) {
      const result = await finalizeChunkedTranscription({
        admin,
        uploadId,
        userId,
        supabaseUrl: ctx.supabaseUrl,
        anonKey: ctx.anonKey,
        authHeader: ctx.authHeader,
      });
      return result.ok ? "finished" : "stopped";
    }

    if (next.status === "failed" && next.attempts >= MAX_ATTEMPTS) {
      await failRecording(ctx, next, parts.length, next.error_message ?? "an unknown error occurred.");
      return "stopped";
    }
    if (timeLeft() < MIN_TIME_FOR_PART_MS) return "chain";

    // We hold the lease, so a part still marked "processing" belongs to a worker that died.
    if (next.status === "processing") {
      await admin.from("audio_chunks").update({ status: "pending" }).eq("upload_id", uploadId).eq("idx", next.idx);
    }
    const { data: claimed } = await admin.rpc("claim_chunk", { p_upload: uploadId, p_idx: next.idx });
    if (claimed !== "claimed") continue;

    // Enough minutes left for everything transcribed so far plus this part?
    if (!isAdmin) {
      const doneSeconds = parts
        .filter((p) => p.status === "done")
        .reduce((sum, p) => sum + Number(p.whisper_seconds ?? p.duration_seconds), 0);
      const needed = Math.ceil((doneSeconds + Number(next.duration_seconds)) / 60);
      const { data: profile } = await admin
        .from("profiles")
        .select("minutes_used, minutes_limit")
        .eq("user_id", userId)
        .single();
      const remaining = Number(profile?.minutes_limit ?? 0) - Number(profile?.minutes_used ?? 0);
      if (needed > remaining) {
        const message = "you don't have enough minutes left for this recording. Upgrade your plan to continue.";
        await admin.rpc("finish_chunk", { p_upload: uploadId, p_idx: next.idx, p_status: "failed", p_error: message });
        await failRecording(ctx, next, parts.length, message);
        return "stopped";
      }
    }

    const previous = parts.find((p) => p.idx === next.idx - 1);
    const result = await transcribePart(ctx, next, previous?.text ?? null);

    if (result.kind === "ok") {
      await admin.rpc("finish_chunk", {
        p_upload: uploadId,
        p_idx: next.idx,
        p_status: "done",
        p_text: result.text,
        p_segments: result.segments,
        p_seconds: result.seconds,
      });
      continue;
    }

    if (result.kind === "rate_limited") {
      // The service's hourly audio limit: give the part back and wait it out,
      // without counting it as a failed attempt.
      await admin.rpc("finish_chunk", { p_upload: uploadId, p_idx: next.idx, p_status: "pending" });
      await admin.from("audio_chunks").update({ attempts: next.attempts }).eq("upload_id", uploadId).eq("idx", next.idx);
      const waitMs = Math.min(result.waitSeconds * 1000, Math.max(0, timeLeft() - 5_000));
      console.warn(`Rate limited on part ${next.idx}; waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      await admin.rpc("set_step_progress", { p_upload: uploadId, p_step: "transcription" }); // heartbeat
      if (timeLeft() < MIN_TIME_FOR_PART_MS) return "chain";
      continue;
    }

    // A real failure. Two automatic retries, then give up and say which part.
    await admin.rpc("finish_chunk", { p_upload: uploadId, p_idx: next.idx, p_status: "failed", p_error: result.message });
    const attemptsMade = next.attempts + 1;
    if (attemptsMade >= MAX_ATTEMPTS) {
      await failRecording(ctx, next, parts.length, result.message);
      return "stopped";
    }
    await sleep(Math.min(2000 * attemptsMade, Math.max(0, timeLeft() - MIN_TIME_FOR_PART_MS)));
  }
  return "chain";
};

const run = async (ctx: Ctx): Promise<void> => {
  const startedAt = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - startedAt);

  const claim = await claimStep(ctx.admin, ctx.uploadId, "transcription");
  if (claim === "done") return;

  const { data: gotLease } = await ctx.admin.rpc("acquire_chunk_lease", { p_upload: ctx.uploadId, p_seconds: LEASE_SECONDS });
  if (!gotLease) return; // another call is already working on this recording

  let outcome: "finished" | "stopped" | "chain" = "stopped";
  try {
    await ctx.admin.from("audio_uploads").update({ status: "processing" }).eq("id", ctx.uploadId);
    outcome = await work(ctx, timeLeft);
  } catch (e) {
    console.error("process-chunks failed:", e);
    await finishStep(ctx.admin, ctx.uploadId, "transcription", false, "Transcription stopped unexpectedly. Click Retry to carry on.");
  } finally {
    await ctx.admin.rpc("release_chunk_lease", { p_upload: ctx.uploadId });
  }

  if (outcome === "chain") {
    await fetch(`${ctx.supabaseUrl}/functions/v1/process-chunks`, {
      method: "POST",
      headers: { Authorization: ctx.authHeader, apikey: ctx.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ upload_id: ctx.uploadId }),
    })
      .then((r) => r.body?.cancel())
      .catch((e) => console.error("process-chunks: could not start the next call:", e));
  }
};

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!groqKey) return json(500, { error: "GROQ_API_KEY not configured" });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json(401, { error: "Unauthorized" });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: claims, error: claimsError } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    if (claimsError || !claims?.claims) return json(401, { error: "Unauthorized" });
    const userId = claims.claims.sub as string;

    const { upload_id } = await req.json();
    if (!upload_id) return json(400, { error: "upload_id is required" });

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: upload } = await admin
      .from("audio_uploads")
      .select("id")
      .eq("id", upload_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!upload) return json(404, { error: "Upload not found" });

    const { count } = await admin
      .from("audio_chunks")
      .select("idx", { count: "exact", head: true })
      .eq("upload_id", upload_id);
    if (!count) return json(404, { error: "no_parts", message: "This recording has no uploaded parts." });

    // Answer straight away and keep working in the background.
    const job = run({ admin, uploadId: upload_id, userId, groqKey, supabaseUrl, anonKey, authHeader }).catch((e) =>
      console.error("process-chunks job error:", e),
    );
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(job);

    return json(202, { success: true, status: "started" });
  } catch (e) {
    console.error("process-chunks error:", e);
    return json(500, { error: e instanceof Error ? e.message : "Unknown error" });
  }
});
