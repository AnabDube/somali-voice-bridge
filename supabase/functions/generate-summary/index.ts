import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { getCorsHeaders } from "../_shared/cors.ts";

// Produces a structured research summary + terminology glossary for a
// transcribed audio. Two Groq calls, both using JSON mode:
//   1. Summary: overview, key themes, notable quotes, action points.
//   2. Terminology: proper nouns, domain terms, mis-transcription flags
//      (with confidence).
// Prefers the research translation if available, otherwise the standard
// translation. Writes to `research_summary` and `terminology`.

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
      .select(
        "id, user_id, somali_text, somali_text_cleaned, english_text, english_text_research, research_summary, terminology"
      )
      .eq("id", transcription_id)
      .eq("user_id", userId)
      .single();

    if (fetchErr || !transcription) {
      return new Response(JSON.stringify({ error: "Transcription not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotent
    if (transcription.research_summary && transcription.terminology) {
      return new Response(
        JSON.stringify({
          success: true,
          research_summary: transcription.research_summary,
          terminology: transcription.terminology,
          cached: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const englishSource = transcription.english_text_research || transcription.english_text;
    const somaliSource = transcription.somali_text_cleaned || transcription.somali_text;

    if (!englishSource?.trim()) {
      return new Response(JSON.stringify({ error: "No English translation to summarize" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Call 1: structured summary ---
    const summarySystem =
      "You are a research analyst. Produce a structured analytical summary of the given " +
      "English translation of a Somali audio transcript. Focus on accuracy, not flattery.\n\n" +
      "Respond with a JSON object of exactly this shape:\n" +
      "{\n" +
      '  "overview": "<2-4 sentence neutral summary of what the audio is about>",\n' +
      '  "key_themes": ["<theme 1>", "<theme 2>", ...],  // 3-6 themes, short phrases\n' +
      '  "notable_quotes": [ { "quote": "<direct English quote from the translation>", "context": "<why it matters, one line>" }, ... ],  // 2-5 quotes\n' +
      '  "action_points": ["<concrete action item or next step mentioned>", ...]  // empty array if none\n' +
      "}\n\n" +
      "Do NOT include commentary outside the JSON. Do NOT wrap in markdown fences. " +
      "Keep language neutral and factual.";

    const summaryResp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: summarySystem },
          { role: "user", content: englishSource },
        ],
      }),
    });

    if (!summaryResp.ok) {
      const errText = await summaryResp.text();
      console.error("Groq summary error:", summaryResp.status, errText);
      return new Response(JSON.stringify({ error: "Summary generation failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const summaryJson = await summaryResp.json();
    const summaryRaw = summaryJson.choices?.[0]?.message?.content || "";
    let researchSummary: any = null;
    try {
      researchSummary = JSON.parse(summaryRaw);
    } catch (e) {
      console.error("Failed to parse summary JSON:", e, summaryRaw.slice(0, 200));
      return new Response(JSON.stringify({ error: "Summary returned invalid JSON" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Call 2: terminology glossary ---
    const terminologySystem =
      "You are a terminology specialist analyzing a Somali audio transcript paired with its " +
      "English translation. Extract a glossary of important terms.\n\n" +
      "Respond with a JSON object of exactly this shape:\n" +
      "{\n" +
      '  "proper_nouns": [ { "somali": "<as written in Somali>", "english": "<english rendering or transliteration>", "type": "person" | "place" | "organization" | "other" }, ... ],\n' +
      '  "domain_terms": [ { "somali": "<somali word or phrase>", "english": "<english translation>", "definition": "<one-line definition>" }, ... ],\n' +
      '  "flags": [ { "somali": "<suspicious somali word>", "issue": "<what seems wrong — e.g. likely mis-transcription, unusual spelling, possible loan word>", "confidence": "low" | "medium" | "high" }, ... ]\n' +
      "}\n\n" +
      "Keep each list short — only genuinely notable items. If a category has nothing, use an empty array. " +
      "Do NOT wrap the JSON in markdown fences. Do NOT add commentary.";

    const terminologyResp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: terminologySystem },
          {
            role: "user",
            content: `SOMALI:\n${somaliSource}\n\nENGLISH:\n${englishSource}`,
          },
        ],
      }),
    });

    let terminology: any = null;
    if (terminologyResp.ok) {
      const termJson = await terminologyResp.json();
      const termRaw = termJson.choices?.[0]?.message?.content || "";
      try {
        terminology = JSON.parse(termRaw);
      } catch (e) {
        console.error("Failed to parse terminology JSON:", e, termRaw.slice(0, 200));
      }
    } else {
      console.error("Groq terminology error:", terminologyResp.status, await terminologyResp.text());
    }

    const { error: updateErr } = await adminClient
      .from("transcriptions")
      .update({
        research_summary: researchSummary,
        terminology: terminology,
        processing_stage: "done",
      })
      .eq("id", transcription_id);

    if (updateErr) {
      console.error("Update transcription error:", updateErr);
      return new Response(JSON.stringify({ error: "Failed to save summary" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        research_summary: researchSummary,
        terminology: terminology,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("generate-summary error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
