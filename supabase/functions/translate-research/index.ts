import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { getCorsHeaders } from "../_shared/cors.ts";

// Research-grade Somali→English translation. Unlike translate-text (which
// produces a single clean natural translation), this version:
//   • preserves cultural context in [square brackets]
//   • flags ambiguities / alternate readings in (parentheses)
//   • keeps paragraph structure and register close to the source
// Writes to `english_text_research`. Prefers cleaned Somali if available.

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
      .select("id, user_id, somali_text, somali_text_cleaned, english_text_research")
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
    if (transcription.english_text_research) {
      return new Response(
        JSON.stringify({ success: true, text: transcription.english_text_research, cached: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const sourceText = transcription.somali_text_cleaned || transcription.somali_text;
    if (!sourceText?.trim()) {
      return new Response(JSON.stringify({ error: "No Somali text to translate" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const startTime = Date.now();

    const systemPrompt =
      "You are a professional Somali-to-English translator producing a RESEARCH-GRADE translation " +
      "for academic and analytical use. Rules:\n" +
      "1. Translate faithfully — preserve tone, register, paragraph structure, and rhetorical style.\n" +
      "2. When a Somali word or phrase carries cultural meaning that doesn't translate cleanly, " +
      "add a brief explanation in [square brackets] immediately after the English. Keep it concise " +
      "(a few words, not a paragraph).\n" +
      "3. When the source is ambiguous or could plausibly be translated multiple ways, give your best " +
      "English rendering and put the alternate reading in (parentheses) right after it.\n" +
      "4. Do NOT add commentary, disclaimers, or a preface. Output ONLY the annotated English translation.\n" +
      "5. If there are no cultural nuances or ambiguities, translate plainly without adding any brackets.";

    const aiResp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: sourceText },
        ],
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      console.error("Groq research translation error:", aiResp.status, errText);

      if (aiResp.status === 429) {
        return new Response(
          JSON.stringify({ error: "rate_limited", message: "Rate limited. Please try again shortly." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ error: "Research translation failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiResult = await aiResp.json();
    const researchText = (aiResult.choices?.[0]?.message?.content || "").trim();

    if (!researchText) {
      return new Response(JSON.stringify({ error: "Empty research translation returned" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const processingTimeMs = Date.now() - startTime;

    const { error: updateErr } = await adminClient
      .from("transcriptions")
      .update({ english_text_research: researchText })
      .eq("id", transcription_id);

    if (updateErr) {
      console.error("Update transcription error:", updateErr);
      return new Response(JSON.stringify({ error: "Failed to save research translation" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ success: true, text: researchText, processing_time_ms: processingTimeMs }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("translate-research error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
