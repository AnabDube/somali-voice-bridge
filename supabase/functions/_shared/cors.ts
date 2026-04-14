// Shared CORS helper for all edge functions.
// Reads ALLOWED_ORIGINS (comma-separated list) and echoes the request's
// Origin header back if it's in the allowlist. Falls back to legacy
// ALLOWED_ORIGIN (single value) if set.

const baseHeaders = {
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  Vary: "Origin",
};

function parseAllowedOrigins(): string[] {
  const multi = Deno.env.get("ALLOWED_ORIGINS");
  if (multi) {
    return multi.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const single = Deno.env.get("ALLOWED_ORIGIN");
  if (single) return [single.trim()];
  return [];
}

export function getCorsHeaders(req: Request): Record<string, string> {
  const allowed = parseAllowedOrigins();
  const origin = req.headers.get("Origin") || "";

  // If no allowlist is configured at all, fail closed (no CORS).
  if (allowed.length === 0) {
    return baseHeaders;
  }

  // If the request Origin is in the allowlist, echo it back.
  if (allowed.includes(origin)) {
    return { ...baseHeaders, "Access-Control-Allow-Origin": origin };
  }

  // Unknown origin — return headers without Allow-Origin so browsers reject it.
  return baseHeaders;
}
