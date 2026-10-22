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
