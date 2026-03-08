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

  const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
  if (!ELEVENLABS_API_KEY) {
    return new Response(JSON.stringify({ error: "ELEVENLABS_API_KEY not configured" }), {
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

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!, {
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

    // Send to ElevenLabs Speech-to-Text API
    const fileName = upload.file_name || "audio.wav";
    const formData = new FormData();
    formData.append("file", new File([fileData], fileName, { type: fileData.type }));
    formData.append("model_id", "scribe_v2");
    formData.append("language_code", "som"); // Somali ISO 639-3
    formData.append("tag_audio_events", "false");
    formData.append("diarize", "false");

    const sttResp = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: formData,
    });

    if (!sttResp.ok) {
      const errText = await sttResp.text();
      console.error("ElevenLabs STT error:", sttResp.status, errText);
      await adminClient.from("audio_uploads").update({ status: "failed" }).eq("id", upload_id);
      return new Response(JSON.stringify({ error: `ElevenLabs STT error: ${sttResp.status}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sttResult = await sttResp.json();
    const somaliText = sttResult.text || "";

    // Calculate duration from word timestamps if available
    let duration = null;
    if (sttResult.words && sttResult.words.length > 0) {
      const lastWord = sttResult.words[sttResult.words.length - 1];
      duration = lastWord.end || null;
    }

    // Save transcription
    const { error: insertErr } = await adminClient.from("transcriptions").insert({
      upload_id,
      user_id: userId,
      somali_text: somaliText,
      confidence_score: null,
    });

    if (insertErr) {
      console.error("Insert transcription error:", insertErr);
      await adminClient.from("audio_uploads").update({ status: "failed" }).eq("id", upload_id);
      return new Response(JSON.stringify({ error: "Failed to save transcription" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update upload status to completed + duration
    await adminClient
      .from("audio_uploads")
      .update({ status: "completed", duration_seconds: duration })
      .eq("id", upload_id);

    return new Response(JSON.stringify({ success: true, text: somaliText }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("transcribe-audio error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
