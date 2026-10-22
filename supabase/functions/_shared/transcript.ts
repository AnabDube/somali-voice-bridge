// Pure helpers for long recordings (no Deno or network APIs, so they can be unit
// tested): stitching parts into one transcript, carrying context from one part
// to the next, and splitting long text into batches that fit the AI limits.

export interface WhisperSegment {
  id?: number;
  start: number;
  end: number;
  text?: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
}

export interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
}

export interface ChunkResult {
  idx: number;
  start_seconds: number;
  /** Planned length of the part. */
  duration_seconds: number;
  /** Length Whisper reported for the part, when it did. */
  whisper_seconds: number | null;
  text: string | null;
  segments: WhisperSegment[] | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Keeps the fields we use from one Whisper segment, including the confidence
 * measures that later let the UI flag parts worth re-listening to.
 */
export const toSegment = (s: WhisperSegment, id: number, offsetSeconds = 0): Segment => {
  const out: Segment = {
    id,
    start: round1(s.start + offsetSeconds),
    end: round1(s.end + offsetSeconds),
    text: (s.text ?? "").trim(),
  };
  if (typeof s.avg_logprob === "number") out.avg_logprob = Math.round(s.avg_logprob * 1000) / 1000;
  if (typeof s.no_speech_prob === "number") out.no_speech_prob = Math.round(s.no_speech_prob * 1000) / 1000;
  if (typeof s.compression_ratio === "number") out.compression_ratio = Math.round(s.compression_ratio * 100) / 100;
  return out;
};

/**
 * Joins the parts, in order, into one transcript with continuous timestamps:
 * each part's segment times are shifted by where that part starts.
 */
export const stitchChunks = (
  chunks: ChunkResult[],
): { text: string; segments: Segment[]; totalSeconds: number } => {
  const ordered = [...chunks].sort((a, b) => a.idx - b.idx);
  const segments: Segment[] = [];
  const texts: string[] = [];
  let totalSeconds = 0;

  for (const chunk of ordered) {
    const text = (chunk.text ?? "").trim();
    if (text) texts.push(text);

    for (const s of chunk.segments ?? []) {
      const segment = toSegment(s, segments.length, chunk.start_seconds);
      if (segment.text) segments.push(segment);
    }

    const length = chunk.whisper_seconds ?? chunk.duration_seconds;
    totalSeconds = Math.max(totalSeconds, chunk.start_seconds + length);
  }

  return { text: texts.join("\n\n"), segments, totalSeconds: round1(totalSeconds) };
};

/**
 * The end of the previous part, given to Whisper as its `prompt` so spelling
 * and context stay consistent across the boundary. Cut at a word boundary.
 */
export const promptTail = (text: string | null | undefined, maxChars = 220): string => {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const tail = clean.slice(-maxChars);
  const firstSpace = tail.indexOf(" ");
  return firstSpace > 0 ? tail.slice(firstSpace + 1) : tail;
};

export interface Batch {
  /** Index of the first and last segment in the batch (or 0 when working from plain text). */
  from: number;
  to: number;
  text: string;
}

/**
 * Splits a transcript into batches of roughly `maxChars`, never cutting inside
 * a segment (or, without segments, inside a sentence). The AI services have a
 * per-minute token limit, so long transcripts are translated one batch at a
 * time. Batches stay in order and cover everything, so they can be joined back.
 */
export const splitIntoBatches = (
  text: string,
  segments: { text?: string }[] | null | undefined,
  maxChars: number,
): Batch[] => {
  const usable = (segments ?? []).map((s) => (s.text ?? "").trim());
  const units = usable.some(Boolean)
    ? usable.map((t, i) => ({ t, i })).filter((u) => u.t)
    : sentences(text).map((t, i) => ({ t, i }));

  const batches: Batch[] = [];
  let current: { from: number; to: number; parts: string[]; length: number } | null = null;

  for (const unit of units) {
    if (current && current.length + unit.t.length + 1 > maxChars) {
      batches.push({ from: current.from, to: current.to, text: current.parts.join(" ") });
      current = null;
    }
    if (!current) current = { from: unit.i, to: unit.i, parts: [], length: 0 };
    current.parts.push(unit.t);
    current.to = unit.i;
    current.length += unit.t.length + 1;
  }
  if (current) batches.push({ from: current.from, to: current.to, text: current.parts.join(" ") });
  return batches;
};

/** Sentences of a text. A single very long run with no punctuation is split by words. */
const sentences = (text: string): string[] => {
  const pieces = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.length <= 1500) {
      out.push(piece);
      continue;
    }
    let buffer = "";
    for (const word of piece.split(" ")) {
      if (buffer.length + word.length + 1 > 1200 && buffer) {
        out.push(buffer);
        buffer = "";
      }
      buffer += (buffer ? " " : "") + word;
    }
    if (buffer) out.push(buffer);
  }
  return out;
};

/** "3 of 9 parts" */
export const partsLabel = (done: number, total: number): string => `${done} of ${total} parts`;
