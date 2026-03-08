import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Copy, Check, Loader2, FileAudio,
  Download, FileText, FileType, AlertCircle, ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import Navbar from "@/components/Navbar";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useProfile } from "@/hooks/useProfile";
import { toast } from "sonner";
import jsPDF from "jspdf";

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

      // RLS will prevent non-owners from seeing the upload,
      // but double-check ownership
      if (uploadData.user_id !== user.id) {
        setAccessDenied(true);
        setLoading(false);
        return;
      }

      setUpload(uploadData);

      const { data: t } = await supabase
        .from("transcriptions")
        .select("*")
        .eq("upload_id", uploadId)
        .single();

      if (t) setTranscription(t);
      setLoading(false);
    };

    fetchData();

    // Poll for status changes
    const interval = setInterval(async () => {
      const { data: uploadData } = await supabase
        .from("audio_uploads")
        .select("status")
        .eq("id", uploadId)
        .single();

      if (uploadData?.status === "completed" || uploadData?.status === "failed") {
        const { data: t } = await supabase
          .from("transcriptions")
          .select("*")
          .eq("upload_id", uploadId)
          .single();
        if (t) setTranscription(t);
        setUpload((prev: any) => (prev ? { ...prev, status: uploadData.status } : prev));

        if (uploadData.status === "failed" || t?.english_text) {
          clearInterval(interval);
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [uploadId, user]);

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
      const { data: t } = await supabase
        .from("transcriptions")
        .select("*")
        .eq("upload_id", uploadId)
        .single();
      if (t) setTranscription(t);
      if (!t?.english_text) setTranslationFailed(true);
    }
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
  const somaliText = transcription?.somali_text || "";
  const englishText = transcription?.english_text || "";
  const hasEnglish = !!englishText;
  const isTranslating = !!somaliText && !hasEnglish && !translationFailed;

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
                <h1 className="font-display text-xl font-bold truncate">
                  {upload?.file_name || "Audio File"}
                </h1>
                <p className="text-sm text-muted-foreground">Transcript & Translation</p>
              </div>
            </div>

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
                  onDownloadTxt={hasEnglish ? () => downloadTxt(englishText, "translation") : undefined}
                  onDownloadPdf={hasEnglish ? () => downloadPdf(englishText, "English Translation", "translation") : undefined}
                />
              </div>
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
}: TranscriptPanelInlineProps) => (
  <div className="flex flex-col rounded-xl border border-border bg-card shadow-card overflow-hidden">
    <div className="flex items-center justify-between border-b border-border px-5 py-3">
      <h3 className="font-display text-sm font-semibold">{title}</h3>
      <div className="flex items-center gap-1">
        {hasContent && (
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
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{content}</p>
      )}
    </div>

    {hasContent && (onDownloadTxt || onDownloadPdf) && (
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
