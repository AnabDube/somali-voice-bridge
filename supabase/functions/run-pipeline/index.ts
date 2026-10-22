import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { getCorsHeaders } from "../_shared/cors.ts";

// Runs the steps that follow transcription for one recording, on the server:
//   translation  ->  cleaning + research translation  ->  summary
// Used right after transcription finishes, after the user edits a transcript,
// and by the Retry buttons ({ upload_id, step } retries just that step).
//
// Each step function is idempotent and tracks its own status (see
// _shared/steps.ts), so calling this twice, or while a step is already
// running, never repeats work. A failing step never stops the others.

type PipelineStep = "translation" | "cleaning" | "research" | "summary";

const FUNCTION_FOR_STEP: Record<PipelineStep, string> = {
  translation: "translate-text",
  cleaning: "process-transcript",
  research: "translate-research",
  summary: "generate-summary",
};

const isPipelineStep = (value: unknown): value is PipelineStep =>
  typeof value === "string" && value in FUNCTION_FOR_STEP;

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

    const callStep = async (name: PipelineStep): Promise<boolean> => {
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/${FUNCTION_FOR_STEP[name]}`, {
          method: "POST",
          headers: { Authorization: authHeader, apikey: anonKey, "Content-Type": "application/json" },
          body: JSON.stringify({ transcription_id: transcription.id }),
        });
        await resp.body?.cancel();
        return resp.ok;
      } catch (e) {
        console.error(`run-pipeline: ${name} request failed`, e);
        return false;
      }
    };

    const results: Partial<Record<PipelineStep, boolean>> = {};

    // The summary reads the English translation, so it runs after translation.
    const runSummaryIfNeeded = async () => {
      const { data: summaryStep } = await admin
        .from("processing_steps")
        .select("status")
        .eq("upload_id", upload_id)
        .eq("step", "summary")
        .maybeSingle();
      if (summaryStep?.status !== "done") results.summary = await callStep("summary");
    };

    // The summary can't run without an English text. If neither translation
    // produced one, fail the queued summary now with a clear reason, rather
    // than leaving it "pending" until the watchdog gives up on it.
    const failSummaryWaitingOnTranslation = async () => {
      const { data: summaryStep } = await admin
        .from("processing_steps")
        .select("status")
        .eq("upload_id", upload_id)
        .eq("step", "summary")
        .maybeSingle();
      if (summaryStep?.status === "pending") {
        await admin.rpc("finish_step", {
          p_upload: upload_id,
          p_step: "summary",
          p_ok: false,
          p_error: "The summary needs the English translation first. Retry the translation and the summary will follow.",
        });
      }
    };

    if (step) {
      results[step as PipelineStep] = await callStep(step as PipelineStep);
      // Retrying a step that the summary depends on: bring the summary along
      // if it hasn't been produced yet. It is never re-run once done.
      if ((step === "translation" || step === "research") && results[step as PipelineStep]) {
        await runSummaryIfNeeded();
      }
    } else {
      results.translation = await callStep("translation");
      [results.cleaning, results.research] = await Promise.all([callStep("cleaning"), callStep("research")]);
      if (results.translation || results.research) await runSummaryIfNeeded();
      else await failSummaryWaitingOnTranslation();
    }

    return json(200, { success: true, results });
  } catch (e) {
    console.error("run-pipeline error:", e);
    return json(500, { error: e instanceof Error ? e.message : "Unknown error" });
  }
});
