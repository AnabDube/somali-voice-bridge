import { useState, useEffect, useCallback, useRef } from "react";
import { Clock, FileAudio, Languages, Zap, AlertTriangle, History } from "lucide-react";
import { Link } from "react-router-dom";
import Navbar from "@/components/Navbar";
import AudioUploader, { type UploadMetadata } from "@/components/AudioUploader";
import RecentUploads from "@/components/RecentUploads";
import StatsCard from "@/components/StatsCard";
import UsageBar from "@/components/UsageBar";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/useProfile";
import { useAuth } from "@/contexts/AuthContext";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useProcessingSteps } from "@/hooks/useProcessingSteps";
import { useRetryStep } from "@/hooks/useRetryStep";
import { supabase } from "@/integrations/supabase/client";
import { deriveDisplayStatus } from "@/lib/pipeline";
import { friendlyUploadError, getAudioDuration } from "@/lib/audio";
import { UploadError, uploadRecording, type UploadPhase } from "@/lib/uploadRecording";
import { toast } from "sonner";

const planLabels: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  professional: "Pro",
  business: "Business",
};

interface AudioUploadRow {
  id: string;
  file_name: string;
  file_path: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  status: string;
  created_at: string;
}

const Dashboard = () => {
  const { user } = useAuth();
  const isAdmin = useIsAdmin();
  const { profile, refetch: refetchProfile } = useProfile();
  const [uploads, setUploads] = useState<AudioUploadRow[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [phase, setPhase] = useState<UploadPhase | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchUploads = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("audio_uploads")
      .select("id, file_name, file_path, file_size_bytes, duration_seconds, status, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (!error && data) {
      setUploads(data);
    }
  }, [user]);

  useEffect(() => {
    fetchUploads();
  }, [fetchUploads]);

  // Live per-step status for every recording in the list. Updates arrive on
  // their own (no refresh needed) and drive the badges below.
  const { steps, refetch: refetchSteps } = useProcessingSteps(uploads.map((u) => u.id));
  const { retry, isRetrying } = useRetryStep(() => {
    fetchUploads();
    refetchProfile?.();
  });

  // When a transcription finishes or fails, refresh the list (duration) and
  // the minutes balance.
  const transcriptionStates = uploads.map((u) => steps[u.id]?.transcription?.status ?? "-").join(",");
  useEffect(() => {
    fetchUploads();
    refetchProfile?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptionStates]);

  // The server allows one transcription at a time per user, so hold off new
  // uploads until the current one has its transcript.
  const isTranscribing = uploads.some((u) => {
    const display = deriveDisplayStatus(u.status, steps[u.id] ?? {});
    return display.busy && !display.transcriptReady;
  });

  const minutesUsed = profile?.minutes_used ?? 0;
  const minutesLimit = profile?.minutes_limit ?? 30;
  const minutesRemaining = Math.max(0, minutesLimit - minutesUsed);
  const plan = profile?.subscription_plan ?? "free";
  // Admins' usage is recorded but never blocked.
  const unlimited = isAdmin === true;
  const hasCredits = unlimited || minutesRemaining > 0;
  const isLowCredits = !unlimited && minutesRemaining > 0 && minutesRemaining <= 5;

  const handleFileSelected = async (file: File, metadata: UploadMetadata) => {
    if (!user) return;

    if (!hasCredits) {
      toast.error("No credits remaining. Please upgrade your plan to continue.");
      return;
    }

    const durationSec = await getAudioDuration(file);
    if (!unlimited && durationSec > 0) {
      const durationMin = Math.ceil(durationSec / 60);
      if (durationMin > minutesRemaining) {
        toast.error(
          `This file is ~${durationMin} min but you only have ${minutesRemaining} min remaining. Please upgrade your plan.`
        );
        return;
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setPhase(null);
    setIsUploading(true);

    try {
      // Short files go up as they are. Long ones are converted and split in the
      // browser, uploaded part by part, then transcribed on the server, which
      // keeps going even if this tab is closed.
      await uploadRecording({
        file,
        metadata,
        userId: user.id,
        durationSec,
        signal: controller.signal,
        onPhase: setPhase,
        onCreated: () => {
          fetchUploads();
          refetchSteps();
        },
        onStartError: (message) => toast.error(message),
      });
      toast.success(`"${file.name}" uploaded — transcription is starting.`);
    } catch (err) {
      if (err instanceof UploadError && err.code === "cancelled") {
        toast.info("Upload cancelled.");
      } else {
        console.error("Upload error:", err);
        toast.error(err instanceof Error && err.message ? err.message : friendlyUploadError(err));
      }
    } finally {
      abortRef.current = null;
      setPhase(null);
      setIsUploading(false);
      fetchUploads();
      refetchSteps();
      refetchProfile?.();
    }
  };

  const handleCancelUpload = () => abortRef.current?.abort();

  const handleDelete = async (id: string) => {
    const upload = uploads.find((u) => u.id === id);
    if (!upload || !user) return;

    try {
      // A recording can have several files: the original, or the playable copy plus its parts.
      const paths = new Set([upload.file_path]);
      const { data: files } = await supabase.storage.from("audio-uploads").list(`${user.id}/${id}`);
      for (const file of files ?? []) paths.add(`${user.id}/${id}/${file.name}`);
      await supabase.storage.from("audio-uploads").remove([...paths]);

      const { error } = await supabase.from("audio_uploads").delete().eq("id", id);
      if (error) throw error;

      toast.success("Recording deleted");
      setUploads((prev) => prev.filter((u) => u.id !== id));
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Failed to delete");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="container mx-auto px-4 pb-12 pt-24">
        {profile && (
          <h2 className="mb-6 font-display text-2xl font-bold">
            Welcome, {profile.display_name || "there"} 👋
          </h2>
        )}

        {!unlimited && (
          <div className="mb-6">
            <UsageBar minutesUsed={minutesUsed} minutesLimit={minutesLimit} plan={plan} />
          </div>
        )}

        <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatsCard
            icon={Clock}
            label="Minutes Remaining"
            value={unlimited ? "Unlimited" : `${minutesRemaining}`}
            subtext={unlimited ? "admin account" : `of ${minutesLimit} min`}
            highlight={!hasCredits ? "danger" : isLowCredits ? "warning" : undefined}
          />
          <StatsCard icon={FileAudio} label="Files Uploaded" value={`${uploads.length}`} />
          <StatsCard icon={Languages} label="Minutes Used" value={`${minutesUsed}`} />
          <StatsCard icon={Zap} label="Plan" value={planLabels[plan] || "Free"} subtext="Upgrade for more" />
        </div>

        {!hasCredits && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
            <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="text-sm font-semibold text-destructive">No credits remaining</p>
              <p className="text-xs text-muted-foreground">
                Transcription cannot proceed. Please upgrade your plan or add credits to continue.
              </p>
            </div>
          </div>
        )}
        {isLowCredits && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 p-4">
            <AlertTriangle className="h-5 w-5 shrink-0 text-accent-foreground" />
            <div>
              <p className="text-sm font-semibold text-accent-foreground">Low credits</p>
              <p className="text-xs text-muted-foreground">
                You have only {minutesRemaining} minute{minutesRemaining !== 1 ? "s" : ""} remaining. Consider upgrading your plan.
              </p>
            </div>
          </div>
        )}

        <div className="mb-8">
          <AudioUploader
            onFileSelected={handleFileSelected}
            isUploading={isUploading}
            progress={phase}
            onCancel={handleCancelUpload}
            disabled={!hasCredits || isTranscribing}
          />
          {isTranscribing && (
            <p className="mt-2 text-xs text-muted-foreground">
              A recording is being transcribed. You can upload the next one as soon as its transcript is ready.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between mb-2">
          <h3 className="font-display text-sm font-semibold">Recent Uploads</h3>
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" asChild>
            <Link to="/history"><History className="h-3.5 w-3.5" /> View All</Link>
          </Button>
        </div>
        <RecentUploads
          uploads={uploads}
          steps={steps}
          onDelete={handleDelete}
          onRetry={retry}
          isRetrying={isRetrying}
        />
      </main>
    </div>
  );
};

export default Dashboard;
