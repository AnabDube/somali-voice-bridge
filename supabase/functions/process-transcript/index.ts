import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { getCorsHeaders } from "../_shared/cors.ts";

// Cleans raw Whisper output: fixes mis-heard words, adds punctuation /
// paragraph breaks, and detects speaker changes from timestamped segments.
// Writes `somali_text_cleaned` and `speaker_segments`.
// Currently uses Groq (llama-3.3-70b-versatile). Swap to Anthropic later
// for higher-quality cleaning by replacing the two fetch calls below.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
  if (!GROQ_API_KEY) {
    return new Response(JSON.stringify({ error: "GROQ_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
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

    const { transcription_id } = await req.json();
    if (!transcription_id) {
      return new Response(JSON.stringify({ error: "transcription_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: transcription, error: fetchErr } = await adminClient
      .from("transcriptions")
      .select("id, user_id, somali_text, somali_text_cleaned, speaker_timestamps, speaker_segments")
      .eq("id", transcription_id)
      .eq("user_id", userId)
      .single();

    if (fetchErr || !transcription) {
      return new Response(JSON.stringify({ error: "Transcription not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!transcription.somali_text?.trim()) {
      return new Response(JSON.stringify({ error: "No Somali text to process" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotent — if already processed, return early.
    if (transcription.somali_text_cleaned) {
      return new Response(
        JSON.stringify({
          success: true,
          cleaned: transcription.somali_text_cleaned,
          speaker_segments: transcription.speaker_segments,
          cached: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await adminClient
      .from("transcriptions")
      .update({ processing_stage: "cleaning" })
      .eq("id", transcription_id);

    // --- Call 1: clean the transcript ---
    const cleanSystem =
      "You are an expert Somali linguist cleaning raw speech-to-text output. " +
      "Your job: fix obvious mis-heard words, add natural punctuation and paragraph breaks, " +
      "and normalize spelling — while preserving the speaker's original meaning, tone, and any " +
      "dialectal choices. Do not translate. Do not summarize. Do not add commentary. " +
      "Output ONLY the cleaned Somali text, nothing else — no preamble, no explanations, no quotes.";

    const cleanResp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: cleanSystem },
          { role: "user", content: transcription.somali_text },
        ],
      }),
    });

    if (!cleanResp.ok) {
      const errText = await cleanResp.text();
      console.error("Groq clean error:", cleanResp.status, errText);
      await adminClient
        .from("transcriptions")
        .update({ processing_stage: "failed" })
        .eq("id", transcription_id);
      return new Response(
        JSON.stringify({ error: `Cleaning failed: ${cleanResp.status}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const cleanJson = await cleanResp.json();
    const cleanedText = (cleanJson.choices?.[0]?.message?.content || "").trim();

    if (!cleanedText) {
      return new Response(JSON.stringify({ error: "Empty cleaned transcript returned" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Call 2: speaker detection (only if we have timestamped segments) ---
    let speakerSegments: any = null;
    const raw = transcription.speaker_timestamps;
    const segments: Array<{ start: number; end: number; text: string }> = Array.isArray(raw)
      ? raw.filter((s: any) => typeof s?.start === "number" && typeof s?.end === "number" && s?.text)
      : [];

    if (segments.length > 1) {
      const segmentsForPrompt = segments.map((s, i) => ({
        i,
        start: s.start,
        end: s.end,
        text: s.text,
      }));

      const speakerSystem =
        "You analyze timestamped Somali speech segments and group them by speaker. " +
        "Use linguistic cues — tone, vocabulary, register, pronouns, and sudden topical shifts — " +
        "to infer when a different person is speaking. You do NOT have voiceprints; base your " +
        "judgement only on the text.\n\n" +
        'Respond with a JSON object of the form: { "assignments": [{ "i": <segment index>, "speaker": "Speaker 1" }, ...] }. ' +
        "Include one entry per input segment, in order. If you cannot distinguish speakers " +
        'with any confidence, label every segment "Speaker 1".';

      const speakerResp = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: speakerSystem },
            { role: "user", content: JSON.stringify(segmentsForPrompt) },
          ],
        }),
      });

      if (speakerResp.ok) {
        const speakerJson = await speakerResp.json();
        const raw = speakerJson.choices?.[0]?.message?.content || "";
        try {
          const parsed = JSON.parse(raw);
          const assignments = Array.isArray(parsed?.assignments) ? parsed.assignments : null;
          if (assignments) {
            speakerSegments = segments.map((seg, i) => ({
              start: seg.start,
              end: seg.end,
              text: seg.text,
              speaker: assignments.find((p: any) => p.i === i)?.speaker ?? "Speaker 1",
            }));
          }
        } catch (e) {
          console.error("Failed to parse speaker JSON:", e, raw.slice(0, 200));
        }
      } else {
        console.error("Groq speaker error:", speakerResp.status, await speakerResp.text());
      }
    }

    const { error: updateErr } = await adminClient
      .from("transcriptions")
      .update({
        somali_text_cleaned: cleanedText,
        speaker_segments: speakerSegments,
        processing_stage: "cleaned",
      })
      .eq("id", transcription_id);

    if (updateErr) {
      console.error("Update transcription error:", updateErr);
      return new Response(JSON.stringify({ error: "Failed to save cleaned transcript" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        cleaned: cleanedText,
        speaker_segments: speakerSegments,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("process-transcript error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
