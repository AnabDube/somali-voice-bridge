import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import { getCorsHeaders } from "../_shared/cors.ts";

// Exports verified Somali transcripts as JSONL — one row per training sample.
// Format matches what Hugging Face `datasets` library expects for Whisper fine-tuning.
// Admin only.

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // --- Auth: require Bearer token ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } =
      await userClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.claims.sub as string;

    // --- Authorization: admin only ---
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: roleRow } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleRow) {
      return new Response(JSON.stringify({ error: "Forbidden: admin role required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Pull all verified transcripts joined to their audio metadata ---
    const { data: rows, error: queryErr } = await adminClient
      .from("transcriptions")
      .select(`
        id,
        somali_text,
        verified_at,
        audio_uploads (
          id,
          file_path,
          file_name,
          duration_seconds,
          dialect,
          audio_quality,
          speaker_gender,
          speaker_age_range
        )
      `)
      .eq("verified_for_training", true);

    if (queryErr) {
      console.error("Export query error:", queryErr);
      return new Response(JSON.stringify({ error: "Failed to query training data" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Build JSONL: one record per line ---
    // We generate signed URLs (24h) so the training script can fetch each audio file.
    const lines: string[] = [];
    let exported = 0;
    let skipped = 0;

    for (const row of rows ?? []) {
      const upload = (row as any).audio_uploads;
      if (!upload?.file_path || !row.somali_text?.trim()) {
        skipped++;
        continue;
      }

      const { data: signed } = await adminClient.storage
        .from("audio-uploads")
        .createSignedUrl(upload.file_path, 60 * 60 * 24); // 24h

      if (!signed?.signedUrl) {
        skipped++;
        continue;
      }

      lines.push(JSON.stringify({
        audio_url: signed.signedUrl,
        transcription: row.somali_text.trim(),
        language: "so",
        dialect: upload.dialect ?? "standard",
        audio_quality: upload.audio_quality ?? null,
        speaker_gender: upload.speaker_gender ?? null,
        speaker_age_range: upload.speaker_age_range ?? null,
        duration_seconds: upload.duration_seconds ?? null,
        source_id: upload.id,
      }));
      exported++;
    }

    const jsonl = lines.join("\n");

    // Return as downloadable file
    return new Response(jsonl, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="somali-training-data-${new Date().toISOString().slice(0, 10)}.jsonl"`,
        "X-Exported-Count": String(exported),
        "X-Skipped-Count": String(skipped),
      },
    });
  } catch (e) {
    console.error("export-training-data error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
