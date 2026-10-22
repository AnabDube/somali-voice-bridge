// Status model for the processing pipeline. Every page (dashboard, history,
// transcript) derives what it shows from the same step rows through
// deriveDisplayStatus(), so they always agree.
//
//   upload -> transcription -> cleaning / translation / research -> summary

export type StepName = "upload" | "transcription" | "cleaning" | "translation" | "research" | "summary";
export type StepStatus = "pending" | "processing" | "done" | "failed";

export interface StepRow {
  upload_id: string;
  step: StepName;
  status: StepStatus;
  error_message: string | null;
  attempts: number;
  updated_at: string;
}

export type StepMap = Partial<Record<StepName, StepRow>>;

export const STEP_TITLE: Record<StepName, string> = {
  upload: "Upload",
  transcription: "Transcription",
  cleaning: "Cleaning",
  translation: "Translation",
  research: "Research translation",
  summary: "Summary",
};

export const toStepMap = (rows: StepRow[]): StepMap => {
  const map: StepMap = {};
  for (const row of rows) map[row.step] = row;
  return map;
};

export type StatusTone = "ready" | "working" | "warning" | "failed" | "neutral";

export interface DisplayStatus {
  /** Short text for badges, e.g. "Transcript ready, translating…". */
  label: string;
  tone: StatusTone;
  /** Plain-English reason when something failed, otherwise null. */
  detail: string | null;
  /** Something is still running, so the UI should keep listening for updates. */
  busy: boolean;
  /** The Somali transcript exists and can be opened. */
  transcriptReady: boolean;
  /** The step to retry, if the problem is retryable. */
  failedStep: StepName | null;
}

const isActive = (step?: StepRow) => step?.status === "processing" || step?.status === "pending";

/** For recordings with no step rows (only the older audio_uploads.status). */
const fromLegacyStatus = (status: string): DisplayStatus => {
  switch (status) {
    case "completed":
      return { label: "Ready", tone: "ready", detail: null, busy: false, transcriptReady: true, failedStep: null };
    case "processing":
      return { label: "Transcribing…", tone: "working", detail: null, busy: true, transcriptReady: false, failedStep: null };
    case "failed":
      return { label: "Failed", tone: "failed", detail: null, busy: false, transcriptReady: false, failedStep: null };
    default:
      return { label: "Uploaded", tone: "neutral", detail: null, busy: false, transcriptReady: false, failedStep: null };
  }
};

export const deriveDisplayStatus = (legacyStatus: string, steps: StepMap): DisplayStatus => {
  if (Object.keys(steps).length === 0) return fromLegacyStatus(legacyStatus);

  const { upload, transcription, translation, cleaning, research, summary } = steps;

  if (upload?.status === "failed") {
    return {
      label: "Upload failed",
      tone: "failed",
      detail: upload.error_message ?? "The upload did not finish. Please upload the file again.",
      busy: false,
      transcriptReady: false,
      failedStep: null, // nothing to retry: the file has to be uploaded again
    };
  }
  if (isActive(upload)) {
    return { label: "Uploading…", tone: "working", detail: null, busy: true, transcriptReady: false, failedStep: null };
  }

  if (transcription?.status === "failed") {
    return {
      label: "Failed",
      tone: "failed",
      detail: transcription.error_message ?? "Transcription failed. Please retry.",
      busy: false,
      transcriptReady: false,
      failedStep: "transcription",
    };
  }
  if (!transcription || transcription.status !== "done") {
    return { label: "Transcribing…", tone: "working", detail: null, busy: true, transcriptReady: false, failedStep: null };
  }

  // The Somali transcript is ready. Translation and summary are enhancements:
  // they report their own state but never take the transcript away.
  const ready = { transcriptReady: true } as const;

  if (isActive(translation)) {
    return { ...ready, label: "Transcript ready, translating…", tone: "working", detail: null, busy: true, failedStep: null };
  }
  if (isActive(cleaning) || isActive(research)) {
    return { ...ready, label: "Transcript ready, finishing up…", tone: "working", detail: null, busy: true, failedStep: null };
  }
  // A failed translation is reported before a queued summary: the summary is
  // waiting on the translation, so showing "summarising…" would be a lie.
  if (translation?.status === "failed") {
    return {
      ...ready,
      label: "Transcript ready, translation failed",
      tone: "warning",
      detail: translation.error_message,
      busy: false,
      failedStep: "translation",
    };
  }
  if (isActive(summary)) {
    return { ...ready, label: "Transcript ready, summarising…", tone: "working", detail: null, busy: true, failedStep: null };
  }
  if (summary?.status === "failed") {
    return {
      ...ready,
      label: "Transcript ready, summary failed",
      tone: "warning",
      detail: summary.error_message,
      busy: false,
      failedStep: "summary",
    };
  }
  return { ...ready, label: "Ready", tone: "ready", detail: null, busy: false, failedStep: null };
};
