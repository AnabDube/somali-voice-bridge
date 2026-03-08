import { Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface TranscriptPanelProps {
  title: string;
  language: string;
  content: string;
  isLoading?: boolean;
  accentColor: "gold" | "teal";
}

const TranscriptPanel = ({ title, language, content, isLoading, accentColor }: TranscriptPanelProps) => {
  const copyToClipboard = () => {
    navigator.clipboard.writeText(content);
    toast.success("Copied to clipboard");
  };

  const download = () => {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.toLowerCase().replace(/\s/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const barColor = accentColor === "gold" ? "bg-gradient-gold" : "bg-gradient-teal";

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card shadow-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-3">
          <div className={`h-6 w-1 rounded-full ${barColor}`} />
          <div>
            <h3 className="font-display text-sm font-semibold">{title}</h3>
            <p className="text-xs text-muted-foreground">{language}</p>
          </div>
        </div>
        {content && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={copyToClipboard}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={download}>
              <Download className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto p-5">
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${70 + Math.random() * 30}%` }} />
            ))}
          </div>
        ) : content ? (
          <p className="text-sm leading-relaxed">{content}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            {title.includes("Somali") ? "Somali transcript will appear here..." : "English translation will appear here..."}
          </p>
        )}
      </div>
    </div>
  );
};

export default TranscriptPanel;
