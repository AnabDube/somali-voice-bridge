import { useState, useEffect, useCallback } from "react";
import { Clock, FileAudio, Languages, Zap, AlertTriangle, History } from "lucide-react";
import { Link } from "react-router-dom";
import Navbar from "@/components/Navbar";
import AudioUploader, { type SomaliDialect } from "@/components/AudioUploader";
import RecentUploads from "@/components/RecentUploads";
import StatsCard from "@/components/StatsCard";
import UsageBar from "@/components/UsageBar";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/useProfile";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
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
  const { profile, refetch: refetchProfile } = useProfile();
  const [uploads, setUploads] = useState<AudioUploadRow[]>([]);
  const [isUploading, setIsUploading] = useState(false);

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

  // Poll for status updates when any upload is processing
  useEffect(() => {
    const hasProcessing = uploads.some((u) => u.status === "processing");
    if (!hasProcessing) return;

    const interval = setInterval(() => {
      fetchUploads();
      refetchProfile?.();
    }, 4000);

    return () => clearInterval(interval);
  }, [uploads, fetchUploads, refetchProfile]);

  const minutesUsed = profile?.minutes_used ?? 0;
  const minutesLimit = profile?.minutes_limit ?? 30;
  const minutesRemaining = Math.max(0, minutesLimit - minutesUsed);
  const plan = profile?.subscription_plan ?? "free";
  const hasCredits = minutesRemaining > 0;
  const isLowCredits = minutesRemaining > 0 && minutesRemaining <= 5;

  const getAudioDuration = (file: File): Promise<number> => {
    return new Promise((resolve) => {
      const audio = new Audio();
      audio.addEventListener("loadedmetadata", () => {
        resolve(audio.duration);
        URL.revokeObjectURL(audio.src);
      });
      audio.addEventListener("error", () => {
        resolve(0);
        URL.revokeObjectURL(audio.src);
      });
      audio.src = URL.createObjectURL(file);
    });
  };

  const handleFileSelected = async (file: File, dialect: SomaliDialect) => {
    if (!user) return;

    if (!hasCredits) {
      toast.error("No credits remaining. Please upgrade your plan to continue.");
      return;
    }

    const durationSec = await getAudioDuration(file);
    if (durationSec > 0) {
      const durationMin = Math.ceil(durationSec / 60);
      if (durationMin > minutesRemaining) {
        toast.error(
          `This file is ~${durationMin} min but you only have ${minutesRemaining} min remaining. Please upgrade your plan.`
        );
        return;
      }
    }

    setIsUploading(true);
    const filePath = `${user.id}/${Date.now()}-${file.name}`;

    try {
      const { error: storageError } = await supabase.storage
        .from("audio-uploads")
        .upload(filePath, file, { contentType: file.type });

      if (storageError) throw storageError;

      const { data: insertData, error: dbError } = await supabase
        .from("audio_uploads")
        .insert({
          user_id: user.id,
          file_name: file.name,
          file_path: filePath,
          file_size_bytes: file.size,
          dialect,
          status: "uploaded",
        })
        .select("id")
        .single();

      if (dbError) throw dbError;

      toast.success(`"${file.name}" uploaded — transcription starting…`);
      await fetchUploads();

      if (insertData?.id) {
        setUploads((prev) =>
          prev.map((u) => (u.id === insertData.id ? { ...u, status: "processing" } : u))
        );

        const { data: fnData, error: fnErr } = await supabase.functions
          .invoke("transcribe-audio", {
            body: { upload_id: insertData.id },
          });

        if (fnErr) {
          console.error("Transcription function error:", fnErr);
          let errorMessage = "Transcription failed. Please try again.";
          try {
            const parsed = typeof fnErr === "object" ? fnErr : JSON.parse(String(fnErr));
            if (parsed?.context?.body) {
              const body = JSON.parse(parsed.context.body);
              if (body.error === "no_credits") {
                errorMessage = body.message;
              } else if (body.message) {
                errorMessage = body.message;
              }
            }
          } catch {}
          toast.error(errorMessage);
          fetchUploads();
          refetchProfile?.();
          return;
        }

        if (fnData?.transcription_id) {
          const { error: tlErr } = await supabase.functions
            .invoke("translate-text", {
              body: { transcription_id: fnData.transcription_id },
            });

          if (tlErr) {
            console.error("Translation error:", tlErr);
            toast.error("Translation failed. You can retry from the transcript page.");
          }
        }

        fetchUploads();
        refetchProfile?.();
      }
    } catch (err: any) {
      console.error("Upload error:", err);
      toast.error(err.message || "Upload failed. Please try again.");
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    const upload = uploads.find((u) => u.id === id);
    if (!upload) return;

    try {
      await supabase.storage.from("audio-uploads").remove([upload.file_path]);
      const { error } = await supabase.from("audio_uploads").delete().eq("id", id);
      if (error) throw error;

      toast.success("Recording deleted");
      setUploads((prev) => prev.filter((u) => u.id !== id));
    } catch (err: any) {
      toast.error(err.message || "Failed to delete");
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

        <div className="mb-6">
          <UsageBar minutesUsed={minutesUsed} minutesLimit={minutesLimit} plan={plan} />
        </div>

        <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatsCard
            icon={Clock}
            label="Minutes Remaining"
            value={`${minutesRemaining}`}
            subtext={`of ${minutesLimit} min`}
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
            disabled={!hasCredits}
          />
        </div>

        <div className="flex items-center justify-between mb-2">
          <h3 className="font-display text-sm font-semibold">Recent Uploads</h3>
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" asChild>
            <Link to="/history"><History className="h-3.5 w-3.5" /> View All</Link>
          </Button>
        </div>
        <RecentUploads uploads={uploads} onDelete={handleDelete} />
      </main>
    </div>
  );
};

export default Dashboard;
