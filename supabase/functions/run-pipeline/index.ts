import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { getCorsHeaders } from "../_shared/cors.ts";

// Runs the steps that follow transcription for one recording, on the server:
//   translation -> cleaning -> research translation -> summary
// Used right after transcription finishes, after the user edits a transcript,
// and by the Retry buttons ({ upload_id, step } retries just that step).
//
// It answers at once and keeps working in the background. The AI service only
// allows about 8,000 tokens a minute, so a long transcript is translated and
// summarised in batches over several calls; each call works for about 100
// seconds (the edge-function limit is 150), then starts the next call and stops.
// A step reports "partial" when it saved some progress and needs another call.
//
// Every step is idempotent and tracks its own status (see _shared/steps.ts), so
// calling this twice, or while a step is already running, never repeats work.
// A step that fails never stops the others, and is not retried automatically.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

type PipelineStep = "translation" | "cleaning" | "research" | "summary";

const ORDER: PipelineStep[] = ["translation", "cleaning", "research", "summary"];

const FUNCTION_FOR_STEP: Record<PipelineStep, string> = {
  translation: "translate-text",
  cleaning: "process-transcript",
  research: "translate-research",
  summary: "generate-summary",
};

const BUDGET_MS = 105_000;
/** Don't start another step call with less time than this left. */
const MIN_TIME_FOR_CALL_MS = 30_000;

const isPipelineStep = (value: unknown): value is PipelineStep =>
  typeof value === "string" && value in FUNCTION_FOR_STEP;

interface Ctx {
  admin: SupabaseClient;
  uploadId: string;
  transcriptionId: string;
  supabaseUrl: string;
  anonKey: string;
  authHeader: string;
}

const statusOf = async (ctx: Ctx): Promise<Partial<Record<PipelineStep, string>>> => {
  const { data } = await ctx.admin.from("processing_steps").select("step, status").eq("upload_id", ctx.uploadId);
  const map: Partial<Record<PipelineStep, string>> = {};
  for (const row of data ?? []) if (isPipelineStep(row.step)) map[row.step] = row.status;
  return map;
};

/** One call to a step function. `partial` means it saved progress and needs another call. */
const callStep = async (ctx: Ctx, step: PipelineStep, budgetMs: number): Promise<{ ok: boolean; partial: boolean }> => {
  try {
    const resp = await fetch(`${ctx.supabaseUrl}/functions/v1/${FUNCTION_FOR_STEP[step]}`, {
      method: "POST",
      headers: { Authorization: ctx.authHeader, apikey: ctx.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ transcription_id: ctx.transcriptionId, budget_ms: Math.max(0, Math.floor(budgetMs)) }),
    });
    const body = await resp.json().catch(() => null);
    return { ok: resp.ok, partial: resp.ok && body?.partial === true };
  } catch (e) {
    console.error(`run-pipeline: ${step} request failed`, e);
    return { ok: false, partial: false };
  }
};

/** Hand the rest of the work to a fresh call, which gets a fresh time budget. */
const chain = async (ctx: Ctx, step?: PipelineStep) => {
  await fetch(`${ctx.supabaseUrl}/functions/v1/run-pipeline`, {
    method: "POST",
    headers: { Authorization: ctx.authHeader, apikey: ctx.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ upload_id: ctx.uploadId, ...(step ? { step } : {}) }),
  })
    .then((r) => r.body?.cancel())
    .catch((e) => console.error("run-pipeline: could not start the next call:", e));
};

/** The summary needs an English text; if none can be produced, say so now instead of leaving it queued. */
const failSummaryWaitingOnTranslation = async (ctx: Ctx) => {
  const status = await statusOf(ctx);
  if (status.summary === "pending" && status.translation === "failed" && status.research !== "done") {
    await ctx.admin.rpc("finish_step", {
      p_upload: ctx.uploadId,
      p_step: "summary",
      p_ok: false,
      p_error: "The summary needs the English translation first. Retry the translation and the summary will follow.",
    });
  }
};

const runPipeline = async (ctx: Ctx, onlyStep?: PipelineStep): Promise<void> => {
  const startedAt = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - startedAt);

  let target: PipelineStep | null = onlyStep ?? null;
  let explicit = !!onlyStep; // a retry of one named step, not the automatic run

  const pickNext = async (): Promise<PipelineStep | null> => {
    const status = await statusOf(ctx);
    return ORDER.find((s) => status[s] === "pending") ?? null;
  };
  if (!target) target = await pickNext();

  for (let guard = 0; target && guard < 100; guard++) {
    if (timeLeft() < MIN_TIME_FOR_CALL_MS) {
      await chain(ctx, explicit ? target : undefined);
      return;
    }

    const result = await callStep(ctx, target, timeLeft() - 10_000);
    if (result.partial) continue; // same step again: it saved some progress and has more to do

    if (explicit) {
      // Retrying translation brings the summary along if it still hasn't been produced.
      explicit = false;
      const status = await statusOf(ctx);
      const dependsOnEnglish = target === "translation" || target === "research";
      target = result.ok && dependsOnEnglish && status.summary !== "done" ? "summary" : null;
      continue;
    }
    target = await pickNext();
  }

  await failSummaryWaitingOnTranslation(ctx);
};

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json(401, { error: "Unauthorized" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(
      authHeader.replace("Bearer ", ""),
    );
    if (claimsError || !claimsData?.claims) {
      return json(401, { error: "Unauthorized" });
    }
    const userId = claimsData.claims.sub as string;

    const { upload_id, step } = await req.json();
    if (!upload_id) {
      return json(400, { error: "upload_id is required" });
    }
    if (step !== undefined && !isPipelineStep(step)) {
      return json(400, { error: "Unknown step" });
    }

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: transcription } = await admin
      .from("transcriptions")
      .select("id")
      .eq("upload_id", upload_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!transcription) {
      return json(404, { error: "Transcript not found" });
    }

    const job = runPipeline(
      { admin, uploadId: upload_id, transcriptionId: transcription.id, supabaseUrl, anonKey, authHeader },
      step,
    ).catch((e) => console.error("run-pipeline job error:", e));
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(job);

    return json(202, { success: true, status: "started" });
  } catch (e) {
    console.error("run-pipeline error:", e);
    return json(500, { error: e instanceof Error ? e.message : "Unknown error" });
  }
});
