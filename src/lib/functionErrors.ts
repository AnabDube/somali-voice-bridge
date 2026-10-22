/**
 * Edge functions answer failures with JSON like { error: "busy", message: "…" }.
 * supabase-js wraps that in an error whose `context` is the raw Response.
 * Returns the human-readable `message` if there is one, otherwise null.
 */
export const readFunctionError = async (error: unknown): Promise<string | null> => {
  const context = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== "undefined" && context instanceof Response) {
    try {
      const body = await context.clone().json();
      return typeof body?.message === "string" ? body.message : null;
    } catch {
      return null;
    }
  }
  return null;
};
