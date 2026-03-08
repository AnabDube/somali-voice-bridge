import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Copy, Check, Loader2, FileAudio } from "lucide-react";
import { Button } from "@/components/ui/button";
import Navbar from "@/components/Navbar";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const Transcript = () => {
  const { uploadId } = useParams<{ uploadId: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [upload, setUpload] = useState<any>(null);
  const [transcription, setTranscription] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!uploadId) return;

    const fetchData = async () => {
      setLoading(true);

      const [uploadRes, transcriptRes] = await Promise.all([
        supabase.from("audio_uploads").select("*").eq("id", uploadId).single(),
        supabase.from("transcriptions").select("*").eq("upload_id", uploadId).single(),
      ]);

      if (uploadRes.data) setUpload(uploadRes.data);
      if (transcriptRes.data) setTranscription(transcriptRes.data);
      setLoading(false);
    };

    fetchData();

    // Poll while processing
    const interval = setInterval(async () => {
      const { data } = await supabase
        .from("audio_uploads")
        .select("status")
        .eq("id", uploadId)
        .single();

      if (data?.status === "completed") {
        const { data: t } = await supabase
          .from("transcriptions")
          .select("*")
          .eq("upload_id", uploadId)
          .single();
        if (t) setTranscription(t);
        setUpload((prev: any) => prev ? { ...prev, status: "completed" } : prev);
        clearInterval(interval);
      } else if (data?.status === "failed") {
        setUpload((prev: any) => prev ? { ...prev, status: "failed" } : prev);
        clearInterval(interval);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [uploadId]);

  const handleCopy = async () => {
    if (!transcription?.somali_text) return;
    await navigator.clipboard.writeText(transcription.somali_text);
    setCopied(true);
    toast.success("Transcript copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const isProcessing = upload?.status === "processing";
  const isFailed = upload?.status === "failed";

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="container mx-auto max-w-3xl px-4 pb-12 pt-24">
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
                <p className="text-sm text-muted-foreground">Somali Transcript</p>
              </div>
            </div>

            {/* Content */}
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
            ) : transcription?.somali_text ? (
              <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
                <div className="flex items-center justify-between border-b border-border px-5 py-3">
                  <h3 className="font-display text-sm font-semibold">Somali Text</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2 text-xs"
                    onClick={handleCopy}
                  >
                    {copied ? (
                      <><Check className="h-3.5 w-3.5" /> Copied</>
                    ) : (
                      <><Copy className="h-3.5 w-3.5" /> Copy</>
                    )}
                  </Button>
                </div>
                <div className="p-5">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {transcription.somali_text}
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-border bg-card p-8 text-center shadow-card">
                <p className="text-sm text-muted-foreground">No transcript available yet.</p>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default Transcript;
