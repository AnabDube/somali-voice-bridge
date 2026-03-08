import { useState } from "react";
import { Clock, FileAudio, Languages, Zap } from "lucide-react";
import Navbar from "@/components/Navbar";
import AudioUploader from "@/components/AudioUploader";
import TranscriptPanel from "@/components/TranscriptPanel";
import StatsCard from "@/components/StatsCard";
import { toast } from "sonner";

const Dashboard = () => {
  const [somaliText, setSomaliText] = useState("");
  const [englishText, setEnglishText] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [fileName, setFileName] = useState("");

  const handleFileSelected = (file: File) => {
    setFileName(file.name);
    setIsProcessing(true);
    toast.info(`Processing "${file.name}"...`);

    // Simulated transcription/translation for demo
    setTimeout(() => {
      setSomaliText(
        "Waxaan rabaa inaan ku soo dhaweeyo barnaamijkan cusub ee Somali Voice Bridge. " +
        "Barnaamijkan wuxuu kaa caawinayaa inaad codkaaga Soomaaliga ah u beddesho qoraal, " +
        "kadibna uu turjumayo Ingiriisi. Waa mid fudud oo degdeg ah."
      );
      setTimeout(() => {
        setEnglishText(
          "I would like to welcome you to this new Somali Voice Bridge program. " +
          "This program helps you convert your Somali voice into text, " +
          "and then translates it into English. It is simple and fast."
        );
        setIsProcessing(false);
        toast.success("Transcription complete!");
      }, 1500);
    }, 2000);
  };

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="container mx-auto px-4 pb-12 pt-24">
        {/* Stats */}
        <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatsCard icon={Clock} label="Minutes Used" value="12.4" subtext="of 30 free min" />
          <StatsCard icon={FileAudio} label="Files Processed" value="8" />
          <StatsCard icon={Languages} label="Words Translated" value="1,247" />
          <StatsCard icon={Zap} label="Plan" value="Free" subtext="Upgrade for more" />
        </div>

        {/* Upload */}
        <div className="mb-8">
          <AudioUploader onFileSelected={handleFileSelected} />
          {fileName && (
            <p className="mt-3 text-center text-sm text-muted-foreground">
              Current file: <span className="font-medium text-foreground">{fileName}</span>
            </p>
          )}
        </div>

        {/* Transcript Panels */}
        <div className="grid min-h-[320px] gap-4 md:grid-cols-2">
          <TranscriptPanel
            title="Somali Transcript"
            language="af-Soomaali"
            content={somaliText}
            isLoading={isProcessing}
            accentColor="gold"
          />
          <TranscriptPanel
            title="English Translation"
            language="English"
            content={englishText}
            isLoading={isProcessing && !!somaliText}
            accentColor="teal"
          />
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
