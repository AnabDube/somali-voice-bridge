import { describe, it, expect } from "vitest";
import {
  CHUNK_TARGET_SECONDS,
  CUT_WINDOW_SECONDS,
  parseDuration,
  parseSilences,
  planChunks,
  segmentTimes,
  type Silence,
} from "@/lib/chunking";
import { MAX_AUDIO_SECONDS, needsPreparation, validateAudioFile } from "@/lib/audio";

// Real lines from ffmpeg's log for the 5-minute test recording.
const FFMPEG_LOG = `
  Duration: 00:05:06.53, start: 0.069063, bitrate: 56 kb/s
[silencedetect @ 000002bf2251eb80] silence_start: 2.937813
[silencedetect @ 000002bf2251eb80] silence_end: 3.414938 | silence_duration: 0.477125
[silencedetect @ 000002bf2251eb80] silence_start: 40.310187
[silencedetect @ 000002bf2251eb80] silence_end: 40.778 | silence_duration: 0.467813
`;

describe("parsing ffmpeg's log", () => {
  it("reads the duration", () => {
    expect(parseDuration(FFMPEG_LOG)).toBeCloseTo(306.53, 2);
    expect(parseDuration("Duration: 01:30:00.00, start")).toBe(5400);
    expect(parseDuration("no duration here")).toBeNull();
  });

  it("pairs silence_start with silence_end", () => {
    expect(parseSilences(FFMPEG_LOG)).toEqual([
      { start: 2.937813, end: 3.414938 },
      { start: 40.310187, end: 40.778 },
    ]);
  });

  it("closes a trailing silence at the end of the audio", () => {
    const log = "silence_start: 100.5\nsilence_end: 101.0\nsilence_start: 295.0";
    expect(parseSilences(log, 300)).toEqual([
      { start: 100.5, end: 101 },
      { start: 295, end: 300 },
    ]);
  });

  it("ignores a silence_end with no start", () => {
    expect(parseSilences("silence_end: 5.0 | silence_duration: 1")).toEqual([]);
  });
});

describe("planChunks", () => {
  const lengths = (plan: ReturnType<typeof planChunks>) => plan.map((c) => c.end - c.start);

  it("keeps a short recording as one part", () => {
    expect(planChunks(306.5, [])).toEqual([{ index: 0, start: 0, end: 306.5, forcedStart: false }]);
    expect(planChunks(10 * 60, [])).toHaveLength(1);
  });

  it("returns nothing for an empty or unknown length", () => {
    expect(planChunks(0, [])).toEqual([]);
    expect(planChunks(NaN, [])).toEqual([]);
  });

  it("splits a 90-minute recording into parts that cover it exactly, in order, none too long", () => {
    const plan = planChunks(5400, []);
    expect(plan[0].start).toBe(0);
    expect(plan[plan.length - 1].end).toBe(5400);
    plan.forEach((c, i) => {
      expect(c.index).toBe(i);
      if (i > 0) expect(c.start).toBe(plan[i - 1].end); // no gaps, no overlaps
    });
    expect(Math.max(...lengths(plan))).toBeLessThanOrEqual(CHUNK_TARGET_SECONDS + 1);
    expect(plan).toHaveLength(Math.ceil(5400 / CHUNK_TARGET_SECONDS));
  });

  it("moves each cut into a pause near the even split, so words are not sliced", () => {
    const even = planChunks(2400, []); // 5 parts of 480 s, cuts at 480, 960, 1440, 1920
    const silences: Silence[] = [
      { start: 470, end: 470.6 },
      { start: 955, end: 955.5 },
      { start: 1450, end: 1450.4 },
      { start: 1915, end: 1915.8 },
    ];
    const plan = planChunks(2400, silences);
    expect(plan).toHaveLength(even.length);
    expect(plan.slice(1).map((c) => c.start)).toEqual([470.3, 955.25, 1450.2, 1915.4]);
    expect(plan.every((c) => !c.forcedStart)).toBe(true);
  });

  it("prefers the longest pause in the window", () => {
    // 900 s splits into 2 parts, so the even cut is at 450 s.
    const plan = planChunks(900, [
      { start: 440, end: 440.3 },
      { start: 455, end: 456.5 }, // much longer pause, also within the window
    ]);
    expect(plan).toHaveLength(2);
    expect(plan[1].start).toBeCloseTo(455.75, 2);
  });

  it("ignores pauses outside the window and falls back to an even cut, marked as forced", () => {
    // 1200 s splits into 3 parts: even cuts at 400 s and 800 s. The only pause is 100 s away.
    const silence = { start: 300, end: 301 };
    expect(Math.abs(400 - 300.5)).toBeGreaterThan(CUT_WINDOW_SECONDS);
    const plan = planChunks(1200, [silence]);
    expect(plan).toHaveLength(3);
    expect(plan[1]).toMatchObject({ start: 400, forcedStart: true });
    expect(plan[2]).toMatchObject({ start: 800, forcedStart: true });
    expect(plan[0].forcedStart).toBe(false);
  });

  it("never produces a part shorter than the minimum, even with pauses clustered together", () => {
    const silences: Silence[] = Array.from({ length: 40 }, (_, i) => ({ start: 400 + i, end: 400.4 + i }));
    const plan = planChunks(3000, silences);
    for (const part of plan) expect(part.end - part.start).toBeGreaterThanOrEqual(60);
    for (let i = 1; i < plan.length; i++) expect(plan[i].start).toBeGreaterThan(plan[i - 1].start);
  });

  it("covers a maximum-length recording", () => {
    const plan = planChunks(MAX_AUDIO_SECONDS, []);
    expect(plan[plan.length - 1].end).toBe(MAX_AUDIO_SECONDS);
    expect(plan.length).toBeLessThanOrEqual(40); // the server accepts at most 40 parts
  });

  it("formats cut times for ffmpeg's segment muxer", () => {
    const plan = planChunks(2400, []);
    expect(segmentTimes(plan)).toBe("480.000,960.000,1440.000,1920.000");
    expect(segmentTimes(planChunks(100, []))).toBe("");
  });
});

