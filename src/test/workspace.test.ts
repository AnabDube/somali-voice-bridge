import { describe, it, expect } from "vitest";
import {
  buildSections,
  confidenceSummary,
  countEdited,
  findActiveIndex,
  formatTimestamp,
  hasTiming,
  isEdited,
  isLowConfidence,
  needsHours,
  parseTranslatedSections,
  speakersOf,
  type TranscriptSegment,
} from "@/lib/segments";
import { buildPattern, findMatches, planReplace, splitByMatches } from "@/lib/transcriptSearch";
import {
  exportFileName,
  segmentLine,
  srtTimestamp,
  toBilingualTxt,
  toEnglishTxt,
  toSomaliTxt,
  toSrt,
  wrapSubtitle,
} from "@/lib/transcriptExport";

const seg = (idx: number, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id: `s${idx}`,
  idx,
  start_seconds: idx * 10,
  end_seconds: idx * 10 + 9,
  text,
  original_text: text,
  avg_logprob: -0.3,
  no_speech_prob: 0.01,
  compression_ratio: 1.6,
  speaker: null,
  edited_at: null,
  ...extra,
});

const six = [0, 1, 2, 3, 4, 5].map((i) => seg(i, `qayb ${i}`));

describe("confidence", () => {
  it("flags the cases Whisper itself treats as unsure", () => {
    expect(isLowConfidence(seg(0, "x", { avg_logprob: -1.2 }))).toBe(true);
    expect(isLowConfidence(seg(0, "x", { avg_logprob: -1.0 }))).toBe(false); // exactly on the limit is not below it
    expect(isLowConfidence(seg(0, "x", { compression_ratio: 2.6 }))).toBe(true);
    expect(isLowConfidence(seg(0, "x", { no_speech_prob: 0.7 }))).toBe(true);
    expect(isLowConfidence(seg(0, "x"))).toBe(false);
  });

  it("does not flag a segment it knows nothing about", () => {
    expect(isLowConfidence(seg(0, "x", { avg_logprob: null, no_speech_prob: null, compression_ratio: null }))).toBe(false);
  });

  it("summarises how much of a transcript is flagged, and says when it is most of it", () => {
    const mixed = [seg(0, "a", { avg_logprob: -1.3 }), seg(1, "b"), seg(2, "c", { avg_logprob: -1.1 })];
    expect(confidenceSummary(mixed)).toEqual({ flagged: 2, total: 3, measured: 3, mostlyFlagged: true });
    expect(confidenceSummary(six).mostlyFlagged).toBe(false);
  });

  it("does not claim 'mostly flagged' for older transcripts that have no confidence data", () => {
    const old = six.map((s) => ({ ...s, avg_logprob: null, no_speech_prob: null, compression_ratio: null }));
    expect(confidenceSummary(old)).toMatchObject({ flagged: 0, measured: 0, mostlyFlagged: false });
  });
});

describe("timestamps", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(75.9)).toBe("1:15");
    expect(formatTimestamp(3600)).toBe("1:00:00");
    expect(formatTimestamp(5025)).toBe("1:23:45");
    expect(formatTimestamp(75, true)).toBe("0:01:15");
  });

  it("is empty for a segment with no timing", () => {
    expect(formatTimestamp(null)).toBe("");
    expect(formatTimestamp(undefined)).toBe("");
    expect(formatTimestamp(NaN)).toBe("");
  });

  it("knows when a transcript needs hours", () => {
    expect(needsHours(six)).toBe(false);
    expect(needsHours([seg(0, "x", { start_seconds: 3590, end_seconds: 3605 })])).toBe(true);
  });
});

