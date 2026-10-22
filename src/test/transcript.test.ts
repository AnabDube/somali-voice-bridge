import { describe, it, expect } from "vitest";
import {
  partsLabel,
  promptTail,
  splitIntoBatches,
  stitchChunks,
  toSegment,
  type ChunkResult,
} from "../../supabase/functions/_shared/transcript";

const chunk = (idx: number, start: number, dur: number, texts: string[], whisper: number | null = dur): ChunkResult => ({
  idx,
  start_seconds: start,
  duration_seconds: dur,
  whisper_seconds: whisper,
  text: texts.join(" "),
  segments: texts.map((text, i) => ({ id: i, start: i * 10, end: i * 10 + 9.5, text: ` ${text} ` })),
});

describe("stitchChunks", () => {
  const parts = [
    chunk(0, 0, 450, ["salaan", "sidee tahay"]),
    chunk(1, 450, 450, ["waan fiicanahay", "mahadsanid"]),
    chunk(2, 900, 300, ["nabad gelyo"], 299.4),
  ];

  it("gives the segments continuous timestamps across parts", () => {
    const { segments } = stitchChunks(parts);
    expect(segments.map((s) => [s.start, s.end])).toEqual([
      [0, 9.5], [10, 19.5], // part 0
      [450, 459.5], [460, 469.5], // part 1 shifted by 450
      [900, 909.5], // part 2 shifted by 900
    ]);
  });

  it("renumbers segments 0..n-1 and trims their text", () => {
    const { segments } = stitchChunks(parts);
    expect(segments.map((s) => s.id)).toEqual([0, 1, 2, 3, 4]);
    expect(segments[0].text).toBe("salaan");
  });

  it("joins the part texts in order", () => {
    expect(stitchChunks(parts).text).toBe("salaan sidee tahay\n\nwaan fiicanahay mahadsanid\n\nnabad gelyo");
  });

  it("is not fooled by parts arriving out of order", () => {
    expect(stitchChunks([parts[2], parts[0], parts[1]])).toEqual(stitchChunks(parts));
  });

  it("reports the total length from the last part, using Whisper's own duration", () => {
    expect(stitchChunks(parts).totalSeconds).toBe(1199.4);
    expect(stitchChunks([chunk(0, 0, 450, ["a"], null)]).totalSeconds).toBe(450); // falls back to the planned length
  });

  it("drops empty segments and tolerates a part with no segments", () => {
    const silent: ChunkResult = { idx: 0, start_seconds: 0, duration_seconds: 60, whisper_seconds: 60, text: "", segments: [{ start: 0, end: 5, text: "   " }] };
    const none: ChunkResult = { idx: 1, start_seconds: 60, duration_seconds: 60, whisper_seconds: 60, text: null, segments: null };
    expect(stitchChunks([silent, none])).toEqual({ text: "", segments: [], totalSeconds: 120 });
  });

  it("keeps the confidence measures for the transcript workspace", () => {
    const s = toSegment({ start: 1, end: 2, text: " x ", avg_logprob: -0.41234, no_speech_prob: 0.01234, compression_ratio: 1.23456 }, 7, 100);
    expect(s).toEqual({ id: 7, start: 101, end: 102, text: "x", avg_logprob: -0.412, no_speech_prob: 0.012, compression_ratio: 1.23 });
    expect(toSegment({ start: 0, end: 1, text: "y" }, 0)).toEqual({ id: 0, start: 0, end: 1, text: "y" });
  });
});

describe("promptTail", () => {
  it("returns short text unchanged", () => {
    expect(promptTail("waa kuwaas")).toBe("waa kuwaas");
    expect(promptTail(null)).toBe("");
  });

  it("keeps only the end, starting at a whole word", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const tail = promptTail(text, 20);
    expect(tail.length).toBeLessThanOrEqual(20);
    expect(text.endsWith(tail)).toBe(true);
    expect(text).toMatch(new RegExp(`(^| )${tail}$`)); // starts on a word boundary
  });

  it("collapses whitespace", () => {
    expect(promptTail("a   b\n\nc")).toBe("a b c");
  });
});

describe("splitIntoBatches", () => {
  const seg = (n: number, len: number) => Array.from({ length: n }, (_, i) => ({ text: `s${i} ` + "x".repeat(len) }));

  it("keeps short transcripts in one batch", () => {
    const batches = splitIntoBatches("anything", seg(5, 20), 3000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ from: 0, to: 4 });
  });

  it("splits on segment boundaries so no batch is much over the limit and none is empty", () => {
    const segments = seg(100, 98); // ~101 chars each
    const batches = splitIntoBatches("", segments, 1000);
    expect(batches.length).toBeGreaterThan(8);
    for (const b of batches) {
      expect(b.text.length).toBeLessThanOrEqual(1000);
      expect(b.text.length).toBeGreaterThan(0);
    }
  });

  it("covers every segment exactly once, in order", () => {
    const batches = splitIntoBatches("", seg(57, 80), 700);
    expect(batches[0].from).toBe(0);
    expect(batches[batches.length - 1].to).toBe(56);
    for (let i = 1; i < batches.length; i++) expect(batches[i].from).toBe(batches[i - 1].to + 1);
  });

  it("joining the batches gives back all the text", () => {
    const segments = seg(30, 50);
    const joined = splitIntoBatches("", segments, 500).map((b) => b.text).join(" ");
    expect(joined).toBe(segments.map((s) => s.text.trim()).join(" "));
  });

  it("never splits one oversized segment", () => {
    const batches = splitIntoBatches("", [{ text: "a".repeat(5000) }, { text: "b" }], 1000);
    expect(batches).toHaveLength(2);
    expect(batches[0].text).toHaveLength(5000);
  });

  it("works from plain text when there are no segments, cutting at sentence ends", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Jumladda ${i} waa tan oo dheer.`).join(" ");
    const batches = splitIntoBatches(text, null, 300);
    expect(batches.length).toBeGreaterThan(3);
    for (const b of batches) expect(b.text.endsWith(".")).toBe(true);
    expect(batches.map((b) => b.text).join(" ")).toBe(text);
  });

  it("handles a long run of text with no punctuation by splitting on words", () => {
    const text = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");
    const batches = splitIntoBatches(text, [], 1500);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.map((b) => b.text).join(" ")).toBe(text);
  });

  it("returns nothing for empty input", () => {
    expect(splitIntoBatches("", null, 1000)).toEqual([]);
    expect(splitIntoBatches("   ", [], 1000)).toEqual([]);
  });
});

describe("partsLabel", () => {
  it("formats progress", () => {
    expect(partsLabel(3, 9)).toBe("3 of 9 parts");
  });
});
