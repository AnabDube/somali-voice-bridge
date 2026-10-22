import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { getCorsHeaders } from "../_shared/cors.ts";
import { groqFetch } from "../_shared/groq.ts";
import { claimStep, finishStep } from "../_shared/steps.ts";
import { toSegment, type WhisperSegment } from "../_shared/transcript.ts";

// Available in the Supabase Edge runtime: keeps the function alive for work
// that continues after the response has been sent.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

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

  // Transcription uses Groq's Whisper endpoint. OpenAI and Azure OpenAI were
  // tried and dropped: Azure's Whisper deployment rejects language="so", which
  // made Somali audio get mis-detected as Arabic.
  const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
  if (!GROQ_API_KEY) {
    return json(500, { error: "GROQ_API_KEY not configured" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Set once this request owns the "transcription" step. From then on every
  // way out must go through failStep() (or finishStep) so the step never stays
  // "processing" with nobody working on it.
  let owned: { admin: SupabaseClient; uploadId: string } | null = null;

  const failStep = async (status: number, body: { error: string; message?: string }, userMessage: string) => {
    if (owned) {
      await finishStep(owned.admin, owned.uploadId, "transcription", false, userMessage);
      await owned.admin.from("audio_uploads").update({ status: "failed" }).eq("id", owned.uploadId);
    }
    return json(status, body);
  };

  try {
    // Validate auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json(401, { error: "Unauthorized" });
    }

    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return json(401, { error: "Unauthorized" });
    }
    const userId = claimsData.claims.sub as string;

    const { upload_id } = await req.json();
    if (!upload_id) {
      return json(400, { error: "upload_id is required" });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Verify the upload belongs to the caller.
    const { data: upload, error: fetchErr } = await adminClient
      .from("audio_uploads")
      .select("*")
      .eq("id", upload_id)
      .eq("user_id", userId)
      .single();

    if (fetchErr || !upload) {
      return json(404, { error: "Upload not found" });
    }

    // Claim the step. A second request while one is running (a double click, a
    // retry racing the original) does nothing, so work and minutes are never doubled.
    let claim = await claimStep(adminClient, upload_id, "transcription");
    if (claim === "done") {
      const { data: existing } = await adminClient
        .from("transcriptions")
        .select("id, somali_text")
        .eq("upload_id", upload_id)
        .maybeSingle();
      if (existing?.somali_text) {
        return json(200, { success: true, cached: true, text: existing.somali_text, transcription_id: existing.id });
      }
      // Marked done but the transcript is missing: do the work again.
      claim = await claimStep(adminClient, upload_id, "transcription", true);
    }
    if (claim !== "claimed") {
      return json(200, { success: true, status: "processing" });
    }
    owned = { admin: adminClient, uploadId: upload_id };

    // Admins bypass the minute limit entirely.
    const { data: adminRoleRow } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    const isAdmin = !!adminRoleRow;

    // Check user's credit/minutes balance (skipped for admins)
    const { data: profile, error: profileErr } = await adminClient
      .from("profiles")
      .select("minutes_used, minutes_limit")
      .eq("user_id", userId)
      .single();

    if (profileErr || !profile) {
      return await failStep(
        404,
        { error: "Profile not found" },
        "Your account profile could not be found. Please sign out and back in.",
      );
    }

    if (!isAdmin) {
      const minutesRemaining = (profile.minutes_limit || 0) - (profile.minutes_used || 0);
      if (minutesRemaining <= 0) {
        return await failStep(
          402,
          {
            error: "no_credits",
            message: "Transcription cannot proceed. No free credits available. Please add credits to continue.",
          },
          "You have no transcription minutes left. Upgrade your plan to continue.",
        );
      }
    }

    // The minute balance is only charged after transcription finishes, so
    // several simultaneous requests could each pass the check above and
    // overdraw the balance. Allow one in-flight transcription per user
    // (ignoring rows stuck in "processing" for over 10 minutes after a crash).
    if (!isAdmin) {
      const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { count: inFlight } = await adminClient
        .from("audio_uploads")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "processing")
        .neq("id", upload_id)
        .gte("updated_at", staleCutoff);

      if ((inFlight ?? 0) > 0) {
        return await failStep(
          429,
          {
            error: "busy",
            message: "Another transcription is still running. Please wait for it to finish, then try again.",
          },
          "Another transcription is still running. Please wait for it to finish, then retry.",
        );
      }
    }

    // Update status to processing
    await adminClient
      .from("audio_uploads")
      .update({ status: "processing" })
      .eq("id", upload_id);

    // Download audio from storage
    const { data: fileData, error: dlErr } = await adminClient.storage
      .from("audio-uploads")
      .download(upload.file_path);

    if (dlErr || !fileData) {
      return await failStep(
        500,
        { error: "Failed to download audio file" },
        "We couldn't read the uploaded file. Please upload it again.",
      );
    }

    // Send to Whisper API (Groq — OpenAI-compatible endpoint)
    const fileName = upload.file_name || "audio.wav";
    const formData = new FormData();
    formData.append("file", new File([fileData], fileName, { type: fileData.type }));
    formData.append("model", "whisper-large-v3");
    formData.append("language", "so"); // Somali
    formData.append("response_format", "verbose_json");

    const whisperResp = await groqFetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: formData,
    });

    if (!whisperResp.ok) {
      const errBody = await whisperResp.text();
      console.error("Whisper API error:", whisperResp.status, errBody);

      if (whisperResp.status === 429 || whisperResp.status === 402) {
        let parsed: { error?: { code?: string; type?: string } } = {};
        try { parsed = JSON.parse(errBody); } catch { /* not JSON */ }
        const isQuota = parsed?.error?.code === "insufficient_quota" || parsed?.error?.type === "insufficient_quota";
        return await failStep(
          whisperResp.status,
          {
            error: isQuota ? "no_credits" : "rate_limited",
            message: isQuota
              ? "Transcription is temporarily unavailable because the speech-recognition service has run out of credits. Please try again later."
              : "Too many requests. Please wait a moment and try again.",
          },
          isQuota
            ? "Transcription is temporarily unavailable. Please try again later."
            : "The transcription service is busy. Please retry in a minute.",
        );
      }

      if (whisperResp.status === 413) {
        return await failStep(
          413,
          {
            error: "file_too_large",
            message: "This audio file is too large to transcribe. Please upload a shorter recording.",
          },
          "This audio file is too large for the transcription service (limit about 25 MB). Please upload a shorter recording.",
        );
      }

      return await failStep(
        500,
        { error: `Whisper API error: ${whisperResp.status}` },
        `The transcription service had a problem (code ${whisperResp.status}). Please retry.`,
      );
    }

    const whisperResult = await whisperResp.json();
    const somaliText = whisperResult.text || "";
    const duration = whisperResult.duration || null;

    // Segment timestamps, plus the confidence measures the transcript workspace uses.
    const segments = ((whisperResult.segments || []) as WhisperSegment[]).map((seg, i) => toSegment(seg, i));

    // Save transcription. Upsert: a retried recording updates its single
    // transcript instead of creating a second one.
    const { data: transcriptionRow, error: insertErr } = await adminClient
      .from("transcriptions")
      .upsert(
        {
          upload_id,
          user_id: userId,
          somali_text: somaliText,
          confidence_score: null,
          speaker_timestamps: segments.length > 0 ? segments : null,
        },
        { onConflict: "upload_id" },
      )
      .select("id")
      .single();

    if (insertErr) {
      console.error("Save transcription error:", insertErr);
      return await failStep(
        500,
        { error: "Failed to save transcription" },
        "We couldn't save the transcript. Please retry.",
      );
    }

    // Update upload status + duration
    await adminClient
      .from("audio_uploads")
      .update({ status: "completed", duration_seconds: duration })
      .eq("id", upload_id);

    // Charge the minutes exactly once per recording. The database function is
    // idempotent, so retries can never double-charge. Admins are recorded too
    // (so their usage is visible); they are just never blocked by the limit.
    const durationMinutes = duration ? Math.ceil(duration / 60) : 1;
    const { error: chargeErr } = await adminClient.rpc("charge_upload_minutes", {
      p_upload: upload_id,
      p_minutes: durationMinutes,
    });
    if (chargeErr) console.error("charge_upload_minutes failed:", chargeErr);

    await finishStep(adminClient, upload_id, "transcription", true);
    owned = null;

    // Everything after transcription (cleaning, translation, summary) runs on
    // the server, so it completes even if the user closes the tab. It is
    // tracked step by step, and none of it blocks access to the transcript.
    await adminClient.rpc("init_pipeline_steps", { p_upload: upload_id });
    const kickoff = fetch(`${supabaseUrl}/functions/v1/run-pipeline`, {
      method: "POST",
      headers: { Authorization: authHeader, apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ upload_id }),
    }).catch((e) => console.error("Could not start run-pipeline:", e));
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(kickoff);

    return json(200, {
      success: true,
      text: somaliText,
      minutes_used: durationMinutes,
      transcription_id: transcriptionRow?.id,
    });
  } catch (e) {
    console.error("transcribe-audio error:", e);
    return await failStep(
      500,
      { error: e instanceof Error ? e.message : "Unknown error" },
      "Transcription failed unexpectedly. Please retry.",
    );
  }
});
