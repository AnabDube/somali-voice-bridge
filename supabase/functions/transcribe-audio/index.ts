import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    // Validate auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.claims.sub as string;

    const { upload_id } = await req.json();
    if (!upload_id) {
      return new Response(JSON.stringify({ error: "upload_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Check user's credit/minutes balance
    const { data: profile, error: profileErr } = await adminClient
      .from("profiles")
      .select("minutes_used, minutes_limit")
      .eq("user_id", userId)
      .single();

    if (profileErr || !profile) {
      return new Response(JSON.stringify({ error: "Profile not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const minutesRemaining = (profile.minutes_limit || 0) - (profile.minutes_used || 0);
    if (minutesRemaining <= 0) {
      return new Response(
        JSON.stringify({
          error: "no_credits",
          message: "Transcription cannot proceed. No free credits available. Please add credits to continue.",
        }),
        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify the upload belongs to user
    const { data: upload, error: fetchErr } = await adminClient
      .from("audio_uploads")
      .select("*")
      .eq("id", upload_id)
      .eq("user_id", userId)
      .single();

    if (fetchErr || !upload) {
      return new Response(JSON.stringify({ error: "Upload not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
      await adminClient.from("audio_uploads").update({ status: "failed" }).eq("id", upload_id);
      return new Response(JSON.stringify({ error: "Failed to download audio file" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Send to Whisper API
    const fileName = upload.file_name || "audio.wav";
    const formData = new FormData();
    formData.append("file", new File([fileData], fileName, { type: fileData.type }));
    formData.append("model", "whisper-1");
    formData.append("language", "so"); // Somali
    formData.append("response_format", "verbose_json");

    const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    });

    if (!whisperResp.ok) {
      const errBody = await whisperResp.text();
      console.error("Whisper API error:", whisperResp.status, errBody);
      await adminClient.from("audio_uploads").update({ status: "failed" }).eq("id", upload_id);

      // Handle quota/billing errors specifically
      if (whisperResp.status === 429 || whisperResp.status === 402) {
        let parsed: any = {};
        try { parsed = JSON.parse(errBody); } catch {}
        const isQuota = parsed?.error?.code === "insufficient_quota" || parsed?.error?.type === "insufficient_quota";
        return new Response(
          JSON.stringify({
            error: isQuota ? "no_credits" : "rate_limited",
            message: isQuota
              ? "Transcription cannot proceed. No free credits available on the OpenAI account. Please add credits to continue."
              : "Too many requests. Please wait a moment and try again.",
          }),
          { status: whisperResp.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ error: `Whisper API error: ${whisperResp.status}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const whisperResult = await whisperResp.json();
    const somaliText = whisperResult.text || "";
    const duration = whisperResult.duration || null;

    // Save transcription
    const { data: transcriptionRow, error: insertErr } = await adminClient.from("transcriptions").insert({
      upload_id,
      user_id: userId,
      somali_text: somaliText,
      confidence_score: null,
    }).select("id").single();

    if (insertErr) {
      console.error("Insert transcription error:", insertErr);
      await adminClient.from("audio_uploads").update({ status: "failed" }).eq("id", upload_id);
      return new Response(JSON.stringify({ error: "Failed to save transcription" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update upload status + duration
    await adminClient
      .from("audio_uploads")
      .update({ status: "completed", duration_seconds: duration })
      .eq("id", upload_id);

    // Update user's minutes_used
    const durationMinutes = duration ? Math.ceil(duration / 60) : 1;
    await adminClient
      .from("profiles")
      .update({ minutes_used: (profile.minutes_used || 0) + durationMinutes })
      .eq("user_id", userId);

    return new Response(
      JSON.stringify({
        success: true,
        text: somaliText,
        minutes_used: durationMinutes,
        transcription_id: transcriptionRow?.id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("transcribe-audio error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
