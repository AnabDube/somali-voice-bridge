import { describe, it, expect } from "vitest";
import { deriveDisplayStatus, toStepMap, type StepName, type StepStatus } from "@/lib/pipeline";
import { friendlyUploadError } from "@/lib/audio";

const steps = (spec: Partial<Record<StepName, StepStatus | [StepStatus, string]>>) =>
  toStepMap(
    Object.entries(spec).map(([step, value]) => {
      const [status, error] = Array.isArray(value) ? value : [value as StepStatus, null];
      return {
        upload_id: "u1",
        step: step as StepName,
        status,
        error_message: error,
        attempts: 1,
        updated_at: "2026-10-22T10:00:00Z",
      };
    }),
  );

const allDone = { upload: "done", transcription: "done", cleaning: "done", translation: "done", research: "done", summary: "done" } as const;

describe("deriveDisplayStatus", () => {
  it("says Ready only when everything has finished", () => {
    const s = deriveDisplayStatus("completed", steps(allDone));
    expect(s).toMatchObject({ label: "Ready", tone: "ready", busy: false, transcriptReady: true, failedStep: null });
  });

  it("shows an in-progress upload", () => {
    const s = deriveDisplayStatus("uploaded", steps({ upload: "processing" }));
    expect(s).toMatchObject({ label: "Uploading…", busy: true, transcriptReady: false });
  });

  it("shows a failed upload with its reason and nothing to retry", () => {
    const s = deriveDisplayStatus("failed", steps({ upload: ["failed", "File too large. Please upload a smaller recording."] }));
    expect(s).toMatchObject({ label: "Upload failed", tone: "failed", failedStep: null });
    expect(s.detail).toBe("File too large. Please upload a smaller recording.");
  });

  it("shows transcription as running while pending or processing", () => {
    for (const status of ["pending", "processing"] as const) {
      const s = deriveDisplayStatus("processing", steps({ upload: "done", transcription: status }));
      expect(s).toMatchObject({ label: "Transcribing…", busy: true, transcriptReady: false });
    }
  });

  it("shows a failed transcription with its reason and a retry target", () => {
    const s = deriveDisplayStatus(
      "failed",
      steps({ upload: "done", transcription: ["failed", "The transcription service is busy. Please retry in a minute."] }),
    );
    expect(s).toMatchObject({ label: "Failed", tone: "failed", failedStep: "transcription", transcriptReady: false });
    expect(s.detail).toContain("busy");
  });

  it('says "Transcript ready, translating…" while translation runs, and keeps the transcript open', () => {
    const s = deriveDisplayStatus("completed", steps({ ...allDone, translation: "processing", summary: "pending" }));
    expect(s).toMatchObject({ label: "Transcript ready, translating…", tone: "working", busy: true, transcriptReady: true });
  });

  it("treats a queued (pending) translation as running, not ready", () => {
    const s = deriveDisplayStatus("completed", steps({ ...allDone, translation: "pending" }));
    expect(s.label).toBe("Transcript ready, translating…");
  });

  it("reports a failed translation without taking the transcript away", () => {
    const s = deriveDisplayStatus(
      "completed",
      steps({ ...allDone, translation: ["failed", "The AI service is busy right now. Please retry in a minute."], summary: "pending" }),
    );
    expect(s).toMatchObject({
      label: "Transcript ready, translation failed",
      tone: "warning",
      failedStep: "translation",
      transcriptReady: true,
      busy: false,
    });
  });

  it("reports a failed summary separately", () => {
    const s = deriveDisplayStatus("completed", steps({ ...allDone, summary: ["failed", "Summary failed. Please retry."] }));
    expect(s).toMatchObject({ label: "Transcript ready, summary failed", failedStep: "summary", transcriptReady: true });
  });

  it("does not surface a failed cleaning or research step as a problem", () => {
    const s = deriveDisplayStatus("completed", steps({ ...allDone, cleaning: ["failed", "x"], research: ["failed", "x"] }));
    expect(s).toMatchObject({ label: "Ready", tone: "ready" });
  });

  it("gives every page the same answer for the same data", () => {
    const data = steps({ ...allDone, translation: "processing" });
    // The dashboard passes the legacy column "completed", the transcript page may see "processing":
    // the step rows win, so they cannot disagree.
    expect(deriveDisplayStatus("completed", data)).toEqual(deriveDisplayStatus("processing", data));
  });

  it("falls back to the older status column when there are no step rows", () => {
    expect(deriveDisplayStatus("completed", {})).toMatchObject({ label: "Ready", transcriptReady: true });
    expect(deriveDisplayStatus("processing", {})).toMatchObject({ label: "Transcribing…", busy: true });
    expect(deriveDisplayStatus("failed", {})).toMatchObject({ label: "Failed", tone: "failed" });
    expect(deriveDisplayStatus("uploaded", {})).toMatchObject({ label: "Uploaded", tone: "neutral" });
  });
});

describe("friendlyUploadError", () => {
  it("explains common storage failures in plain English", () => {
    expect(friendlyUploadError(new Error("The object exceeded the maximum allowed size"))).toMatch(/too large/i);
    expect(friendlyUploadError({ message: "mime type audio/x-foo is not supported" })).toMatch(/unsupported format/i);
    expect(friendlyUploadError(new TypeError("Failed to fetch"))).toMatch(/network/i);
    expect(friendlyUploadError({ message: "new row violates row-level security policy" })).toMatch(/session/i);
  });

  it("never leaks a raw technical message for unknown errors", () => {
    expect(friendlyUploadError(new Error("pg: something internal"))).toBe("The upload failed. Please try again.");
    expect(friendlyUploadError(undefined)).toBe("The upload failed. Please try again.");
  });
});
