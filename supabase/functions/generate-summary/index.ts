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

import { GROQ_CHAT_URL as GROQ_URL, TEXT_MODEL as MODEL, groqFetch, reasoningParams } from "../_shared/groq.ts";
import { trackStep } from "../_shared/steps.ts";
import { partsLabel, splitIntoBatches } from "../_shared/transcript.ts";

// The AI service allows about 8,000 tokens a minute. Translations up to this
// long are summarised in one request; longer ones block by block.
const SINGLE_CALL_MAX_CHARS = 6000;
const BLOCK_CHARS = 5000;
const MAX_NOTES_CHARS = 9000;
const DEFAULT_BUDGET_MS = 100_000;
const MIN_TIME_FOR_CALL_MS = 25_000;

const NOTES_SYSTEM =
  "You are a research assistant. The text is one part of an English translation of a long Somali audio recording. " +
  "Write 4 to 6 concise bullet points (at most 35 words each) capturing the key facts, names, places, numbers, decisions, " +
  "and any strongly worded statements. Output only the bullet points.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const chat = async (
  apiKey: string,
  system: string,
  user: string,
  options: { json?: boolean; temperature?: number; maxWaitMs?: number } = {},
): Promise<{ ok: true; text: string } | { ok: false; status: number }> => {
  const resp = await groqFetch(
    GROQ_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        ...reasoningParams,
        temperature: options.temperature ?? 0.2,
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
    3,
    options.maxWaitMs ?? 15_000,
  );
  if (!resp.ok) {
    const status = resp.status;
    console.error("Groq error body:", (await resp.text()).slice(0, 300));
    return { ok: false, status };
  }
  const result = await resp.json();
  return { ok: true, text: (result.choices?.[0]?.message?.content ?? "").trim() };
};

const handler = async (req: Request): Promise<Response> => {
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

    const { transcription_id, budget_ms: budgetMs } = await req.json();
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
        "id, upload_id, user_id, somali_text, somali_text_cleaned, english_text, english_text_research, research_summary, terminology, summary_notes"
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

    // Idempotent. The terminology glossary is a bonus: if only that part failed
    // before, don't regenerate the whole summary every time.
    if (transcription.research_summary) {
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

    // Long recordings: the whole translation doesn't fit one request within the AI
    // service's per-minute limit, so summarise it block by block (notes), then
    // write the final summary from the notes. Progress is saved between calls.
    if (englishSource.length > SINGLE_CALL_MAX_CHARS) {
      const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      const failure = (status: number) =>
        status === 429
          ? respond(429, { error: "rate_limited", message: "The AI service is busy. Please try again shortly." })
          : status === 402
          ? respond(402, { error: "no_credits", message: "The AI service is out of credits. Please try again later." })
          : respond(500, { error: "Summary generation failed" });

      const blocks = splitIntoBatches(englishSource, null, BLOCK_CHARS);
      const saved = transcription.summary_notes as { total: number; notes: string[] } | null;
      const notes: string[] = saved && saved.total === blocks.length ? [...saved.notes] : [];
      const deadline = Date.now() + Math.min(Number(budgetMs) || DEFAULT_BUDGET_MS, DEFAULT_BUDGET_MS);

      while (notes.length < blocks.length && deadline - Date.now() > MIN_TIME_FOR_CALL_MS) {
        const result = await chat(GROQ_API_KEY, NOTES_SYSTEM, blocks[notes.length].text, {
          maxWaitMs: Math.min(45_000, deadline - Date.now() - 5_000),
        });
        if (!result.ok) {
          if (result.status === 429) {
            await sleep(Math.min(20_000, Math.max(0, deadline - Date.now() - 2_000)));
            break;
          }
          console.error("Groq notes error:", result.status);
          return failure(result.status);
        }
        notes.push(result.text);
        await adminClient
          .from("transcriptions")
          .update({ summary_notes: { total: blocks.length, notes } })
          .eq("id", transcription_id);
        await adminClient.rpc("set_step_progress", {
          p_upload: transcription.upload_id,
          p_step: "summary",
          p_progress: partsLabel(notes.length, blocks.length),
        });
      }

      if (notes.length < blocks.length) {
        return respond(200, { success: true, partial: true, progress: partsLabel(notes.length, blocks.length) });
      }

      // Keep the final request small enough for one call, however long the recording was.
      const perNote = Math.floor(MAX_NOTES_CHARS / notes.length);
      const combined = notes.map((n, i) => `Part ${i + 1} of ${notes.length}:\n${n.slice(0, perNote)}`).join("\n\n");
      const final = await chat(GROQ_API_KEY, summarySystem, combined, {
        json: true,
        temperature: 0.3,
        maxWaitMs: Math.min(45_000, Math.max(5_000, deadline - Date.now() - 5_000)),
      });
      if (!final.ok) {
        console.error("Groq final summary error:", final.status);
        return failure(final.status);
      }
      let longSummary: unknown;
      try {
        longSummary = JSON.parse(final.text);
      } catch (e) {
        console.error("Failed to parse summary JSON:", e, final.text.slice(0, 200));
        return respond(500, { error: "Summary returned invalid JSON" });
      }

      const { error: saveErr } = await adminClient
        .from("transcriptions")
        .update({
          research_summary: longSummary,
          terminology: null, // the glossary is skipped for long recordings
          processing_stage: "done",
          summary_notes: null,
        })
        .eq("id", transcription_id);
      if (saveErr) {
        console.error("Update transcription error:", saveErr);
        return respond(500, { error: "Failed to save summary" });
      }
      return respond(200, { success: true, research_summary: longSummary, terminology: null });
    }

    // Run summary + terminology in parallel — they don't depend on each other.
    const [summaryResp, terminologyResp] = await Promise.all([
      groqFetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          ...reasoningParams,
          temperature: 0.3,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: summarySystem },
            { role: "user", content: englishSource },
          ],
        }),
      }),
      groqFetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          ...reasoningParams,
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
      }),
    ]);

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
};

serve((req) => trackStep(req, { step: "summary", isDone: (t) => !!t.research_summary }, handler));