describe("findActiveIndex (which segment is playing)", () => {
  it("finds the segment containing the time", () => {
    expect(findActiveIndex(six, 0)).toBe(0);
    expect(findActiveIndex(six, 25)).toBe(2);
    expect(findActiveIndex(six, 59.9)).toBe(5);
  });

  it("keeps the previous segment through a short pause between segments", () => {
    expect(findActiveIndex(six, 9.5)).toBe(0); // segment 0 ends at 9, segment 1 starts at 10
  });

  it("is -1 before the first segment and long after the last", () => {
    expect(findActiveIndex([seg(0, "x", { start_seconds: 5, end_seconds: 9 })], 2)).toBe(-1);
    expect(findActiveIndex(six, 500)).toBe(-1);
  });

  it("is -1 for transcripts without timing", () => {
    const untimed = six.map((s) => ({ ...s, start_seconds: null, end_seconds: null }));
    expect(hasTiming(untimed)).toBe(false);
    expect(findActiveIndex(untimed, 20)).toBe(-1);
  });

  it("is fast and correct on a 90-minute transcript", () => {
    const big = Array.from({ length: 2000 }, (_, i) => seg(i, "x", { start_seconds: i * 2.7, end_seconds: i * 2.7 + 2.5 }));
    // Time the lookups themselves, then check the answers (expect() has its own overhead).
    const t0 = performance.now();
    const found = Array.from({ length: 2000 }, (_, i) => findActiveIndex(big, i * 2.7 + 0.1));
    const elapsed = performance.now() - t0;
    expect(found).toEqual(Array.from({ length: 2000 }, (_, i) => i));
    expect(elapsed).toBeLessThan(100);
  });
});

describe("speakers and edits", () => {
  it("lists distinct speakers in order of first appearance", () => {
    const s = [seg(0, "a", { speaker: "Hodan" }), seg(1, "b"), seg(2, "c", { speaker: "Guest" }), seg(3, "d", { speaker: "Hodan" })];
    expect(speakersOf(s)).toEqual(["Hodan", "Guest"]);
    expect(speakersOf(six)).toEqual([]);
  });

  it("counts edited segments", () => {
    const s = [seg(0, "a"), seg(1, "b", { edited_at: "2026-10-22T10:00:00Z" }), seg(2, "c", { edited_at: "2026-10-22T10:01:00Z" })];
    expect(isEdited(s)).toBe(true);
    expect(countEdited(s)).toBe(2);
    expect(isEdited(six)).toBe(false);
  });
});

