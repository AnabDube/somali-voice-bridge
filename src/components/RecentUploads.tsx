import { useState } from "react";
import { FileAudio, Calendar, Clock, Trash2, Eye, Loader2, Upload, FileText, Languages } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
  onDelete?: (id: string) => Promise<void> | void;
}

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

const formatFileSize = (bytes: number | null) => {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const RecentUploads = ({ uploads, onDelete }: RecentUploadsProps) => {
  const navigate = useNavigate();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!onDelete) return;
    setDeletingId(id);
    try {
      await onDelete(id);
    } finally {
      setDeletingId(null);
    }
  };

  if (uploads.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 shadow-card">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <FileAudio className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="font-display text-base font-semibold">Welcome — let's get your first transcript</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Here's how it works in 3 quick steps.
          </p>
        </div>

        <ol className="mt-5 space-y-3">
          <li className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/50 p-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-gold text-xs font-bold text-primary-foreground">
              1
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                Upload or record Somali audio
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Use the uploader above. Keep clips under 25 MB for best results.
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/50 p-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-gold text-xs font-bold text-primary-foreground">
              2
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                Review the transcript
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                AI generates Somali text. Edit any mistakes, then verify for training.
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/50 p-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-gold text-xs font-bold text-primary-foreground">
              3
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Languages className="h-3.5 w-3.5 text-muted-foreground" />
                Translate to English
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                One click to get a natural English translation of the transcript.
              </p>
            </div>
          </li>
        </ol>
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
          const isDeleting = deletingId === upload.id;
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
              <Badge variant={cfg.variant}>{cfg.label}</Badge>
              {upload.status === "processing" ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : upload.status === "completed" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 gap-1.5 text-xs"
                  onClick={() => navigate(`/transcript/${upload.id}`)}
                >
                  <Eye className="h-3.5 w-3.5" /> View Transcript
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 gap-1.5 text-xs"
                  onClick={() => navigate(`/transcript/${upload.id}`)}
                >
                  <Eye className="h-3.5 w-3.5" /> View
                </Button>
              )}
              {onDelete && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      disabled={isDeleting}
                    >
                      {isDeleting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete recording?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete "{upload.file_name}" and its transcript. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => handleDelete(upload.id)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default RecentUploads;
