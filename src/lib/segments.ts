// Segments are the unit of the transcript workspace: a stretch of speech with
// timing, Whisper's confidence measures, an optional speaker, and the text (as
// corrected by a person) beside the text the model originally produced.

export interface TranscriptSegment {
  id: string;
  idx: number;
  /** null for older transcripts that were saved as plain text with no timing. */
  start_seconds: number | null;
  end_seconds: number | null;
  text: string;
  original_text: string;
  avg_logprob: number | null;
  no_speech_prob: number | null;
  compression_ratio: number | null;
  speaker: string | null;
  edited_at: string | null;
}

/** One translated section: it covers segments `from`..`to` (by idx). */
export interface TranslatedSection {
  from: number;
  to: number;
  text: string;
  at?: string;
}

export interface Section {
  index: number;
  segments: TranscriptSegment[];
  english: string | null;
  translatedAt: string | null;
  /** A segment in this section was edited after it was translated. */
  stale: boolean;
}

// ---------------------------------------------------------------- confidence
//
// These are Whisper's own limits for "the model was not sure" (it re-decodes a
// window when avg_logprob is below -1.0 or the compression ratio is above 2.4,
// and treats high no_speech_prob as silence). Measured on a real Somali
// recording against a human-corrected transcript, avg_logprob is the only one of
// the three that tracks real errors; the other two are rarely triggered, so they
// only add a flag in clear-cut cases.
export const LOW_LOGPROB = -1.0;
export const HIGH_NO_SPEECH = 0.6;
export const HIGH_COMPRESSION = 2.4;

/** Should a person check this part against the audio? Unknown (no data) is not flagged. */
export const isLowConfidence = (s: Pick<TranscriptSegment, "avg_logprob" | "no_speech_prob" | "compression_ratio">): boolean =>
  (s.avg_logprob !== null && s.avg_logprob < LOW_LOGPROB) ||
  (s.compression_ratio !== null && s.compression_ratio > HIGH_COMPRESSION) ||
  (s.no_speech_prob !== null && s.no_speech_prob > HIGH_NO_SPEECH);

export interface ConfidenceSummary {
  flagged: number;
  total: number;
  /** Segments with any confidence data at all. Older transcripts have none. */
  measured: number;
  /** More than half of the measured parts are flagged: the audio itself is probably difficult. */
  mostlyFlagged: boolean;
}

export const confidenceSummary = (segments: TranscriptSegment[]): ConfidenceSummary => {
  const measured = segments.filter(
    (s) => s.avg_logprob !== null || s.compression_ratio !== null || s.no_speech_prob !== null,
  ).length;
  const flagged = segments.filter(isLowConfidence).length;
  return { flagged, total: segments.length, measured, mostlyFlagged: measured > 0 && flagged / measured > 0.5 };
};

// ---------------------------------------------------------------- time
/** m:ss, or h:mm:ss when `withHours`. Empty when the segment has no timing. */
export const formatTimestamp = (seconds: number | null | undefined, withHours = false): string => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return withHours || h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

export const needsHours = (segments: TranscriptSegment[]): boolean =>
  segments.some((s) => (s.end_seconds ?? s.start_seconds ?? 0) >= 3600);

export const hasTiming = (segments: TranscriptSegment[]): boolean =>
  segments.length > 0 && segments.every((s) => s.start_seconds !== null);

/**
 * The segment being spoken at `time`: the last one that has started (so it stays
 * highlighted through a short pause), or -1 before the first / long after the last.
 * Segments must be in order. Returns the position in the array.
 */
export const findActiveIndex = (segments: TranscriptSegment[], time: number): number => {
  // Timing is all-or-none for a transcript, so checking the ends is enough (and keeps this O(log n)).
  if (segments.length === 0 || segments[0].start_seconds === null || segments[segments.length - 1].start_seconds === null || !Number.isFinite(time)) return -1;
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((segments[mid].start_seconds as number) <= time) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found === -1) return -1;
  const last = segments[found];
  const isLast = found === segments.length - 1;
  if (isLast && last.end_seconds !== null && time > last.end_seconds + 3) return -1;
  return found;
};

