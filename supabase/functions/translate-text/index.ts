import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { getCorsHeaders } from "../_shared/cors.ts";
import { GROQ_CHAT_URL, TEXT_MODEL, groqFetch, reasoningParams } from "../_shared/groq.ts";
import { trackStep } from "../_shared/steps.ts";
import { partsLabel, splitIntoBatches } from "../_shared/transcript.ts";

// Translates the transcript into English in SECTIONS: runs of consecutive
// segments of about 1,200 characters (roughly a minute or two of speech).
//
// Why sections instead of one translation per segment: a good translation
// reorders and merges clauses, so forcing it into a one-to-one match with
// 10-second segments would make it worse. A section is long enough to
// translate well and short enough to line up with the Somali beside it, and each
// section remembers which segments (from..to) it covers.
//
// Also: the AI service allows about 8,000 tokens a minute, so a long transcript
// is translated across several calls; progress is saved after every section.
//
// After the transcript is edited, one section can be re-translated on its own
// by passing { section: n }.

const BATCH_CHARS = 1200;
const DEFAULT_BUDGET_MS = 100_000;
const MIN_TIME_FOR_BATCH_MS = 25_000;

interface TranslatedPart {
  /** First and last segment (by idx) this section covers. */
  from: number;
  to: number;
  text: string;
  /** When it was translated, so edits made after that can be flagged as out of date. */
  at?: string;
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

  const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
  if (!GROQ_API_KEY) {
    return respond(500, { error: "GROQ_API_KEY not configured" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return respond(401, { error: "Unauthorized" });
    }

    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return respond(401, { error: "Unauthorized" });
    }
    const userId = claimsData.claims.sub as string;

    const { transcription_id, budget_ms: budgetMs, section } = await req.json();
    if (!transcription_id) {
      return respond(400, { error: "transcription_id is required" });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: transcription, error: fetchErr } = await adminClient
      .from("transcriptions")
      .select("*")
      .eq("id", transcription_id)
      .eq("user_id", userId)
      .single();

    if (fetchErr || !transcription) {
      return respond(404, { error: "Transcription not found" });
    }
    if (!transcription.somali_text) {
      return respond(400, { error: "No Somali text to translate" });
    }

    const isSectionRetry = Number.isInteger(section);

    // Already translated (a section re-translation is the exception: it redoes one part).
    if (transcription.english_text && !isSectionRetry) {
      return respond(200, { success: true, text: transcription.english_text });
    }

    // The segments are the source of truth for the (possibly corrected) text.
    await adminClient.rpc("ensure_segments", { p_transcription: transcription_id });
    const { data: segmentRows } = await adminClient
      .from("transcript_segments")
      .select("idx, text")
      .eq("transcription_id", transcription_id)
      .order("idx");
    const segments = (segmentRows ?? []) as { idx: number; text: string }[];
    if (segments.length === 0) {
      return respond(400, { error: "No Somali text to translate" });
    }

    const saved = transcription.translation_progress as { total: number; parts: TranslatedPart[] } | null;

    // ------------------------------------------------ re-translate one section
    if (isSectionRetry) {
      const part = saved?.parts?.[section];
      if (!saved || !part) {
        return respond(404, { error: "Section not found" });
      }
      const sectionText = segments
        .filter((s) => s.idx >= part.from && s.idx <= part.to && s.text)
        .map((s) => s.text)
        .join(" ");
      if (!sectionText.trim()) {
        return respond(400, { error: "No Somali text to translate" });
      }

      const result = await translateChunk(GROQ_API_KEY, sectionText, 45_000);
      if (!result.ok) return failure(result.status);
      if (!result.text) return respond(500, { error: "Empty translation returned" });

      const parts = saved.parts.map((p, i) => (i === section ? { ...p, text: result.text, at: new Date().toISOString() } : p));
      const { error: saveErr } = await adminClient
        .from("transcriptions")
        .update({
          translation_progress: { total: saved.total, parts },
          english_text: parts.map((p) => p.text).join("\n\n"),
        })
        .eq("id", transcription_id);
      if (saveErr) {
        console.error("Update transcription error:", saveErr);
        return respond(500, { error: "Failed to save translation" });
      }
      return respond(200, { success: true, section, text: result.text });
    }

    // ------------------------------------------------ translate everything, section by section
    const startTime = Date.now();
    const batches = splitIntoBatches("", segments, BATCH_CHARS);
    if (batches.length === 0) {
      return respond(400, { error: "No Somali text to translate" });
    }

    // Carry on from saved work, but only the leading sections that still cover the same segments.
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
        return failure(result.status);
      }
      if (!result.text) return respond(500, { error: "Empty translation returned" });

      parts.push({ from: batch.from, to: batch.to, text: result.text, at: new Date().toISOString() });
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

    const englishText = parts.map((p) => p.text).join("\n\n");
    const { error: updateErr } = await adminClient
      .from("transcriptions")
      .update({ english_text: englishText, processing_time_ms: Date.now() - startTime })
      .eq("id", transcription_id);
    if (updateErr) {
      console.error("Update transcription error:", updateErr);
      return respond(500, { error: "Failed to save translation" });
    }

    return respond(200, { success: true, text: englishText, sections: parts.length });
  } catch (e) {
    console.error("translate error:", e);
    return respond(500, { error: e instanceof Error ? e.message : "Unknown error" });
  }
};

serve((req) => trackStep(req, { step: "translation", isDone: (t) => !!t.english_text }, handler));
