import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AlertCircle, ArrowLeft, Check, FileAudio, FileText, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Navbar from "@/components/Navbar";
import StatusBadge from "@/components/StatusBadge";
import ResearchSummaryPanel, { type ResearchSummary } from "@/components/ResearchSummaryPanel";
import TranscriptWorkspace from "@/components/transcript/TranscriptWorkspace";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useProfile } from "@/hooks/useProfile";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useProcessingSteps } from "@/hooks/useProcessingSteps";
import { useRetryStep } from "@/hooks/useRetryStep";
import { deriveDisplayStatus, type StepName } from "@/lib/pipeline";
import { toast } from "sonner";

// Current dialect options are maxaatiri + af_maay. Legacy keys kept so
// older uploads still render with a readable label.
const DIALECT_LABELS: Record<string, string> = {
  maxaatiri: "Maxaa-tiri",
  af_maay: "Af-Maay",
  standard: "Standard (legacy)",
  northern: "Northern (legacy)",
  benaadir: "Benaadir (legacy)",
  other: "Other (legacy)",
};

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

const Transcript = () => {
  const { uploadId } = useParams<{ uploadId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { profile } = useProfile();
  const isAdmin = useIsAdmin();
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  // The rows come straight from the database; the workspace and this page only read the fields they need.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [upload, setUpload] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [transcription, setTranscription] = useState<any>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [verifying, setVerifying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Live status of every step for this recording. It updates by itself (no
  // refresh), and the same data and derivation drive the dashboard badges, so
  // the two pages can never disagree.
  const { steps: allSteps, refetch: refetchSteps } = useProcessingSteps(uploadId ? [uploadId] : []);
  const steps = (uploadId && allSteps[uploadId]) || {};
  const display = deriveDisplayStatus(upload?.status ?? "uploaded", steps);

  // Pull fresh data for the recording and its transcript.
  const refreshData = useCallback(async () => {
    if (!uploadId) return;
    const [{ data: uploadRow }, { data: transcriptRow }] = await Promise.all([
      supabase.from("audio_uploads").select("*").eq("id", uploadId).single(),
      supabase.from("transcriptions").select("*").eq("upload_id", uploadId).maybeSingle(),
    ]);
    if (uploadRow) setUpload(uploadRow);
    if (transcriptRow) setTranscription(transcriptRow);
  }, [uploadId]);

  const { retry, isRetrying } = useRetryStep(() => {
    refreshData();
    refetchSteps();
  });
  const retryStep = (step: StepName) => {
    if (uploadId) retry(uploadId, step);
  };

  // Whenever a step changes, reload the transcript so new text appears.
  const stepSignature = Object.values(steps)
    .map((s) => `${s?.step}:${s?.status}:${s?.updated_at}:${s?.progress ?? ""}`)
    .join("|");
  useEffect(() => {
    if (!loading && !accessDenied) refreshData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepSignature]);

  useEffect(() => {
    if (!uploadId || !user) return;

    const fetchData = async () => {
      setLoading(true);
      const { data: uploadData, error: uploadErr } = await supabase.from("audio_uploads").select("*").eq("id", uploadId).single();

      if (uploadErr || !uploadData || uploadData.user_id !== user.id) {
        setAccessDenied(true);
        setLoading(false);
        return;
      }
      setUpload(uploadData);

      const { data: signedData } = await supabase.storage.from("audio-uploads").createSignedUrl(uploadData.file_path, 3600);
      if (signedData?.signedUrl) setAudioUrl(signedData.signedUrl);

      const { data: t } = await supabase.from("transcriptions").select("*").eq("upload_id", uploadId).maybeSingle();
      if (t) setTranscription(t);
      setLoading(false);
    };
    fetchData();
  }, [uploadId, user]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed, audioUrl]);

  // --------------------------------------------------------------- actions
  const handleToggleVerified = async () => {
    if (!transcription?.id || !user) return;
    if (!transcription.somali_text?.trim()) {
      toast.error("Cannot verify an empty transcript.");
      return;
    }
    setVerifying(true);
    const newValue = !transcription.verified_for_training;
    const { error } = await supabase
      .from("transcriptions")
      .update({
        verified_for_training: newValue,
        verified_by: newValue ? user.id : null,
        verified_at: newValue ? new Date().toISOString() : null,
      })
      .eq("id", transcription.id);
    if (error) {
      toast.error("Failed to update verification status.");
    } else {
      setTranscription((prev: Record<string, unknown>) => ({
        ...prev,
        verified_for_training: newValue,
        verified_by: newValue ? user.id : null,
        verified_at: newValue ? new Date().toISOString() : null,
      }));
      toast.success(
        newValue
          ? "Marked as verified. The corrected text will be included in training data (only if the uploader opted in)."
          : "Verification removed.",
      );
    }
    setVerifying(false);
  };

  const handleMarkReviewed = async () => {
    if (!transcription?.id) return;
    const reviewedAt = new Date().toISOString();
    const { error } = await supabase.from("transcriptions").update({ reviewed_at: reviewedAt }).eq("id", transcription.id);
    if (error) {
      toast.error("Couldn't mark the transcript as reviewed. Please try again.");
      return;
    }
    setTranscription((prev: Record<string, unknown>) => ({ ...prev, reviewed_at: reviewedAt }));
    toast.success("Marked as reviewed.");
  };

  // A new summary from the current (possibly corrected) text.
  const handleRegenerateSummary = async () => {
    if (!transcription?.id) return;
    const { error } = await supabase
      .from("transcriptions")
      .update({ research_summary: null, terminology: null, summary_notes: null })
      .eq("id", transcription.id);
    if (error) {
      toast.error("Couldn't start a new summary. Please try again.");
      return;
    }
    setTranscription((prev: Record<string, unknown>) => ({ ...prev, research_summary: null, terminology: null, summary_notes: null }));
    retryStep("summary");
  };

  const userName = profile?.display_name?.replace(/\s+/g, "_") || "user";
  const audioName = upload?.file_name?.replace(/\.[^.]+$/, "").replace(/\s+/g, "_") || "audio";

  // Exports the structured summary as a Word-compatible HTML file.
  const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const researchSummary: ResearchSummary | null = transcription?.research_summary ?? null;

  const downloadSummaryDoc = () => {
    if (!researchSummary) return;
    const title = `Research Summary — ${upload?.file_name || "Audio"}`;
    const themes = (researchSummary.key_themes || []).map((t) => `<li>${escapeHtml(t)}</li>`).join("");
    const quotes = (researchSummary.notable_quotes || [])
      .map(
        (q) =>
          `<blockquote><p><em>"${escapeHtml(q.quote)}"</em></p>${
            q.context ? `<p style="color:#666;font-size:10pt;">${escapeHtml(q.context)}</p>` : ""
          }</blockquote>`,
      )
      .join("");
    const actions = (researchSummary.action_points || []).map((p) => `<li>${escapeHtml(p)}</li>`).join("");

    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
      `<body style="font-family:Calibri,Arial,sans-serif;">` +
      `<h1>${escapeHtml(title)}</h1>` +
      (researchSummary.overview ? `<h2>Overview</h2><p>${escapeHtml(researchSummary.overview)}</p>` : "") +
      (themes ? `<h2>Key Themes</h2><ul>${themes}</ul>` : "") +
      (quotes ? `<h2>Notable Quotes</h2>${quotes}` : "") +
      (actions ? `<h2>Action Points</h2><ul>${actions}</ul>` : "") +
      `</body></html>`;

    const blob = new Blob([html], { type: "application/msword;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${userName}_${audioName}_summary.doc`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (accessDenied) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <main className="container mx-auto max-w-6xl px-4 pb-12 pt-24 text-center">
          <ShieldAlert className="mx-auto h-12 w-12 text-destructive" />
          <h1 className="mt-4 font-display text-2xl font-bold">Access Denied</h1>
          <p className="mt-2 text-muted-foreground">You don't have permission to view this transcript.</p>
          <Button variant="outline" className="mt-6" onClick={() => navigate("/dashboard")}>
            Back to Dashboard
          </Button>
        </main>
      </div>
    );
  }

  // What is happening comes from the step rows, never guessed from which text
  // columns happen to be empty. The Somali transcript is shown as soon as it
  // exists; translation and summary only add to it, and a failure in either
  // never hides it.
  const stepActive = (name: StepName) => steps[name]?.status === "pending" || steps[name]?.status === "processing";
  const transcribing = display.busy && !display.transcriptReady;
  const transcriptionFailed = display.tone === "failed" && !display.transcriptReady;

  const hasEnglish = !!transcription?.english_text;
  const translationActive = !hasEnglish && stepActive("translation");
  const hasSummary = !!researchSummary && Object.keys(researchSummary).length > 0;
  const isSummaryPending = !hasSummary && stepActive("summary");
  const summaryError = !hasSummary && steps.summary?.status === "failed" ? steps.summary.error_message : null;
  const dialectLabel = upload?.dialect ? DIALECT_LABELS[upload.dialect] || upload.dialect : null;

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="container mx-auto max-w-6xl px-4 pb-12 pt-24">
        <Button variant="ghost" className="mb-6 gap-2 text-muted-foreground" onClick={() => navigate("/dashboard")}>
          <ArrowLeft className="h-4 w-4" /> Back to Dashboard
        </Button>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="mt-3 text-sm text-muted-foreground">Loading transcript…</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="mb-5 flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted">
                <FileAudio className="h-6 w-6 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate font-display text-xl font-bold">{upload?.file_name || "Audio File"}</h1>
                  {dialectLabel && (
                    <Badge variant="secondary" className="shrink-0 text-xs">
                      {dialectLabel}
                    </Badge>
                  )}
                  {transcription?.verified_for_training && (
                    <Badge variant="default" className="shrink-0 gap-1 text-xs">
                      <ShieldCheck className="h-3 w-3" /> Verified for training
                    </Badge>
                  )}
                  {transcription?.reviewed_at && (
                    <Badge variant="outline" className="shrink-0 gap-1 text-xs">
                      <Check className="h-3 w-3" aria-hidden="true" /> Reviewed
                    </Badge>
                  )}
                  <StatusBadge status={display} />
                </div>
                <p className="text-sm text-muted-foreground">Transcript &amp; translation</p>
              </div>
              {isAdmin && transcription?.somali_text && (
                <Button
                  variant={transcription?.verified_for_training ? "secondary" : "outline"}
                  size="sm"
                  className="shrink-0 gap-1.5"
                  onClick={handleToggleVerified}
                  disabled={verifying}
                  title="Mark this transcript as accurate so its corrected text can be used to fine-tune the model"
                >
                  {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  {transcription?.verified_for_training ? "Unverify" : "Verify for training"}
                </Button>
              )}
            </div>

            {/* Audio player: stays in view while you work through the transcript */}
            {audioUrl && (
              /* Sticky on larger screens; on a phone it would take too much of the screen, so it scrolls with the page. */
            <div className="z-30 mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-card backdrop-blur sm:sticky sm:top-16">
                <audio ref={audioRef} src={audioUrl} className="min-w-[14rem] flex-1" controls preload="metadata" aria-label="Recording" />
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Speed
                  <select
                    value={speed}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                    className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {SPEEDS.map((s) => (
                      <option key={s} value={s}>
                        {s}×
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {transcribing ? (
              <div className="rounded-xl border border-border bg-card p-12 text-center shadow-card">
                <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
                <p className="mt-4 font-display text-lg font-semibold">{display.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  This may take a minute depending on the file length. You can leave this page — it keeps going and will be
                  ready when you come back.
                </p>
              </div>
            ) : transcriptionFailed ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
                <AlertCircle className="mx-auto h-8 w-8 text-destructive" />
                <p className="mt-3 font-display text-lg font-semibold text-destructive">{display.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">{display.detail ?? "Something went wrong. Please retry."}</p>
                {display.failedStep === "transcription" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4 gap-1.5"
                    disabled={!!uploadId && isRetrying(uploadId, "transcription")}
                    onClick={() => retryStep("transcription")}
                  >
                    {uploadId && isRetrying(uploadId, "transcription") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Retry transcription
                  </Button>
                )}
              </div>
            ) : transcription ? (
              <div className="space-y-6">
                <TranscriptWorkspace
                  transcription={transcription}
                  fileName={upload?.file_name || "Transcript"}
                  userName={userName}
                  audioName={audioName}
                  audioRef={audioRef}
                  hasAudio={!!audioUrl}
                  translation={{
                    active: translationActive,
                    failed: !hasEnglish && !translationActive,
                    error: steps.translation?.error_message ?? "Translation did not finish.",
                    progress: steps.translation?.progress ?? null,
                    retrying: !!uploadId && isRetrying(uploadId, "translation"),
                  }}
                  onRetryTranslation={() => retryStep("translation")}
                  onTranscriptChanged={refreshData}
                  onMarkReviewed={handleMarkReviewed}
                />

                <ResearchSummaryPanel
                  summary={researchSummary}
                  isPending={isSummaryPending}
                  errorMessage={summaryError}
                  isRetrying={!!uploadId && isRetrying(uploadId, "summary")}
                  onExportDoc={downloadSummaryDoc}
                  onRetry={hasEnglish ? () => retryStep("summary") : undefined}
                  onRegenerate={hasEnglish ? handleRegenerateSummary : undefined}
                />
              </div>
            ) : (
              <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
                <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
                There is no transcript for this recording yet.
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default Transcript;
