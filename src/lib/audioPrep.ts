// Converting and splitting long recordings in the browser, before upload.
//
// Whisper needs only mono 16 kHz audio, and the transcription service rejects
// large files, so a long recording is converted to a small mono MP3 and cut into
// parts of about 8 minutes, each cut placed in the quietest nearby pause.
//
// This uses ffmpeg compiled to WebAssembly (self-hosted from /ffmpeg, loaded
// only when a file actually needs it). The input file is mounted, not copied
// into memory, so a 500 MB recording is read in pieces instead of loaded whole.
// Only the small converted parts (about 3.6 MB per 10 minutes) are held in memory.

import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { MAX_AUDIO_MINUTES, MAX_AUDIO_SECONDS } from "@/lib/audio";
import { parseDuration, parseSilences, planChunks, segmentTimes } from "@/lib/chunking";

export type PrepErrorCode = "cancelled" | "too_long" | "unreadable" | "tools" | "failed";

export class PrepError extends Error {
  constructor(public code: PrepErrorCode, message: string) {
    super(message);
    this.name = "PrepError";
  }
}

export interface PreparedChunk {
  index: number;
  /** Seconds from the start of the recording. */
  start: number;
  duration: number;
  blob: Blob;
  /** The cut before this part could not be placed in a pause. */
  forcedStart: boolean;
}

export interface PreparedAudio {
  durationSeconds: number;
  chunks: PreparedChunk[];
}

export type PrepStage = "tools" | "analysing" | "converting";

export interface PrepProgress {
  stage: PrepStage;
  /** 0 to 100. */
  percent: number;
}

const CORE_URL = "/ffmpeg/ffmpeg-core.js";
const WASM_URL = "/ffmpeg/ffmpeg-core.wasm";

// mono, 16 kHz (all Whisper uses), 48 kbps CBR: 360 KB a minute, 41 MB for 120 minutes.
// No Xing/ID3 headers, so the parts can also be joined byte for byte into one playable file.
const ENCODE_ARGS = ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k"];
const SEGMENT_FORMAT_OPTIONS = "write_xing=0:id3v2_version=0";

let ffmpegPromise: Promise<FFmpeg> | null = null;
let ffmpegInstance: FFmpeg | null = null;

const loadFFmpeg = (onProgress?: (p: PrepProgress) => void): Promise<FFmpeg> => {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const coreURL = await toBlobURL(CORE_URL, "text/javascript");
      const wasmURL = await toBlobURL(WASM_URL, "application/wasm", true, ({ received, total }) => {
        if (total > 0) onProgress?.({ stage: "tools", percent: Math.min(100, (received / total) * 100) });
      });
      await ffmpeg.load({ coreURL, wasmURL });
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })().catch(() => {
      ffmpegPromise = null; // allow a later attempt
      throw new PrepError("tools", "Couldn't load the audio tools. Check your connection and try again.");
    });
  }
  return ffmpegPromise;
};

/** Stop whatever ffmpeg is doing. It has to be reloaded for the next file. */
const resetFFmpeg = () => {
  ffmpegInstance?.terminate();
  ffmpegInstance = null;
  ffmpegPromise = null;
};

const extensionOf = (name: string) => {
  const match = name.match(/\.[A-Za-z0-9]{1,5}$/);
  return match ? match[0].toLowerCase() : "";
};

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Convert a recording to small mono MP3 parts, cut in quiet pauses.
 * Two passes over the audio: find the pauses, then cut and encode.
 */