describe("choosing the upload path", () => {
  const mp3 = { name: "interview.mp3", size: 2_000_000 };

  it("sends short, small, supported files as they are", () => {
    expect(needsPreparation(mp3, 306)).toBe(false);
    expect(needsPreparation({ name: "voice.OGG", size: 500_000 }, 60)).toBe(false);
  });

  it("converts long files", () => {
    expect(needsPreparation(mp3, 11 * 60)).toBe(true);
  });

  it("converts big files (the 37 MB, 20-minute WAV)", () => {
    expect(needsPreparation({ name: "meeting.wav", size: 37 * 1024 * 1024 }, 20 * 60)).toBe(true);
    expect(needsPreparation({ name: "x.wav", size: 25 * 1024 * 1024 }, 60)).toBe(true);
  });

  it("converts formats the transcription service does not take, such as raw AAC", () => {
    expect(needsPreparation({ name: "note.aac", size: 100_000 }, 30)).toBe(true);
  });

  it("converts when the browser could not read the length", () => {
    expect(needsPreparation(mp3, 0)).toBe(true);
    expect(needsPreparation(mp3, NaN)).toBe(true);
  });
});

describe("accepted formats and limits", () => {
  const f = (name: string, type = "", size = 1000) => ({ name, type, size });

  it("accepts the formats WhatsApp and phones produce", () => {
    for (const name of ["a.opus", "a.ogg", "a.aac", "a.mp4", "a.webm", "a.m4a", "a.mp3", "a.wav", "a.flac"]) {
      expect(validateAudioFile(f(name))).toBeNull();
    }
  });

  it("accepts by MIME type when the name has no extension", () => {
    expect(validateAudioFile(f("voice-note", "audio/ogg"))).toBeNull();
  });

  it("rejects other files, and files over 500 MB", () => {
    expect(validateAudioFile(f("notes.pdf", "application/pdf"))).toMatch(/unsupported/i);
    expect(validateAudioFile(f("a.mp3", "audio/mpeg", 501 * 1024 * 1024))).toMatch(/500MB/);
    expect(validateAudioFile(f("a.mp3", "audio/mpeg", 500 * 1024 * 1024))).toBeNull();
  });

  it("does not treat a name that merely ends in 'mp3' as an mp3 (the dot matters)", () => {
    expect(validateAudioFile(f("notes_mp3"))).toMatch(/unsupported/i);
    expect(needsPreparation({ name: "notes_mp3", size: 100 }, 30)).toBe(true);
  });
});
