import { useCallback, useState, useRef } from "react";
import { Upload, Mic, Square, FileAudio, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ACCEPTED_TYPES = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a", "audio/webm"];
const ACCEPTED_EXTENSIONS = /\.(mp3|wav|m4a|webm)$/i;

interface AudioUploaderProps {
  onFileSelected: (file: File) => void;
  isUploading?: boolean;
  disabled?: boolean;
}

const AudioUploader = ({ onFileSelected, isUploading, disabled }: AudioUploaderProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const validateFile = (file: File): boolean => {
    if (file.size > MAX_FILE_SIZE) {
      toast.error("File too large. Maximum size is 50MB.");
      return false;
    }
    if (!ACCEPTED_TYPES.includes(file.type) && !file.name.match(ACCEPTED_EXTENSIONS)) {
      toast.error("Unsupported format. Please upload MP3, WAV, or M4A.");
      return false;
    }
    return true;
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files[0];
    if (file && validateFile(file)) {
      onFileSelected(file);
    }
  }, [onFileSelected, disabled]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    const file = e.target.files?.[0];
    if (file && validateFile(file)) {
      onFileSelected(file);
    }
    e.target.value = "";
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const file = new File([blob], `recording-${Date.now()}.webm`, { type: "audio/webm" });
        onFileSelected(file);
        stream.getTracks().forEach((t) => t.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      intervalRef.current = setInterval(() => setRecordingTime((t) => t + 1), 1000);
    } catch {
      toast.error("Microphone access denied. Please allow microphone access.");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
    clearInterval(intervalRef.current);
  };

  const formatTime = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  return (
    <div className="w-full">
      <motion.div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`relative flex min-h-[240px] flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 transition-all ${
          isDragging ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/40"
        }`}
      >
        <AnimatePresence mode="wait">
          {isUploading ? (
            <motion.div
              key="uploading"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <Loader2 className="h-12 w-12 animate-spin text-primary" />
              <p className="font-display text-lg font-semibold">Uploading audio...</p>
              <p className="text-sm text-muted-foreground">Please wait while your file is being saved</p>
            </motion.div>
          ) : isRecording ? (
            <motion.div
              key="recording"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <div className="relative">
                <div className="absolute inset-0 animate-ping rounded-full bg-destructive/30" />
                <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-destructive">
                  <Mic className="h-7 w-7 text-destructive-foreground" />
                </div>
              </div>
              <p className="font-display text-2xl font-bold tabular-nums">{formatTime(recordingTime)}</p>
              <Button onClick={stopRecording} variant="destructive" size="lg" className="gap-2">
                <Square className="h-4 w-4" /> Stop Recording
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="upload"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
                <FileAudio className="h-7 w-7 text-muted-foreground" />
              </div>
              <div className="text-center">
                <p className="font-display text-lg font-semibold">Upload Somali Audio</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Drag & drop MP3, WAV, or M4A files here (max 50MB)
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Button variant="outline" className="gap-2" asChild>
                  <label className="cursor-pointer">
                    <Upload className="h-4 w-4" /> Browse Files
                    <input type="file" accept=".mp3,.wav,.m4a,.webm,audio/*" className="hidden" onChange={handleFileInput} />
                  </label>
                </Button>
                <Button onClick={startRecording} className="gap-2 bg-gradient-gold text-primary-foreground hover:opacity-90">
                  <Mic className="h-4 w-4" /> Record Audio
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};

export default AudioUploader;
