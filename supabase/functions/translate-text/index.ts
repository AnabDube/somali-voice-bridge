import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { getCorsHeaders } from "../_shared/cors.ts";
import { GROQ_CHAT_URL, TEXT_MODEL, groqFetch, reasoningParams } from "../_shared/groq.ts";
import { trackStep } from "../_shared/steps.ts";
import { partsLabel, splitIntoBatches } from "../_shared/transcript.ts";

// The AI service allows about 8,000 tokens a minute, so a transcript up to this
// long is translated in one request and anything longer in batches.
const SINGLE_CALL_MAX_CHARS = 6000;
const BATCH_CHARS = 2500;
const DEFAULT_BUDGET_MS = 100_000;
const MIN_TIME_FOR_BATCH_MS = 25_000;

interface TranslatedPart {
  from: number;
  to: number;
  text: string;
}

const SYSTEM_PROMPT =
  "You are a professional Somali-to-English translator. The input is automatic speech-recognition output of spoken Somali, so it may contain mis-heard words, repetition, and fragments. " +
  "Translate it into clear, natural English as faithfully as you can, preserving the original meaning, tone, and structure. " +
  "When a passage is unintelligible, translate what is recoverable and write [unclear] for the rest. " +
  "NEVER refuse, apologize, or comment on the quality of the text. " +
  "Output ONLY the English translation, nothing else — no preamble, no explanations, no quotes.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const translateChunk = async (
  apiKey: string,
  text: string,
  maxWaitMs = 15_000,
): Promise<{ ok: true; text: string } | { ok: false; status: number }> => {
  const resp = await groqFetch(
    GROQ_CHAT_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TEXT_MODEL,
        ...reasoningParams,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
    },
    3,
    maxWaitMs,
  );
  if (!resp.ok) {
    const status = resp.status;
    console.error("Groq translation error body:", (await resp.text()).slice(0, 300));
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

    // Fetch transcription
    const { data: transcription, error: fetchErr } = await adminClient
      .from("transcriptions")
      .select("*")
      .eq("id", transcription_id)
      .eq("user_id", userId)
      .single();

    if (fetchErr || !transcription) {
      return new Response(JSON.stringify({ error: "Transcription not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!transcription.somali_text) {
      return new Response(JSON.stringify({ error: "No Somali text to translate" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Already translated
    if (transcription.english_text) {
      return new Response(
        JSON.stringify({ success: true, text: transcription.english_text }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const startTime = Date.now();
    const source: string = transcription.somali_text;

    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    const failure = (status: number) => {
      if (status === 429) {
        return respond(429, { error: "rate_limited", message: "Translation rate limited. Please try again shortly." });
      }
      if (status === 402) {
        return respond(402, { error: "no_credits", message: "Translation credits exhausted. Please add credits." });
      }
      return respond(500, { error: "Translation failed" });
    };

    // Long transcripts don't fit the AI service's per-minute limit in one request,
    // so they are translated in batches over several calls (see translateInBatches).
    if (source.length > SINGLE_CALL_MAX_CHARS) {
      const segments = Array.isArray(transcription.speaker_timestamps) ? transcription.speaker_timestamps : null;
      const batches = splitIntoBatches(source, segments, BATCH_CHARS);
      const saved = transcription.translation_progress as { total: number; parts: TranslatedPart[] } | null;

      // Carry on from saved work, but only the leading batches that still match
      // this text (editing the transcript changes the batches).
      const parts: TranslatedPart[] = [];
      if (saved && saved.total === batches.length) {
        for (const p of saved.parts) {
          const b = batches[parts.length];
          if (!b || p.from !== b.from || p.to !== b.to || !p.text) break;
          parts.push(p);
        }
      }

      const deadline = Date.now() + Math.min(Number(budgetMs) || DEFAULT_BUDGET_MS, DEFAULT_BUDGET_MS);
      while (parts.length < batches.length && deadline - Date.now() > MIN_TIME_FOR_BATCH_MS) {
        const batch = batches[parts.length];
        const result = await translateChunk(GROQ_API_KEY, batch.text, Math.min(45_000, deadline - Date.now() - 5_000));
        if (!result.ok) {
          if (result.status === 429) {
            // Out of tokens for this minute. Wait a little, then let the next call carry on.
            await sleep(Math.min(20_000, Math.max(0, deadline - Date.now() - 2_000)));
            break;
          }
          console.error("Groq translation error:", result.status);
          return failure(result.status);
        }
        if (!result.text) return respond(500, { error: "Empty translation returned" });

        parts.push({ from: batch.from, to: batch.to, text: result.text });
        await adminClient
          .from("transcriptions")
          .update({ translation_progress: { total: batches.length, parts } })
          .eq("id", transcription_id);
        await adminClient.rpc("set_step_progress", {
          p_upload: transcription.upload_id,
          p_step: "translation",
          p_progress: partsLabel(parts.length, batches.length),
        });
      }

      if (parts.length < batches.length) {
        return respond(200, { success: true, partial: true, progress: partsLabel(parts.length, batches.length) });
      }

      const joined = parts.map((p) => p.text).join("\n\n");
      const { error: saveErr } = await adminClient
        .from("transcriptions")
        .update({ english_text: joined, processing_time_ms: Date.now() - startTime })
        .eq("id", transcription_id);
      if (saveErr) {
        console.error("Update transcription error:", saveErr);
        return respond(500, { error: "Failed to save translation" });
      }
      return respond(200, { success: true, text: joined, parts: parts.length });
    }

    const single = await translateChunk(GROQ_API_KEY, source);
    const processingTimeMs = Date.now() - startTime;
    if (!single.ok) {
      console.error("Groq translation error:", single.status);
      return failure(single.status);
    }

    const englishText = single.text;
    if (!englishText) {
      return respond(500, { error: "Empty translation returned" });
    }

    // Save translation with actual processing time
    const { error: updateErr } = await adminClient
      .from("transcriptions")
      .update({
        english_text: englishText,
        processing_time_ms: processingTimeMs,
      })
      .eq("id", transcription_id);

    if (updateErr) {
      console.error("Update transcription error:", updateErr);
      return new Response(JSON.stringify({ error: "Failed to save translation" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ success: true, text: englishText, processing_time_ms: processingTimeMs }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("translate error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

serve((req) => trackStep(req, { step: "translation", isDone: (t) => !!t.english_text }, handler));
