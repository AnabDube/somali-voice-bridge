const NETWORK_ERROR = /failed to fetch|networkerror|network request failed|load failed|fetch failed/i;

/**
 * supabase-js reports an unreachable server (offline, DNS failure, paused
 * project) as a bare "Failed to fetch". Turn that into something a user can act on.
 */
export const friendlyAuthError = (error: { message?: string; name?: string } | unknown): string => {
  const { message = "", name = "" } = (error ?? {}) as { message?: string; name?: string };
  if (name === "AuthRetryableFetchError" || NETWORK_ERROR.test(message)) {
    return "Can't reach the server. Check your internet connection and try again in a moment.";
  }
  return message || "Something went wrong. Please try again.";
};
