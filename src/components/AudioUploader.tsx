import { useCallback, useState, useRef } from "react";
import { Upload, Mic, Square, FileAudio, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ACCEPTED_TYPES = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a", "audio/webm"];
const ACCEPTED_EXTENSIONS = /\.(mp3|wav|m4a|webm)$/i;

export type SomaliDialect = "standard" | "af_maay" | "northern" | "benaadir" | "other";
export type AudioQuality = "clean" | "noisy" | "poor";
export type SpeakerGender = "male" | "female" | "other" | "unknown";
export type SpeakerAgeRange = "child" | "teen" | "adult" | "senior" | "unknown";

export interface UploadMetadata {
  dialect: SomaliDialect;
  audio_quality: AudioQuality;
  speaker_gender: SpeakerGender;
  speaker_age_range: SpeakerAgeRange;
}

const DIALECT_OPTIONS: { value: SomaliDialect; label: string }[] = [
  { value: "standard", label: "Standard Somali" },
  { value: "northern", label: "Northern (Isaaq/Dir)" },
  { value: "benaadir", label: "Benaadir" },
  { value: "af_maay", label: "Af-Maay" },
  { value: "other", label: "Other / Mixed" },
];

const QUALITY_OPTIONS: { value: AudioQuality; label: string }[] = [
  { value: "clean", label: "Clean (studio/quiet)" },
  { value: "noisy", label: "Noisy (some background)" },
  { value: "poor", label: "Poor (heavy noise)" },
];

const GENDER_OPTIONS: { value: SpeakerGender; label: string }[] = [
  { value: "unknown", label: "Prefer not to say" },
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "other", label: "Other" },
];

const AGE_OPTIONS: { value: SpeakerAgeRange; label: string }[] = [
  { value: "unknown", label: "Prefer not to say" },
  { value: "child", label: "Child (< 13)" },
  { value: "teen", label: "Teen (13–19)" },
  { value: "adult", label: "Adult (20–59)" },
  { value: "senior", label: "Senior (60+)" },
];

interface AudioUploaderProps {
  onFileSelected: (file: File, metadata: UploadMetadata) => void;
  isUploading?: boolean;
  disabled?: boolean;
}

const AudioUploader = ({ onFileSelected, isUploading, disabled }: AudioUploaderProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [dialect, setDialect] = useState<SomaliDialect>("standard");
  const [audioQuality, setAudioQuality] = useState<AudioQuality>("clean");
  const [speakerGender, setSpeakerGender] = useState<SpeakerGender>("unknown");
  const [speakerAgeRange, setSpeakerAgeRange] = useState<SpeakerAgeRange>("unknown");

  const buildMetadata = (): UploadMetadata => ({
    dialect,
    audio_quality: audioQuality,
    speaker_gender: speakerGender,
    speaker_age_range: speakerAgeRange,
  });

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
      onFileSelected(file, buildMetadata());
    }
  }, [onFileSelected, disabled, dialect]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    const file = e.target.files?.[0];
    if (file && validateFile(file)) {
      onFileSelected(file, buildMetadata());
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
        onFileSelected(file, buildMetadata());
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
    <div className="w-full space-y-3">
      {/* Metadata — helps build a better training dataset */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Dialect</label>
          <Select value={dialect} onValueChange={(v) => setDialect(v as SomaliDialect)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {DIALECT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Audio quality</label>
          <Select value={audioQuality} onValueChange={(v) => setAudioQuality(v as AudioQuality)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {QUALITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Speaker gender</label>
          <Select value={speakerGender} onValueChange={(v) => setSpeakerGender(v as SpeakerGender)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {GENDER_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Speaker age</label>
          <Select value={speakerAgeRange} onValueChange={(v) => setSpeakerAgeRange(v as SpeakerAgeRange)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

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
