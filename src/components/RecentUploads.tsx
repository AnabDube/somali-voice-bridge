import { FileAudio, Calendar, Clock, Trash2, Eye, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

interface AudioUpload {
  id: string;
  file_name: string;
  file_path: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  status: string;
  created_at: string;
}

interface RecentUploadsProps {
  uploads: AudioUpload[];
  onDelete?: (id: string) => void;
}

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  uploaded: { label: "Uploaded", variant: "outline" },
  processing: { label: "Processing", variant: "secondary" },
  completed: { label: "Completed", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
  pending: { label: "Uploaded", variant: "outline" },
};

const formatDuration = (seconds: number | null) => {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const formatFileSize = (bytes: number | null) => {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const RecentUploads = ({ uploads, onDelete }: RecentUploadsProps) => {
  if (uploads.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center shadow-card">
        <FileAudio className="mx-auto h-10 w-10 text-muted-foreground/40" />
        <p className="mt-3 font-display text-sm font-medium text-muted-foreground">No uploads yet</p>
        <p className="mt-1 text-xs text-muted-foreground">Upload or record audio to get started</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
      <div className="border-b border-border px-5 py-3">
        <h3 className="font-display text-sm font-semibold">Recent Uploads</h3>
      </div>
      <div className="divide-y divide-border">
        {uploads.map((upload) => {
          const cfg = statusConfig[upload.status] || statusConfig.pending;
          return (
            <div key={upload.id} className="flex items-center gap-4 px-5 py-3.5">
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
                  {upload.file_size_bytes && (
                    <span>{formatFileSize(upload.file_size_bytes)}</span>
                  )}
                </div>
              </div>
              <Badge variant={cfg.variant} className="shrink-0">{cfg.label}</Badge>
              {onDelete && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(upload.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default RecentUploads;
