// Limits for what a user can pick. Long recordings are converted and split in the
// browser (see lib/audioPrep.ts), so the size limit is for the file they choose,
// not what is sent to the server.
export const MAX_AUDIO_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_AUDIO_FILE_MB = MAX_AUDIO_FILE_BYTES / (1024 * 1024);
export const MAX_AUDIO_MINUTES = 120;
export const MAX_AUDIO_SECONDS = MAX_AUDIO_MINUTES * 60;

// Short, small files in a format the transcription service accepts are sent
// as they are. Anything else is converted first. (Groq accepts files up to 25MB.)
export const DIRECT_MAX_BYTES = 20 * 1024 * 1024;
export const DIRECT_MAX_SECONDS = 10 * 60;
const DIRECT_EXTENSIONS = /\.(mp3|wav|m4a|webm|ogg|opus|mp4|flac|mpeg|mpga)$/i;

const ACCEPTED_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
  "audio/x-aac",
  "audio/webm",
  "audio/ogg",
  "audio/opus",
  "audio/flac",
  "audio/x-flac",
  "video/mp4",
  "video/webm",
];
const ACCEPTED_EXTENSIONS = /\.(mp3|wav|m4a|webm|ogg|opus|mp4|aac|flac|mpeg|mpga)$/i;

/** Returns a user-facing error message, or null if the file is acceptable. */
export const validateAudioFile = (file: { name: string; size: number; type: string }): string | null => {
  if (file.size > MAX_AUDIO_FILE_BYTES) {
    return `File too large. Maximum size is ${MAX_AUDIO_FILE_MB}MB.`;
  }
  if (!ACCEPTED_MIME_TYPES.includes(file.type) && !ACCEPTED_EXTENSIONS.test(file.name)) {
    return "Unsupported format. Please upload MP3, WAV, M4A, OGG/OPUS, AAC, MP4 or WebM.";
  }
  return null;
};

/**
 * Length of an audio file as the browser sees it, or 0 when it can't tell (some
 * formats report no length, and some never finish loading).
 */
export const getAudioDuration = (file: Blob): Promise<number> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let finished = false;
    const finish = (seconds: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      audio.removeAttribute("src");
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    };
    const timer = setTimeout(() => finish(0), 8000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish(0);
    audio.src = url;
  });

/**
 * Whether a file has to be converted and split before upload. False for short,
 * small files in a format the transcription service takes directly. An unknown
 * length (the browser could not read it) always means converting, because the
 * length is needed to split and to count minutes.
 */
export const needsPreparation = (file: { name: string; size: number }, durationSec: number): boolean =>
  !DIRECT_EXTENSIONS.test(file.name) ||
  file.size > DIRECT_MAX_BYTES ||
  !(durationSec > 0) ||
  durationSec > DIRECT_MAX_SECONDS;

/** A reason a user can act on, from whatever the storage upload threw. */
export const friendlyUploadError = (error: unknown): string => {
  const message = String((error as { message?: string } | null)?.message ?? error ?? "").toLowerCase();
  if (/exceeded the maximum allowed size|payload too large|too large|413/.test(message)) {
    return "File too large. Please upload a smaller recording.";
  }
  if (/mime type|not supported|unsupported/.test(message)) {
    return "Unsupported format. Please upload MP3, WAV, M4A, OGG/OPUS, AAC, MP4 or WebM.";
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