// ---------------------------------------------------------------- speakers & edits
/** Distinct speaker names, in the order they first appear. */
export const speakersOf = (segments: TranscriptSegment[]): string[] => {
  const seen: string[] = [];
  for (const s of segments) if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  return seen;
};

export const isEdited = (segments: TranscriptSegment[]): boolean => segments.some((s) => s.edited_at !== null);

export const countEdited = (segments: TranscriptSegment[]): number => segments.filter((s) => s.edited_at !== null).length;

// ---------------------------------------------------------------- translation sections
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validates the saved translation progress (JSON from the database). */
export const parseTranslatedSections = (progress: unknown): { total: number; parts: TranslatedSection[] } => {
  const value = progress as { total?: unknown; parts?: unknown } | null;
  const parts = Array.isArray(value?.parts)
    ? (value!.parts as unknown[]).filter(
        (p): p is TranslatedSection =>
          !!p && isNumber((p as TranslatedSection).from) && isNumber((p as TranslatedSection).to) && typeof (p as TranslatedSection).text === "string",
      )
    : [];
  return { total: isNumber(value?.total) ? (value!.total as number) : parts.length, parts };
};

/**
 * Groups the segments into the translated sections they belong to, so the English
 * can sit beside the Somali it translates. A section runs from its first segment up
 * to the start of the next one (so a segment a person cleared out still has a home).
 * While translation is still in progress, the segments after the last finished
 * section are returned as one section with no English yet.
 */
export const buildSections = (
  segments: TranscriptSegment[],
  parts: TranslatedSection[],
  complete: boolean,
): Section[] => {
  if (segments.length === 0) return [];
  if (parts.length === 0) {
    return [{ index: 0, segments, english: null, translatedAt: null, stale: false }];
  }

  const ordered = [...parts].sort((a, b) => a.from - b.from);
  const sections: Section[] = ordered.map((p, i) => {
    const nextStart = ordered[i + 1]?.from;
    const isLast = i === ordered.length - 1;
    const inRange = (s: TranscriptSegment) =>
      s.idx >= (i === 0 ? -Infinity : p.from) &&
      (nextStart !== undefined ? s.idx < nextStart : isLast && complete ? true : s.idx <= p.to);
    const members = segments.filter(inRange);
    return {
      index: i,
      segments: members,
      english: p.text,
      translatedAt: p.at ?? null,
      stale: !!p.at && members.some((s) => s.edited_at !== null && s.edited_at > (p.at as string)),
    };
  });

  const covered = new Set(sections.flatMap((s) => s.segments.map((x) => x.idx)));
  const rest = segments.filter((s) => !covered.has(s.idx));
  if (rest.length > 0) {
    sections.push({ index: sections.length, segments: rest, english: null, translatedAt: null, stale: false });
  }
  return sections.filter((s) => s.segments.length > 0);
};

// ---------------------------------------------------------------- virtual list blocks
/** The most rows drawn in one block. A long transcript is drawn a block at a time. */
export const MAX_BLOCK_ROWS = 40;

export interface Block {
  key: string;
  section: Section;
  segments: TranscriptSegment[];
  /** The English translation is shown with the first block of its section only. */
  showEnglish: boolean;
}

/**
 * Splits sections into blocks of at most MAX_BLOCK_ROWS rows. The transcript list only
 * draws the blocks near the screen, so a two-hour interview (about 2,000 segments)
 * stays fast to open, scroll and search.
 */
export const buildBlocks = (sections: Section[]): Block[] =>
  sections.flatMap((section) => {
    const blocks: Block[] = [];
    for (let start = 0, piece = 0; start < section.segments.length; start += MAX_BLOCK_ROWS, piece++) {
      blocks.push({
        key: `${section.index}-${piece}`,
        section,
        segments: section.segments.slice(start, start + MAX_BLOCK_ROWS),
        showEnglish: piece === 0,
      });
    }
    return blocks;
  });
