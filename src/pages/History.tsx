import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { FileAudio, Calendar, Clock, Eye, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import Navbar from "@/components/Navbar";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { format } from "date-fns";

const PAGE_SIZE = 10;

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  uploaded: { label: "Uploaded", variant: "outline" },
  processing: { label: "Processing", variant: "secondary" },
  completed: { label: "Ready", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
  pending: { label: "Uploaded", variant: "outline" },
};

const formatDuration = (seconds: number | null) => {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

interface UploadWithTranscription {
  id: string;
  file_name: string;
  file_path: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  status: string;
  created_at: string;
  hasTranscription: boolean;
  hasTranslation: boolean;
}

const History = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [uploads, setUploads] = useState<UploadWithTranscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [search, setSearch] = useState("");

  const fetchUploads = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    let query = supabase
      .from("audio_uploads")
      .select("id, file_name, file_path, file_size_bytes, duration_seconds, status, created_at", { count: "exact" })
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (search.trim()) {
      query = query.ilike("file_name", `%${search.trim()}%`);
    }

    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, count, error } = await query.range(from, to);

    if (error || !data) {
      setLoading(false);
      return;
    }

    setTotalCount(count ?? 0);

    // Fetch transcription status for these uploads
    const ids = data.map((u) => u.id);
    const { data: transcriptions } = await supabase
      .from("transcriptions")
      .select("upload_id, somali_text, english_text")
      .in("upload_id", ids);

    const tMap = new Map(
      (transcriptions ?? []).map((t) => [t.upload_id, t])
    );

    setUploads(
      data.map((u) => {
        const t = tMap.get(u.id);
        return {
          ...u,
          hasTranscription: !!t?.somali_text,
          hasTranslation: !!t?.english_text,
        };
      })
    );
    setLoading(false);
  }, [user, page, search]);

  useEffect(() => {
    fetchUploads();
  }, [fetchUploads]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="container mx-auto px-4 pb-12 pt-24">
        <h1 className="mb-6 font-display text-2xl font-bold">Upload History</h1>

        <div className="mb-4 flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by file name..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="pl-9"
            />
          </div>
          <span className="text-sm text-muted-foreground">{totalCount} upload{totalCount !== 1 ? "s" : ""}</span>
        </div>

        <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : uploads.length === 0 ? (
            <div className="py-16 text-center">
              <FileAudio className="mx-auto h-10 w-10 text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">
                {search ? "No matching uploads found" : "No uploads yet"}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {uploads.map((upload) => {
                const cfg = statusConfig[upload.status] || statusConfig.pending;
                return (
                  <div key={upload.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5 sm:flex-nowrap">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <FileAudio className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{upload.file_name}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {format(new Date(upload.created_at), "MMM d, yyyy")}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDuration(upload.duration_seconds)}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={cfg.variant}>{cfg.label}</Badge>
                      {upload.hasTranscription && (
                        <Badge variant="secondary">Transcribed</Badge>
                      )}
                      {upload.hasTranslation && (
                        <Badge variant="default">Translated</Badge>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 gap-1.5 text-xs"
                      onClick={() => navigate(`/transcript/${upload.id}`)}
                    >
                      <Eye className="h-3.5 w-3.5" /> View
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </main>
    </div>
  );
};

export default History;
