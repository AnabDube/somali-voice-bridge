// Shared Groq chat-completions settings for every text step of the pipeline
// (cleaning, translation, research translation, summary).
//
// Groq retires models from time to time (llama-3.3-70b-versatile was removed,
// which silently broke every step after transcription). To switch models
// without a code change, set the GROQ_TEXT_MODEL secret:
//   supabase secrets set GROQ_TEXT_MODEL=<model id from https://api.groq.com/openai/v1/models>
export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

export const TEXT_MODEL = Deno.env.get("GROQ_TEXT_MODEL") || "openai/gpt-oss-120b";

// gpt-oss models are reasoning models. "low" keeps latency down and the reasoning
// itself comes back in a separate field, so message.content stays clean.
export const reasoningParams: Record<string, string> = TEXT_MODEL.startsWith("openai/gpt-oss")
  ? { reasoning_effort: "low" }
  : {};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch() for Groq that rides out rate limits. The free tier allows only a few
 * requests / tokens per minute, so a burst of pipeline steps can get HTTP 429.
 * Retries 429 and 5xx with backoff (honouring Retry-After, capped), then
 * returns the last response so callers keep their existing error handling.
 * The body must be re-sendable (a string or FormData), which ours always are.
 */
export const groqFetch = async (url: string, init: RequestInit, attempts = 3): Promise<Response> => {
  let response: Response | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    response = await fetch(url, init);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts - 1) return response;

    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt, 15000);
    console.warn(`Groq returned ${response.status}; retrying in ${waitMs}ms (attempt ${attempt + 1}/${attempts})`);
    await response.body?.cancel();
    await sleep(waitMs);
  }
  return response!;
};
