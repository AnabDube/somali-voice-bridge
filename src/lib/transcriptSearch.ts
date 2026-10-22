// Searching and replacing across a transcript. Plain-text matching only (no
// regular expressions for the user), so typing "a.b" finds "a.b", not "aXb".
// Somali words contain apostrophes (mashruuc'an), so those count as part of a word.

import type { TranscriptSegment } from "@/lib/segments";

export interface SearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

export const DEFAULT_SEARCH: SearchOptions = { matchCase: false, wholeWord: false };

const WORD_CHAR = "\\p{L}\\p{N}_'’";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The pattern for a query, or null when there is nothing to look for. */
export const buildPattern = (query: string, options: SearchOptions = DEFAULT_SEARCH): RegExp | null => {
  if (!query) return null;
  const body = escapeRegExp(query);
  const source = options.wholeWord ? `(?<![${WORD_CHAR}])${body}(?![${WORD_CHAR}])` : body;
  return new RegExp(source, options.matchCase ? "gu" : "giu");
};

export interface TextPiece {
  text: string;
  match: boolean;
}

/** Splits text into plain and matching pieces, for highlighting. */
export const splitByMatches = (text: string, pattern: RegExp | null): TextPiece[] => {
  if (!pattern || !text) return [{ text, match: false }];
  const pieces: TextPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
    if (m[0].length === 0) continue;
    const start = m.index ?? 0;
    if (start > last) pieces.push({ text: text.slice(last, start), match: false });
    pieces.push({ text: m[0], match: true });
    last = start + m[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), match: false });
  return pieces.length ? pieces : [{ text, match: false }];
};

export interface SegmentMatch {
  segmentId: string;
  /** Position in the segments array. */
  position: number;
  count: number;
}

/** Which segments contain the query, and how many times. */
export const findMatches = (
  segments: TranscriptSegment[],
  query: string,
  options: SearchOptions = DEFAULT_SEARCH,
): { matches: SegmentMatch[]; total: number } => {
  const pattern = buildPattern(query, options);
  if (!pattern) return { matches: [], total: 0 };
  const matches: SegmentMatch[] = [];
  let total = 0;
  segments.forEach((s, position) => {
    const count = splitByMatches(s.text, pattern).filter((p) => p.match).length;
    if (count > 0) {
      matches.push({ segmentId: s.id, position, count });
      total += count;
    }
  });
  return { matches, total };
};

export interface TextUpdate {
  id: string;
  text: string;
}

/** The edits a find-and-replace would make: only segments that actually change. The replacement is literal. */
export const planReplace = (
  segments: TranscriptSegment[],
  find: string,
  replacement: string,
  options: SearchOptions = DEFAULT_SEARCH,
): { updates: TextUpdate[]; replacements: number } => {
  const pattern = buildPattern(find, options);
  if (!pattern) return { updates: [], replacements: 0 };
  const updates: TextUpdate[] = [];
  let replacements = 0;
  for (const s of segments) {
    let count = 0;
    const text = s.text.replace(pattern, () => {
      count++;
      return replacement;
    });
    if (count > 0 && text !== s.text) {
      updates.push({ id: s.id, text });
      replacements += count;
    }
  }
  return { updates, replacements };
};

/**
 * The edits that applying a list of saved corrections would make, one after the
 * other (so a later correction sees the result of an earlier one). Only
 * segments that end up different are returned.
 */
export const planReplaceAll = (
  segments: TranscriptSegment[],
  corrections: { find_text: string; replace_text: string }[],
  options: SearchOptions = DEFAULT_SEARCH,
): { updates: TextUpdate[]; replacements: number } => {
  const working = new Map(segments.map((s) => [s.id, s.text]));
  let replacements = 0;
  for (const correction of corrections) {
    const pattern = buildPattern(correction.find_text, options);
    if (!pattern) continue;
    for (const [id, text] of working) {
      let count = 0;
      const next = text.replace(pattern, () => {
        count++;
        return correction.replace_text;
      });
      if (count > 0) {
        working.set(id, next);
        replacements += count;
      }
    }
  }
  const updates = segments
    .filter((s) => working.get(s.id) !== s.text)
    .map((s) => ({ id: s.id, text: working.get(s.id) as string }));
  return { updates, replacements };
};