export const prepareAudio = async (
  file: File,
  options: { signal?: AbortSignal; onProgress?: (progress: PrepProgress) => void } = {},
): Promise<PreparedAudio> => {
  const { signal, onProgress } = options;
  const cancelled = () => new PrepError("cancelled", "Cancelled.");
  if (signal?.aborted) throw cancelled();

  const ffmpeg = await loadFFmpeg(onProgress);
  if (signal?.aborted) throw cancelled();

  const onAbort = () => resetFFmpeg();
  signal?.addEventListener("abort", onAbort);

  const stamp = Date.now();
  const inputDir = `/input-${stamp}`;
  const outputDir = `/output-${stamp}`;
  const inputPath = `${inputDir}/input${extensionOf(file.name)}`;
  let mounted = false;
  let stage: PrepStage = "analysing";

  const log: string[] = [];
  const onLog = ({ message }: { message: string }) => log.push(message);
  const onFfmpegProgress = ({ progress }: { progress: number }) =>
    onProgress?.({ stage, percent: clamp01(progress) * 100 });

  try {
    ffmpeg.on("log", onLog);
    ffmpeg.on("progress", onFfmpegProgress);

    // Mount (not copy) the file so a huge recording is read as needed.
    await ffmpeg.createDir(inputDir);
    await ffmpeg.mount(FFFSType.WORKERFS, { files: [new File([file], `input${extensionOf(file.name)}`, { type: file.type })] }, inputDir);
    mounted = true;
    await ffmpeg.createDir(outputDir);

    // Pass 1: how long is it, and where are the pauses? (decode only, nothing written)
    onProgress?.({ stage: "analysing", percent: 0 });
    const analysis = await ffmpeg.exec(
      ["-hide_banner", "-i", inputPath, "-vn", "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"],
      undefined,
      { signal },
    );
    if (signal?.aborted) throw cancelled();

    const logText = log.join("\n");
    const durationSeconds = parseDuration(logText);
    if (analysis !== 0 || !durationSeconds) {
      throw new PrepError(
        "unreadable",
        "We couldn't read this audio file. Check that it plays on your device, or try another format.",
      );
    }
    if (durationSeconds > MAX_AUDIO_SECONDS) {
      throw new PrepError(
        "too_long",
        `This recording is ${Math.round(durationSeconds / 60)} minutes long. The limit is ${MAX_AUDIO_MINUTES} minutes, so please split it first.`,
      );
    }

    const plan = planChunks(durationSeconds, parseSilences(logText, durationSeconds));

    // Pass 2: cut at the chosen pauses and encode each part.
    stage = "converting";
    onProgress?.({ stage, percent: 0 });
    const output =
      plan.length > 1
        ? ["-f", "segment", "-segment_times", segmentTimes(plan), "-segment_format", "mp3", "-segment_format_options", SEGMENT_FORMAT_OPTIONS, `${outputDir}/part_%03d.mp3`]
        : ["-write_xing", "0", "-id3v2_version", "0", `${outputDir}/part_000.mp3`];

    const conversion = await ffmpeg.exec(["-hide_banner", "-i", inputPath, ...ENCODE_ARGS, ...output], undefined, { signal });
    if (signal?.aborted) throw cancelled();
    if (conversion !== 0) throw new PrepError("failed", "Preparing the audio failed. Please try again, or use a smaller file.");

    const entries = (await ffmpeg.listDir(outputDir)).filter((e) => !e.isDir && /^part_\d+\.mp3$/.test(e.name));
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length !== plan.length) {
      throw new PrepError("failed", "The audio was converted in an unexpected way. Please try again.");
    }

    const chunks: PreparedChunk[] = [];
    for (const [index, entry] of entries.entries()) {
      const data = (await ffmpeg.readFile(`${outputDir}/${entry.name}`)) as Uint8Array;
      chunks.push({
        index,
        start: plan[index].start,
        duration: plan[index].end - plan[index].start,
        blob: new Blob([data], { type: "audio/mpeg" }),
        forcedStart: plan[index].forcedStart,
      });
      await ffmpeg.deleteFile(`${outputDir}/${entry.name}`); // free the memory as we go
    }
    onProgress?.({ stage: "converting", percent: 100 });
    return { durationSeconds, chunks };
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (error instanceof PrepError) throw error;
    console.error("Audio preparation failed:", error);
    throw new PrepError("failed", "Preparing the audio failed. Please try again, or use a smaller file.");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!signal?.aborted && ffmpegInstance === ffmpeg) {
      ffmpeg.off("log", onLog);
      ffmpeg.off("progress", onFfmpegProgress);
      try {
        if (mounted) await ffmpeg.unmount(inputDir);
        await ffmpeg.deleteDir(inputDir);
        await ffmpeg.deleteDir(outputDir);
      } catch {
        // Cleanup only; the next run uses fresh directories.
      }
    }
  }
};
