// Planning how to split a long recording into parts for transcription.
//
// Whisper works best on a few minutes of audio at a time, and the transcription
// service rejects large files, so long recordings are cut into parts of about
// 8 minutes. Each cut is placed in the quietest pause near the boundary, so a
// word is never sliced in half. Pure functions only (no browser APIs), so the
// planning is easy to test.

export interface Silence {
  start: number;
  end: number;
}

export interface ChunkPlan {
  index: number;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  /** True when no pause was found near the boundary, so the cut had to be arbitrary. */
  forcedStart: boolean;
}

export const CHUNK_TARGET_SECONDS = 8 * 60;
/** Recordings up to this length are transcribed as one part. */
export const SINGLE_CHUNK_MAX_SECONDS = 10 * 60;
/** How far either side of an even split we look for a pause. */
export const CUT_WINDOW_SECONDS = 60;
/** No part may start less than this after the previous one. */
export const MIN_CHUNK_SECONDS = 60;

/** "Duration: 00:05:06.61, ..." from ffmpeg's log, in seconds. */
export const parseDuration = (log: string): number | null => {
  const match = log.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) ? seconds : null;
};

/** Pairs up ffmpeg silencedetect's silence_start / silence_end lines. */
export const parseSilences = (log: string, durationSec?: number | null): Silence[] => {
  const silences: Silence[] = [];
  let open: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (start) {
      open = Math.max(0, Number(start[1]));
      continue;
    }
    const end = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (end && open !== null) {
      silences.push({ start: open, end: Number(end[1]) });
      open = null;
    }
  }
  // Audio that ends in silence has a start with no end.
  if (open !== null && durationSec && durationSec > open) silences.push({ start: open, end: durationSec });
  return silences;
};

/**
 * Chooses cut points. Splits evenly into parts of about CHUNK_TARGET_SECONDS,
 * then moves each cut to the longest pause within CUT_WINDOW_SECONDS of the even
 * position (the middle of that pause), so speech is not interrupted.
 */
export const planChunks = (
  durationSec: number,
  silences: Silence[],
  options: { target?: number; singleMax?: number; window?: number; min?: number } = {},
): ChunkPlan[] => {
  const target = options.target ?? CHUNK_TARGET_SECONDS;
  const singleMax = options.singleMax ?? SINGLE_CHUNK_MAX_SECONDS;
  const window = options.window ?? CUT_WINDOW_SECONDS;
  const min = options.min ?? MIN_CHUNK_SECONDS;

  if (!(durationSec > 0)) return [];
  if (durationSec <= singleMax) return [{ index: 0, start: 0, end: durationSec, forcedStart: false }];

  const parts = Math.ceil(durationSec / target);
  const cuts: { at: number; forced: boolean }[] = [];
  let previous = 0;

  for (let k = 1; k < parts; k++) {
    const ideal = (durationSec * k) / parts;
    const candidates = silences
      .map((s) => ({ mid: (s.start + s.end) / 2, length: s.end - s.start }))
      .filter((s) => Math.abs(s.mid - ideal) <= window && s.mid - previous >= min && durationSec - s.mid >= min);

    if (candidates.length > 0) {
      // Longest pause wins; the one nearest the even position breaks ties.
      candidates.sort((a, b) => b.length - a.length || Math.abs(a.mid - ideal) - Math.abs(b.mid - ideal));
      cuts.push({ at: candidates[0].mid, forced: false });
      previous = candidates[0].mid;
    } else {
      cuts.push({ at: Math.max(ideal, previous + min), forced: true });
      previous = cuts[cuts.length - 1].at;
    }
  }

  const bounds = [0, ...cuts.map((c) => c.at), durationSec];
  return bounds.slice(0, -1).map((start, index) => ({
    index,
    start,
    end: bounds[index + 1],
    forcedStart: index > 0 && cuts[index - 1].forced,
  }));
};

/** Cut times in the form ffmpeg's segment muxer wants: "450.2,901.7". */
export const segmentTimes = (plan: ChunkPlan[]): string =>
  plan
    .slice(1)
    .map((c) => c.start.toFixed(3))
    .join(",");
