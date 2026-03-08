import { useState, useEffect, useCallback } from "react";
import { Clock, FileAudio, Languages, Zap } from "lucide-react";
import Navbar from "@/components/Navbar";
import AudioUploader from "@/components/AudioUploader";
import RecentUploads from "@/components/RecentUploads";
import StatsCard from "@/components/StatsCard";
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
  const { profile } = useProfile();
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
    }, 4000);

    return () => clearInterval(interval);
  }, [uploads, fetchUploads]);

  const handleFileSelected = async (file: File) => {
    if (!user) return;

    setIsUploading(true);
    const filePath = `${user.id}/${Date.now()}-${file.name}`;

    try {
      // 1. Upload to storage
      const { error: storageError } = await supabase.storage
        .from("audio-uploads")
        .upload(filePath, file, { contentType: file.type });

      if (storageError) throw storageError;

      // 2. Create database record
      const { data: insertData, error: dbError } = await supabase
        .from("audio_uploads")
        .insert({
          user_id: user.id,
          file_name: file.name,
          file_path: filePath,
          file_size_bytes: file.size,
          status: "uploaded",
        })
        .select("id")
        .single();

      if (dbError) throw dbError;

      toast.success(`"${file.name}" uploaded — transcription starting…`);
      await fetchUploads();

      // 3. Trigger transcription
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      if (accessToken && insertData?.id) {
        // Update status locally
        setUploads((prev) =>
          prev.map((u) => (u.id === insertData.id ? { ...u, status: "processing" } : u))
        );

        supabase.functions
          .invoke("transcribe-audio", {
            body: { upload_id: insertData.id },
          })
          .then(({ error: fnErr }) => {
            if (fnErr) {
              console.error("Transcription function error:", fnErr);
            }
            // Refresh uploads to get latest status
            fetchUploads();
          });
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
      // Delete from storage
      await supabase.storage.from("audio-uploads").remove([upload.file_path]);
      // Delete from database
      const { error } = await supabase.from("audio_uploads").delete().eq("id", id);
      if (error) throw error;

      toast.success("Recording deleted");
      setUploads((prev) => prev.filter((u) => u.id !== id));
    } catch (err: any) {
      toast.error(err.message || "Failed to delete");
    }
  };

  const minutesUsed = profile?.minutes_used ?? 0;
  const minutesLimit = profile?.minutes_limit ?? 30;
  const plan = profile?.subscription_plan ?? "free";

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="container mx-auto px-4 pb-12 pt-24">
        {profile && (
          <h2 className="mb-6 font-display text-2xl font-bold">
            Welcome, {profile.display_name || "there"} 👋
          </h2>
        )}

        {/* Stats */}
        <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatsCard icon={Clock} label="Minutes Used" value={`${minutesUsed}`} subtext={`of ${minutesLimit} min`} />
          <StatsCard icon={FileAudio} label="Files Uploaded" value={`${uploads.length}`} />
          <StatsCard icon={Languages} label="Words Translated" value="—" />
          <StatsCard icon={Zap} label="Plan" value={planLabels[plan] || "Free"} subtext="Upgrade for more" />
        </div>

        {/* Upload */}
        <div className="mb-8">
          <AudioUploader onFileSelected={handleFileSelected} isUploading={isUploading} />
        </div>

        {/* Recent Uploads */}
        <RecentUploads uploads={uploads} onDelete={handleDelete} />
      </main>
    </div>
  );
};

export default Dashboard;