describe("sections (English beside the Somali it translates)", () => {
  const parts = [
    { from: 0, to: 2, text: "English A", at: "2026-10-22T10:00:00Z" },
    { from: 3, to: 5, text: "English B", at: "2026-10-22T10:00:00Z" },
  ];

  it("puts each segment in the section that covers it", () => {
    const sections = buildSections(six, parts, true);
    expect(sections).toHaveLength(2);
    expect(sections[0].segments.map((s) => s.idx)).toEqual([0, 1, 2]);
    expect(sections[1].segments.map((s) => s.idx)).toEqual([3, 4, 5]);
    expect(sections.map((s) => s.english)).toEqual(["English A", "English B"]);
  });

  it("every segment appears exactly once", () => {
    const flat = buildSections(six, parts, true).flatMap((s) => s.segments.map((x) => x.idx));
    expect(flat).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("flags a section as out of date when a segment was edited after it was translated", () => {
    const edited = six.map((s) => (s.idx === 4 ? { ...s, edited_at: "2026-10-22T11:00:00Z" } : s));
    const sections = buildSections(edited, parts, true);
    expect(sections.map((s) => s.stale)).toEqual([false, true]);
  });

  it("an edit made BEFORE the translation does not make it stale", () => {
    const edited = six.map((s) => (s.idx === 1 ? { ...s, edited_at: "2026-10-22T09:00:00Z" } : s));
    expect(buildSections(edited, parts, true).every((s) => !s.stale)).toBe(true);
  });

  it("keeps a segment that a person cleared out inside its section (gap between sections)", () => {
    const gapParts = [{ from: 0, to: 1, text: "A" }, { from: 4, to: 5, text: "B" }]; // segments 2 and 3 fall in between
    const sections = buildSections(six, gapParts, true);
    expect(sections[0].segments.map((s) => s.idx)).toEqual([0, 1, 2, 3]);
    expect(sections[1].segments.map((s) => s.idx)).toEqual([4, 5]);
  });

  it("while translation is in progress, the rest is one section with no English yet", () => {
    const sections = buildSections(six, [parts[0]], false);
    expect(sections).toHaveLength(2);
    expect(sections[0].english).toBe("English A");
    expect(sections[1]).toMatchObject({ english: null });
    expect(sections[1].segments.map((s) => s.idx)).toEqual([3, 4, 5]);
  });

  it("with no translation at all, there is a single section with no English", () => {
    expect(buildSections(six, [], false)).toEqual([{ index: 0, segments: six, english: null, translatedAt: null, stale: false }]);
    expect(buildSections([], parts, true)).toEqual([]);
  });

  it("reads saved progress safely, ignoring malformed entries", () => {
    expect(parseTranslatedSections(null)).toEqual({ total: 0, parts: [] });
    expect(parseTranslatedSections({ total: 3, parts: [{ from: 0, to: 1, text: "ok" }, { from: "x" }, null, { from: 2, to: 3 }] })).toEqual({
      total: 3,
      parts: [{ from: 0, to: 1, text: "ok" }],
    });
  });
});

describe("search", () => {
  const text = [seg(0, "Mashruuc'an waa muhiim"), seg(1, "mashruuca kale"), seg(2, "MASHRUUC iyo mashruucyo")];

  it("finds matches ignoring case by default, and counts them", () => {
    const { matches, total } = findMatches(text, "mashruuc");
    expect(total).toBe(4);
    expect(matches.map((m) => m.position)).toEqual([0, 1, 2]);
    expect(matches[2].count).toBe(2);
  });

  it("can match case", () => {
    expect(findMatches(text, "MASHRUUC", { matchCase: true, wholeWord: false }).total).toBe(1);
  });

  it("whole word treats Somali apostrophes as part of the word", () => {
    // "Mashruuc'an" is one word, so a whole-word search for "mashruuc" must not match inside it
    const { total } = findMatches(text, "mashruuc", { matchCase: false, wholeWord: true });
    expect(total).toBe(1); // only the standalone "MASHRUUC"
  });

  it("treats the query literally, not as a pattern", () => {
    const s = [seg(0, "a.b a-b aXb (x)")];
    expect(findMatches(s, "a.b").total).toBe(1);
    expect(findMatches(s, "(x)").total).toBe(1);
    expect(findMatches(s, ".*").total).toBe(0);
  });

  it("an empty query finds nothing", () => {
    expect(findMatches(text, "").total).toBe(0);
    expect(buildPattern("")).toBeNull();
  });

  it("splits text into plain and matching pieces for highlighting", () => {
    expect(splitByMatches("ab Mashruuc cd mashruuc", buildPattern("mashruuc"))).toEqual([
      { text: "ab ", match: false },
      { text: "Mashruuc", match: true },
      { text: " cd ", match: false },
      { text: "mashruuc", match: true },
    ]);
    expect(splitByMatches("nothing here", buildPattern("zzz"))).toEqual([{ text: "nothing here", match: false }]);
    expect(splitByMatches("x", null)).toEqual([{ text: "x", match: false }]);
  });

  it("works with accented and non-Latin text", () => {
    expect(findMatches([seg(0, "Café ÉCOLE")], "école").total).toBe(1);
  });
});

describe("find and replace", () => {
  const text = [seg(0, "Hasan wuu yimid"), seg(1, "waxba"), seg(2, "hasan iyo Hasan")];

  it("plans edits only for segments that change", () => {
    const { updates, replacements } = planReplace(text, "Hasan", "Xasan");
    expect(replacements).toBe(3);
    expect(updates).toEqual([
      { id: "s0", text: "Xasan wuu yimid" },
      { id: "s2", text: "Xasan iyo Xasan" },
    ]);
  });

  it("respects match case", () => {
    const { updates } = planReplace(text, "Hasan", "Xasan", { matchCase: true, wholeWord: false });
    expect(updates.map((u) => u.text)).toEqual(["Xasan wuu yimid", "hasan iyo Xasan"]);
  });

  it("replaces literally: '$&' and '$1' in the replacement are just text", () => {
    expect(planReplace([seg(0, "a b")], "a", "$& $1").updates[0].text).toBe("$& $1 b");
  });

  it("can replace with nothing (delete a word)", () => {
    expect(planReplace([seg(0, "one two three")], " two", "").updates[0].text).toBe("one three");
  });

  it("changes nothing when there is no match or no query", () => {
    expect(planReplace(text, "zzz", "x")).toEqual({ updates: [], replacements: 0 });
    expect(planReplace(text, "", "x")).toEqual({ updates: [], replacements: 0 });
  });
});

describe("exports", () => {
  const withSpeakers = [
    seg(0, "salaan", { speaker: "Hodan" }),
    seg(1, "sidee tahay?", { speaker: "Guest" }),
    seg(2, "fiicanahay"),
  ];
  const opts = { timestamps: true, speakers: true };

  it("a text line carries the timestamp and the speaker", () => {
    expect(segmentLine(withSpeakers[0], opts, false)).toBe("[0:00] Hodan: salaan");
    expect(segmentLine(withSpeakers[2], opts, false)).toBe("[0:20] fiicanahay"); // no speaker, no prefix
    expect(segmentLine(withSpeakers[0], { timestamps: false, speakers: false }, false)).toBe("salaan");
  });

  it("exports the Somali transcript with a header, one line per segment", () => {
    const out = toSomaliTxt(withSpeakers, { ...opts, title: "Interview" });
    expect(out).toBe("Interview\n3 segments\n\n[0:00] Hodan: salaan\n[0:10] Guest: sidee tahay?\n[0:20] fiicanahay\n");
  });

  it("uses h:mm:ss for every line once a transcript passes an hour", () => {
    const long = [seg(0, "a", { start_seconds: 5, end_seconds: 8 }), seg(1, "b", { start_seconds: 3700, end_seconds: 3710 })];
    expect(toSomaliTxt(long, opts)).toBe("[0:00:05] a\n[1:01:40] b\n");
  });

  it("leaves out the timestamp for segments with no timing", () => {
    const untimed = [seg(0, "salaan", { start_seconds: null, end_seconds: null })];
    expect(toSomaliTxt(untimed, opts)).toBe("salaan\n");
  });

  const sections = buildSections(
    withSpeakers,
    [{ from: 0, to: 2, text: "Hello. How are you? Fine." }],
    true,
  );

  it("exports the bilingual transcript with each section's English under its Somali", () => {
    const out = toBilingualTxt(sections, opts);
    expect(out).toBe("── 0:00–0:29 ──\n[0:00] Hodan: salaan\n[0:10] Guest: sidee tahay?\n[0:20] fiicanahay\n\nEnglish: Hello. How are you? Fine.\n");
  });

  it("exports the English alone, labelled with the time it covers", () => {
    expect(toEnglishTxt(sections, opts)).toBe("[0:00–0:29]\nHello. How are you? Fine.\n");
    expect(toEnglishTxt(sections, { timestamps: false, speakers: false })).toBe("Hello. How are you? Fine.\n");
  });

  it("formats SRT timestamps", () => {
    expect(srtTimestamp(0)).toBe("00:00:00,000");
    expect(srtTimestamp(75.5)).toBe("00:01:15,500");
    expect(srtTimestamp(3725.042)).toBe("01:02:05,042");
  });

  it("writes numbered SRT cues with speakers, skipping untimed and empty segments", () => {
    const srt = toSrt(
      [seg(0, "salaan", { speaker: "Hodan", start_seconds: 1, end_seconds: 3.5 }), seg(1, "   "), seg(2, "waa", { start_seconds: null, end_seconds: null }), seg(3, "nabad", { start_seconds: 30, end_seconds: 33 })],
      { speakers: true },
    );
    expect(srt).toBe("1\n00:00:01,000 --> 00:00:03,500\nHodan: salaan\n\n2\n00:00:30,000 --> 00:00:33,000\nnabad\n");
  });

  it("an SRT cue always ends after it starts", () => {
    const srt = toSrt([seg(0, "x", { start_seconds: 10, end_seconds: 10 }), seg(1, "y", { start_seconds: 20, end_seconds: null })], { speakers: false });
    expect(srt).toContain("00:00:10,000 --> 00:00:12,000");
    expect(srt).toContain("00:00:20,000 --> 00:00:22,000");
  });

  it("wraps subtitles at word boundaries", () => {
    const lines = wrapSubtitle("Waxaan rabaa inaan barto afka Ingiriisiga si aan shaqo u helo", 24);
    expect(lines.every((l) => l.length <= 24)).toBe(true);
    expect(lines.join(" ")).toBe("Waxaan rabaa inaan barto afka Ingiriisiga si aan shaqo u helo");
  });

  it("makes safe file names", () => {
    expect(exportFileName("Hodan A", "my interview (1)", "transcript", "docx")).toBe("Hodan_A_my_interview_1_transcript.docx");
  });
});

describe("applying saved corrections", () => {
  const text = [seg(0, "Hasan iyo Cali"), seg(1, "waxba"), seg(2, "Cali wuu yimid")];

  it("applies every saved correction and returns only the segments that change", async () => {
    const { planReplaceAll } = await import("@/lib/transcriptSearch");
    const { updates, replacements } = planReplaceAll(text, [
      { find_text: "Hasan", replace_text: "Xasan" },
      { find_text: "Cali", replace_text: "Cali Maxamed" },
    ]);
    expect(replacements).toBe(3);
    expect(updates).toEqual([
      { id: "s0", text: "Xasan iyo Cali Maxamed" },
      { id: "s2", text: "Cali Maxamed wuu yimid" },
    ]);
  });

  it("a later correction sees the result of an earlier one", async () => {
    const { planReplaceAll } = await import("@/lib/transcriptSearch");
    const { updates } = planReplaceAll([seg(0, "a")], [
      { find_text: "a", replace_text: "b" },
      { find_text: "b", replace_text: "c" },
    ]);
    expect(updates).toEqual([{ id: "s0", text: "c" }]);
  });

  it("does nothing with no corrections or no matches", async () => {
    const { planReplaceAll } = await import("@/lib/transcriptSearch");
    expect(planReplaceAll(text, [])).toEqual({ updates: [], replacements: 0 });
    expect(planReplaceAll(text, [{ find_text: "zzz", replace_text: "y" }])).toEqual({ updates: [], replacements: 0 });
  });
});

describe("virtual list blocks", () => {
  it("splits a long section into blocks, in order, without losing a segment", async () => {
    const { buildBlocks, MAX_BLOCK_ROWS } = await import("@/lib/segments");
    const many = Array.from({ length: 105 }, (_, i) => seg(i, `x${i}`));
    const blocks = buildBlocks([{ index: 0, segments: many, english: null, translatedAt: null, stale: false }]);
    expect(blocks.map((b) => b.segments.length)).toEqual([MAX_BLOCK_ROWS, MAX_BLOCK_ROWS, 25]);
    expect(blocks.flatMap((b) => b.segments.map((s) => s.idx))).toEqual(many.map((s) => s.idx));
    expect(new Set(blocks.map((b) => b.key)).size).toBe(blocks.length);
  });

  it("shows a section's English with its first block only", async () => {
    const { buildBlocks } = await import("@/lib/segments");
    const many = Array.from({ length: 90 }, (_, i) => seg(i, `x${i}`));
    const blocks = buildBlocks([{ index: 3, segments: many, english: "English", translatedAt: null, stale: false }]);
    expect(blocks.map((b) => b.showEnglish)).toEqual([true, false, false]);
    expect(blocks.every((b) => b.section.english === "English")).toBe(true);
  });

  it("keeps short translated sections as one block each", async () => {
    const { buildBlocks } = await import("@/lib/segments");
    const sections = buildSections(six, [{ from: 0, to: 2, text: "A" }, { from: 3, to: 5, text: "B" }], true);
    expect(buildBlocks(sections).map((b) => b.segments.length)).toEqual([3, 3]);
  });

  it("has no blocks for an empty transcript", async () => {
    const { buildBlocks } = await import("@/lib/segments");
    expect(buildBlocks([])).toEqual([]);
  });
});
