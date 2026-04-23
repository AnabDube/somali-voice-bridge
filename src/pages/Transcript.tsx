import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Copy, Check, Loader2, FileAudio,
  Download, FileText, FileType, AlertCircle, ShieldAlert, Play, Pause,
  Pencil, Save, Clock, ShieldCheck, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import Navbar from "@/components/Navbar";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useProfile } from "@/hooks/useProfile";
import { toast } from "sonner";
import jsPDF from "jspdf";
import ResearchSummaryPanel, { type ResearchSummary } from "@/components/ResearchSummaryPanel";

interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
}

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

const formatTimestamp = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const Transcript = () => {
  const { uploadId } = useParams<{ uploadId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { profile } = useProfile();
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [upload, setUpload] = useState<any>(null);
  const [transcription, setTranscription] = useState<any>(null);
  const [copiedSomali, setCopiedSomali] = useState(false);
  const [copiedEnglish, setCopiedEnglish] = useState(false);
  const [translationFailed, setTranslationFailed] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedText, setEditedText] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [showSegments, setShowSegments] = useState(false);
  const [activeSegment, setActiveSegment] = useState(-1);
  const [verifying, setVerifying] = useState(false);
  const [showCleaned, setShowCleaned] = useState(true);
  const [showResearch, setShowResearch] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const rafRef = useRef<number>();

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = undefined;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const { data: t } = await supabase
        .from("transcriptions")
        .select("*")
        .eq("upload_id", uploadId!)
        .single();
      if (t) {
        setTranscription(t);
        if (
          t.english_text &&
          t.somali_text_cleaned &&
          t.english_text_research &&
          t.research_summary
        ) stopPolling();
      }
      const { data: uploadData } = await supabase
        .from("audio_uploads")
        .select("status")
        .eq("id", uploadId!)
        .single();
      if (uploadData) {
        setUpload((prev: any) => (prev ? { ...prev, status: uploadData.status } : prev));
        if (uploadData.status === "failed") stopPolling();
      }
    }, 1500);
  }, [uploadId, stopPolling]);

  // Parse segments from transcription
  const segments: Segment[] = (() => {
    try {
      const raw = transcription?.speaker_timestamps;
      if (!raw || !Array.isArray(raw)) return [];
      return raw.filter((s: any) => typeof s.start === "number" && typeof s.end === "number" && s.text);
    } catch {
      return [];
    }
  })();

  // RAF loop to track active segment
  useEffect(() => {
    const tick = () => {
      if (audioRef.current && !audioRef.current.paused && segments.length > 0) {
        const ct = audioRef.current.currentTime;
        const idx = segments.findIndex((s) => ct >= s.start && ct < s.end);
        setActiveSegment(idx);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    if (isPlaying && segments.length > 0) {
      rafRef.current = requestAnimationFrame(tick);
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, segments]);

  const seekTo = (seconds: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = seconds;
    audioRef.current.play();
    setIsPlaying(true);
  };

  useEffect(() => {
    if (!uploadId || !user) return;

    const fetchData = async () => {
      setLoading(true);
      const { data: uploadData, error: uploadErr } = await supabase
        .from("audio_uploads")
        .select("*")
        .eq("id", uploadId)
        .single();

      if (uploadErr || !uploadData) {
        setAccessDenied(true);
        setLoading(false);
        return;
      }
      if (uploadData.user_id !== user.id) {
        setAccessDenied(true);
        setLoading(false);
        return;
      }
      setUpload(uploadData);

      const { data: signedData } = await supabase.storage
        .from("audio-uploads")
        .createSignedUrl(uploadData.file_path, 3600);
      if (signedData?.signedUrl) setAudioUrl(signedData.signedUrl);

      const { data: t } = await supabase
        .from("transcriptions")
        .select("*")
        .eq("upload_id", uploadId)
        .single();
      if (t) setTranscription(t);
      setLoading(false);

      if (
        uploadData.status === "processing" ||
        (t?.somali_text && !t?.english_text) ||
        (t?.somali_text && !t?.somali_text_cleaned)
      ) {
        startPolling();
      }
    };
    fetchData();
    return () => stopPolling();
  }, [uploadId, user, startPolling, stopPolling]);

  const handleRetryTranslation = async () => {
    if (!transcription?.id) return;
    setTranslationFailed(false);
    const { error } = await supabase.functions.invoke("translate-text", {
      body: { transcription_id: transcription.id },
    });
    if (error) {
      setTranslationFailed(true);
      toast.error("Translation failed. Please try again.");
    } else {
      startPolling();
    }
  };

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
      } as any)
      .eq("id", transcription.id);
    if (error) {
      toast.error("Failed to update verification status.");
    } else {
      setTranscription((prev: any) => ({
        ...prev,
        verified_for_training: newValue,
        verified_by: newValue ? user.id : null,
        verified_at: newValue ? new Date().toISOString() : null,
      }));
      toast.success(
        newValue
          ? "Marked as verified — this transcript will be included in training data."
          : "Verification removed."
      );
    }
    setVerifying(false);
  };

  const handleEditSave = async () => {
    if (!transcription?.id || !editedText.trim()) return;
    setIsSaving(true);
    const { error } = await supabase
      .from("transcriptions")
      .update({ somali_text: editedText.trim(), english_text: null })
      .eq("id", transcription.id);
    if (error) {
      toast.error("Failed to save edit.");
    } else {
      setTranscription((prev: any) => ({ ...prev, somali_text: editedText.trim(), english_text: null }));
      setIsEditing(false);
      toast.success("Transcript updated. Re-translating…");
      const { error: translateErr } = await supabase.functions.invoke("translate-text", {
        body: { transcription_id: transcription.id },
      });
      if (translateErr) {
        setTranslationFailed(true);
      } else {
        setTranslationFailed(false);
        startPolling();
      }
    }
    setIsSaving(false);
  };

  const togglePlayback = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const userName = profile?.display_name?.replace(/\s+/g, "_") || "user";
  const audioName = upload?.file_name?.replace(/\.[^.]+$/, "").replace(/\s+/g, "_") || "audio";

  const handleCopy = async (text: string, type: "somali" | "english") => {
    await navigator.clipboard.writeText(text);
    if (type === "somali") {
      setCopiedSomali(true);
      setTimeout(() => setCopiedSomali(false), 2000);
    } else {
      setCopiedEnglish(true);
      setTimeout(() => setCopiedEnglish(false), 2000);
    }
    toast.success("Copied to clipboard");
  };

  const downloadTxt = (content: string, suffix: string) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${userName}_${audioName}_${suffix}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPdf = (content: string, title: string, suffix: string) => {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(title, 20, 20);
    doc.setFontSize(11);
    const lines = doc.splitTextToSize(content, 170);
    doc.text(lines, 20, 35);
    doc.save(`${userName}_${audioName}_${suffix}.pdf`);
  };

  // Exports the structured summary as a Word-compatible HTML file.
  // Pragmatic choice: Word opens HTML-as-.doc cleanly, and this avoids
  // shipping a docx library in the frontend bundle. Users can Save As
  // a real .docx from Word if they need one.
  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const downloadSummaryDoc = () => {
    if (!researchSummary) return;
    const title = `Research Summary — ${upload?.file_name || "Audio"}`;
    const themes = (researchSummary.key_themes || [])
      .map((t) => `<li>${escapeHtml(t)}</li>`)
      .join("");
    const quotes = (researchSummary.notable_quotes || [])
      .map(
        (q) =>
          `<blockquote><p><em>"${escapeHtml(q.quote)}"</em></p>${
            q.context ? `<p style="color:#666;font-size:10pt;">${escapeHtml(q.context)}</p>` : ""
          }</blockquote>`
      )
      .join("");
    const actions = (researchSummary.action_points || [])
      .map((p) => `<li>${escapeHtml(p)}</li>`)
      .join("");

    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
      `<body style="font-family:Calibri,Arial,sans-serif;">` +
      `<h1>${escapeHtml(title)}</h1>` +
      (researchSummary.overview
        ? `<h2>Overview</h2><p>${escapeHtml(researchSummary.overview)}</p>`
        : "") +
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

  const handleRetrySummary = async () => {
    if (!transcription?.id) return;
    const { error } = await supabase.functions.invoke("generate-summary", {
      body: { transcription_id: transcription.id },
    });
    if (error) {
      toast.error("Could not generate summary. Please try again.");
    } else {
      toast.success("Generating summary…");
      startPolling();
    }
  };

  if (accessDenied) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <main className="container mx-auto max-w-6xl px-4 pb-12 pt-24 text-center">
          <ShieldAlert className="mx-auto h-12 w-12 text-destructive" />
          <h1 className="mt-4 font-display text-2xl font-bold">Access Denied</h1>
          <p className="mt-2 text-muted-foreground">
            You don't have permission to view this transcript.
          </p>
          <Button variant="outline" className="mt-6" onClick={() => navigate("/dashboard")}>
            Back to Dashboard
          </Button>
        </main>
      </div>
    );
  }

  const isProcessing = upload?.status === "processing";
  const isFailed = upload?.status === "failed";
  const somaliRaw = transcription?.somali_text || "";
  const somaliCleaned = transcription?.somali_text_cleaned || "";
  const hasCleaned = !!somaliCleaned;
  const isCleaning = !!somaliRaw && !hasCleaned && transcription?.processing_stage !== "failed";
  const somaliText = hasCleaned && showCleaned ? somaliCleaned : somaliRaw;
  const englishStandard = transcription?.english_text || "";
  const englishResearch = transcription?.english_text_research || "";
  const hasResearch = !!englishResearch;
  const englishText = showResearch && hasResearch ? englishResearch : englishStandard;
  const hasEnglish = !!englishText;
  const isTranslating = !!somaliRaw && !englishStandard && !translationFailed;
  const isResearchTranslating = !!somaliRaw && !hasResearch && !translationFailed;
  const researchSummary: ResearchSummary | null = transcription?.research_summary ?? null;
  const hasSummary = !!researchSummary && Object.keys(researchSummary).length > 0;
  const isSummaryPending = !!englishStandard && !hasSummary;
  const dialectLabel = upload?.dialect ? DIALECT_LABELS[upload.dialect] || upload.dialect : null;

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="container mx-auto max-w-6xl px-4 pb-12 pt-24">
        <Button
          variant="ghost"
          className="mb-6 gap-2 text-muted-foreground"
          onClick={() => navigate("/dashboard")}
        >
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
            <div className="mb-6 flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted">
                <FileAudio className="h-6 w-6 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="font-display text-xl font-bold truncate">
                    {upload?.file_name || "Audio File"}
                  </h1>
                  {dialectLabel && (
                    <Badge variant="secondary" className="text-xs shrink-0">
                      {dialectLabel}
                    </Badge>
                  )}
                  {transcription?.verified_for_training && (
                    <Badge variant="default" className="gap-1 text-xs shrink-0">
                      <ShieldCheck className="h-3 w-3" /> Verified for training
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">Transcript & Translation</p>
              </div>
              {transcription?.somali_text && !isEditing && (
                <Button
                  variant={transcription?.verified_for_training ? "secondary" : "outline"}
                  size="sm"
                  className="gap-1.5 shrink-0"
                  onClick={handleToggleVerified}
                  disabled={verifying}
                  title="Mark this transcript as accurate so it can be used to fine-tune the model"
                >
                  {verifying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  )}
                  {transcription?.verified_for_training ? "Unverify" : "Verify for training"}
                </Button>
              )}
            </div>

            {/* Audio Player */}
            {audioUrl && (
              <div className="mb-6 flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-card">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 shrink-0"
                  onClick={togglePlayback}
                >
                  {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </Button>
                <audio
                  ref={audioRef}
                  src={audioUrl}
                  onEnded={() => setIsPlaying(false)}
                  onPause={() => setIsPlaying(false)}
                  onPlay={() => setIsPlaying(true)}
                  className="w-full"
                  controls
                />
              </div>
            )}

            {isProcessing ? (
              <div className="rounded-xl border border-border bg-card p-12 text-center shadow-card">
                <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
                <p className="mt-4 font-display text-lg font-semibold">Transcribing audio…</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  This may take a minute depending on the file length.
                </p>
              </div>
            ) : isFailed ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
                <p className="font-display text-lg font-semibold text-destructive">
                  Transcription Failed
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Something went wrong. Please try uploading the file again.
                </p>
              </div>
            ) : (
              <>
              <div className="grid gap-6 md:grid-cols-2">
                {/* Somali Panel */}
                <TranscriptPanelInline
                  title="Somali Transcript"
                  content={somaliText || "No transcript available yet."}
                  hasContent={!!somaliText}
                  copied={copiedSomali}
                  onCopy={() => somaliText && handleCopy(somaliText, "somali")}
                  onDownloadTxt={() => downloadTxt(somaliText, "transcript")}
                  onDownloadPdf={() => downloadPdf(somaliText, "Somali Transcript", "transcript")}
                  isEditing={isEditing}
                  editedText={editedText}
                  onEditStart={() => { setEditedText(somaliRaw); setIsEditing(true); }}
                  onEditChange={setEditedText}
                  onEditSave={handleEditSave}
                  onEditCancel={() => setIsEditing(false)}
                  isSaving={isSaving}
                  segments={segments}
                  showSegments={showSegments}
                  onToggleSegments={() => setShowSegments(!showSegments)}
                  activeSegment={activeSegment}
                  onSeekTo={seekTo}
                  hasCleaned={hasCleaned}
                  isCleaning={isCleaning}
                  showCleaned={showCleaned}
                  onToggleCleaned={() => setShowCleaned(!showCleaned)}
                />

                {/* English Panel */}
                <TranscriptPanelInline
                  title="English Translation"
                  content={hasEnglish ? englishText : translationFailed ? "" : "Translating…"}
                  hasContent={hasEnglish}
                  isPending={isTranslating}
                  isFailed={translationFailed}
                  onRetry={handleRetryTranslation}
                  copied={copiedEnglish}
                  onCopy={() => hasEnglish && handleCopy(englishText, "english")}
                  onDownloadTxt={hasEnglish ? () => downloadTxt(englishText, showResearch ? "translation-research" : "translation") : undefined}
                  onDownloadPdf={hasEnglish ? () => downloadPdf(englishText, showResearch ? "English Translation (Research)" : "English Translation", showResearch ? "translation-research" : "translation") : undefined}
                  hasResearch={hasResearch}
                  isResearchPending={isResearchTranslating}
                  showResearch={showResearch}
                  onToggleResearch={() => setShowResearch(!showResearch)}
                />
              </div>

              {somaliRaw && (
                <div className="mt-6">
                  <ResearchSummaryPanel
                    summary={researchSummary}
                    isPending={isSummaryPending}
                    onExportDoc={downloadSummaryDoc}
                    onRetry={hasEnglish ? handleRetrySummary : undefined}
                  />
                </div>
              )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
};

interface TranscriptPanelInlineProps {
  title: string;
  content: string;
  hasContent: boolean;
  isPending?: boolean;
  isFailed?: boolean;
  onRetry?: () => void;
  copied: boolean;
  onCopy: () => void;
  onDownloadTxt?: () => void;
  onDownloadPdf?: () => void;
  isEditing?: boolean;
  editedText?: string;
  onEditStart?: () => void;
  onEditChange?: (text: string) => void;
  onEditSave?: () => void;
  onEditCancel?: () => void;
  isSaving?: boolean;
  segments?: Segment[];
  showSegments?: boolean;
  onToggleSegments?: () => void;
  activeSegment?: number;
  onSeekTo?: (seconds: number) => void;
  hasCleaned?: boolean;
  isCleaning?: boolean;
  showCleaned?: boolean;
  onToggleCleaned?: () => void;
  hasResearch?: boolean;
  isResearchPending?: boolean;
  showResearch?: boolean;
  onToggleResearch?: () => void;
}

const TranscriptPanelInline = ({
  title,
  content,
  hasContent,
  isPending,
  isFailed,
  onRetry,
  copied,
  onCopy,
  onDownloadTxt,
  onDownloadPdf,
  isEditing,
  editedText,
  onEditStart,
  onEditChange,
  onEditSave,
  onEditCancel,
  isSaving,
  segments = [],
  showSegments,
  onToggleSegments,
  activeSegment = -1,
  onSeekTo,
  hasCleaned,
  isCleaning,
  showCleaned,
  onToggleCleaned,
  hasResearch,
  isResearchPending,
  showResearch,
  onToggleResearch,
}: TranscriptPanelInlineProps) => (
  <div className="flex flex-col rounded-xl border border-border bg-card shadow-card overflow-hidden">
    <div className="flex items-center justify-between border-b border-border px-5 py-3">
      <div className="flex items-center gap-2">
        <h3 className="font-display text-sm font-semibold">{title}</h3>
        {hasCleaned && showCleaned && !isEditing && (
          <Badge variant="secondary" className="h-5 gap-1 text-[10px]">
            <Sparkles className="h-2.5 w-2.5" /> Cleaned
          </Badge>
        )}
        {isCleaning && !hasCleaned && !isEditing && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="h-2.5 w-2.5 animate-spin" /> Cleaning…
          </span>
        )}
        {hasResearch && showResearch && !isEditing && (
          <Badge variant="secondary" className="h-5 gap-1 text-[10px]">
            <Sparkles className="h-2.5 w-2.5" /> Research
          </Badge>
        )}
        {isResearchPending && !hasResearch && !isEditing && onToggleResearch && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="h-2.5 w-2.5 animate-spin" /> Research…
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {hasCleaned && !isEditing && onToggleCleaned && (
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={onToggleCleaned}>
            {showCleaned ? (
              <><FileText className="h-3.5 w-3.5" /> Raw</>
            ) : (
              <><Sparkles className="h-3.5 w-3.5" /> Cleaned</>
            )}
          </Button>
        )}
        {hasResearch && !isEditing && onToggleResearch && (
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={onToggleResearch}>
            {showResearch ? (
              <><FileText className="h-3.5 w-3.5" /> Standard</>
            ) : (
              <><Sparkles className="h-3.5 w-3.5" /> Research</>
            )}
          </Button>
        )}
        {segments.length > 0 && !isEditing && onToggleSegments && (
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={onToggleSegments}>
            {showSegments ? (
              <><FileText className="h-3.5 w-3.5" /> Plain</>
            ) : (
              <><Clock className="h-3.5 w-3.5" /> Timestamps</>
            )}
          </Button>
        )}
        {hasContent && !isEditing && onEditStart && (
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={onEditStart}>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
        )}
        {isEditing && (
          <>
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={onEditCancel} disabled={isSaving}>
              Cancel
            </Button>
            <Button variant="default" size="sm" className="gap-1.5 text-xs" onClick={onEditSave} disabled={isSaving}>
              {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save & Re-translate
            </Button>
          </>
        )}
        {hasContent && !isEditing && (
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={onCopy}>
            {copied ? (
              <><Check className="h-3.5 w-3.5" /> Copied</>
            ) : (
              <><Copy className="h-3.5 w-3.5" /> Copy</>
            )}
          </Button>
        )}
      </div>
    </div>

    <div className="flex-1 overflow-y-auto p-5" style={{ maxHeight: "400px" }}>
      {isFailed ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <p className="mt-3 text-sm font-medium text-destructive">Translation failed</p>
          <p className="mt-1 text-xs text-muted-foreground">Something went wrong. Please try again.</p>
          {onRetry && (
            <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
              Retry Translation
            </Button>
          )}
        </div>
      ) : isPending ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/50" />
          <p className="mt-3 text-sm italic text-muted-foreground">{content}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Translation will appear here shortly.
          </p>
        </div>
      ) : isEditing ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5" />
            Edit the transcript below if it's incorrect. Saving will re-translate.
          </p>
          <Textarea
            value={editedText}
            onChange={(e) => onEditChange?.(e.target.value)}
            className="min-h-[200px] text-sm leading-relaxed"
            disabled={isSaving}
          />
        </div>
      ) : showSegments && segments.length > 0 ? (
        <div className="space-y-1">
          {segments.map((seg, i) => (
            <div
              key={seg.id ?? i}
              className={`flex items-start gap-3 rounded-lg px-3 py-2 transition-colors ${
                i === activeSegment ? "bg-primary/10" : "hover:bg-muted/50"
              }`}
            >
              <button
                onClick={() => onSeekTo?.(seg.start)}
                className="mt-0.5 shrink-0 rounded-md bg-muted px-2 py-0.5 font-mono text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                {formatTimestamp(seg.start)}
              </button>
              <span className="text-sm leading-relaxed">{seg.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{content}</p>
      )}
    </div>

    {hasContent && !isEditing && (onDownloadTxt || onDownloadPdf) && (
      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <Download className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Export:</span>
        {onDownloadTxt && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={onDownloadTxt}>
            <FileText className="h-3 w-3" /> TXT
          </Button>
        )}
        {onDownloadPdf && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={onDownloadPdf}>
            <FileType className="h-3 w-3" /> PDF
          </Button>
        )}
      </div>
    )}
  </div>
);

export default Transcript;
