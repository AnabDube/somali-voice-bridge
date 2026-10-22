// Step tracking for the processing pipeline.
//
// Every recording moves through steps (see public.processing_steps). Edge
// functions use claimStep() before doing work and finishStep() afterwards, so
// the app can always show what is happening, and a second request for a step
// that is already running does nothing (safe to double-click Retry).

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { getCorsHeaders } from "./cors.ts";

export type StepName = "upload" | "transcription" | "cleaning" | "translation" | "research" | "summary";

const STEP_LABEL: Record<StepName, string> = {
  upload: "Upload",
  transcription: "Transcription",
  cleaning: "Cleaning",
  translation: "Translation",
  research: "Research translation",
  summary: "Summary",
};

/** 'claimed' = you own the step now; 'processing' = already running elsewhere. */
export const claimStep = async (
  admin: SupabaseClient,
  uploadId: string,
  step: StepName,
  force = false,
): Promise<"claimed" | "processing" | "done" | "pending" | "failed" | "missing"> => {
  const { data, error } = await admin.rpc("claim_step", { p_upload: uploadId, p_step: step, p_force: force });
  if (error) throw error;
  return data as "claimed" | "processing" | "done" | "pending" | "failed" | "missing";
};

export const finishStep = async (
  admin: SupabaseClient,
  uploadId: string,
  step: StepName,
  ok: boolean,
  error?: string,
): Promise<void> => {
  const { error: rpcError } = await admin.rpc("finish_step", {
    p_upload: uploadId,
    p_step: step,
    p_ok: ok,
    p_error: error ?? null,
  });
  // Never let bookkeeping mask the real result.
  if (rpcError) console.error(`finish_step(${step}) failed:`, rpcError);
};

/** A message a user can act on, from an edge-function failure response. */
export const plainStepError = (step: StepName, status: number, body: { error?: string; message?: string } | null): string => {
  const label = STEP_LABEL[step];
  if (status === 429) return "The AI service is busy right now. Please retry in a minute.";
  if (status === 402) return "The AI service is temporarily out of credits. Please try again later.";
  if (body?.error === "No Somali text to translate" || body?.error === "No Somali text to process") {
    return "There is no transcript text to work with yet.";
  }
  if (status >= 400 && status < 500 && body?.message) return body.message;
  return `${label} failed. Please retry.`;
};

interface TrackSpec {
  step: StepName;
  /** True when this transcription row already has this step's result. */
  isDone: (transcription: Record<string, unknown>) => boolean;
}

/**
 * Wraps an existing edge-function handler (keyed by `transcription_id`) with
 * step tracking, without touching the handler's own logic:
 *  - result already present  -> mark the step done and let the handler return its cached result
 *  - step already running    -> return immediately (no duplicate work)
 *  - otherwise               -> claim the step, run the handler, record done / failed + reason
 * Anything it can't identify (bad auth, unknown id) is passed straight to the handler,
 * which answers with its usual error.
 */
export const trackStep = async (
  req: Request,
  spec: TrackSpec,
  inner: (req: Request) => Promise<Response>,
): Promise<Response> => {
  const authHeader = req.headers.get("Authorization");
  if (req.method === "OPTIONS" || !authHeader?.startsWith("Bearer ")) return inner(req);

  let transcriptionId: string | undefined;
  try {
    transcriptionId = (await req.clone().json())?.transcription_id;
  } catch {
    // Malformed body: the handler reports it.
  }
  if (!transcriptionId) return inner(req);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: claims, error: claimsError } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
  if (claimsError || !claims?.claims) return inner(req);
  const userId = claims.claims.sub as string;

  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: transcription } = await admin
    .from("transcriptions")
    .select("*")
    .eq("id", transcriptionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!transcription) return inner(req);

  const uploadId = transcription.upload_id as string;

  if (spec.isDone(transcription)) {
    await finishStep(admin, uploadId, spec.step, true);
    return inner(req);
  }

  // force = true: if the step says "done" but its data is gone (the transcript
  // was edited), the work really is needed again.
  const claim = await claimStep(admin, uploadId, spec.step, true);
  if (claim === "processing") {
    return new Response(JSON.stringify({ success: true, status: "processing" }), {
      status: 200,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }

  let response: Response;
  try {
    response = await inner(req);
  } catch (e) {
    console.error(`${spec.step} crashed:`, e);
    await finishStep(admin, uploadId, spec.step, false, `${STEP_LABEL[spec.step]} failed unexpectedly. Please retry.`);
    throw e;
  }

  if (response.ok) {
    await finishStep(admin, uploadId, spec.step, true);
  } else {
    const body = await response.clone().json().catch(() => null);
    await finishStep(admin, uploadId, spec.step, false, plainStepError(spec.step, response.status, body));
  }
  return response;
};
