// Groq's Whisper endpoint rejects larger files (25MB on the free tier). If the
// account is upgraded to a tier with a higher limit, raise this constant.
export const MAX_AUDIO_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_FILE_MB = MAX_AUDIO_FILE_BYTES / (1024 * 1024);

const ACCEPTED_MIME_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
];
const ACCEPTED_EXTENSIONS = /\.(mp3|wav|m4a|webm)$/i;

/** Returns a user-facing error message, or null if the file is acceptable. */
export const validateAudioFile = (file: { name: string; size: number; type: string }): string | null => {
  if (file.size > MAX_AUDIO_FILE_BYTES) {
    return `File too large. Maximum size is ${MAX_AUDIO_FILE_MB}MB.`;
  }
  if (!ACCEPTED_MIME_TYPES.includes(file.type) && !ACCEPTED_EXTENSIONS.test(file.name)) {
    return "Unsupported format. Please upload MP3, WAV, M4A, or WebM.";
  }
  return null;
};

/** A reason a user can act on, from whatever the storage upload threw. */
export const friendlyUploadError = (error: unknown): string => {
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  if (/exceeded the maximum allowed size|payload too large|too large|413/.test(message)) {
    return "File too large. Please upload a smaller recording.";
  }
  if (/mime type|not supported|unsupported/.test(message)) {
    return "Unsupported format. Please upload an MP3, WAV, M4A, or WebM file.";
  }
  if (/failed to fetch|network|load failed|timeout|timed out/.test(message)) {
    return "The upload was interrupted by a network problem. Please check your connection and try again.";
  }
  if (/row-level security|unauthorized|jwt|not authenticated/.test(message)) {
    return "Your session expired. Please sign in again and retry.";
  }
  return "The upload failed. Please try again.";
};

/**
 * Pick a MediaRecorder container the current browser can actually produce.
 * Chrome/Firefox record WebM; Safari records MP4.
 */
export const pickRecorderMimeType = (
  isSupported: (type: string) => boolean = (t) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
): string => {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((t) => isSupported(t)) ?? "audio/webm";
};

/** File extension for a recorded blob's MIME type (parameters like ;codecs= are ignored). */
export const extensionForMime = (mime: string): string => {
  const base = mime.split(";")[0].trim().toLowerCase();
  if (base === "audio/mp4" || base === "audio/x-m4a") return "m4a";
  if (base === "audio/mpeg") return "mp3";
  if (base === "audio/wav" || base === "audio/x-wav") return "wav";
  return "webm";
};
