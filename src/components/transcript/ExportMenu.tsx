import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ExportKind =
  | "txt-somali"
  | "txt-english"
  | "txt-both"
  | "srt"
  | "docx-somali"
  | "docx-both"
  | "pdf-somali"
  | "pdf-both";

interface ExportMenuProps {
  hasEnglish: boolean;
  hasTiming: boolean;
  timestamps: boolean;
  speakers: boolean;
  onTimestamps: (value: boolean) => void;
  onSpeakers: (value: boolean) => void;
  onExport: (kind: ExportKind) => void;
}

const ExportMenu = ({ hasEnglish, hasTiming, timestamps, speakers, onTimestamps, onSpeakers, onExport }: ExportMenuProps) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" size="sm" className="gap-1.5">
        <Download className="h-3.5 w-3.5" aria-hidden="true" /> Export
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-60">
      <DropdownMenuLabel>Include</DropdownMenuLabel>
      <DropdownMenuCheckboxItem checked={timestamps} onCheckedChange={(v) => onTimestamps(v === true)} onSelect={(e) => e.preventDefault()}>
        Timestamps
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem checked={speakers} onCheckedChange={(v) => onSpeakers(v === true)} onSelect={(e) => e.preventDefault()}>
        Speaker names
      </DropdownMenuCheckboxItem>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>Text (.txt)</DropdownMenuLabel>
      <DropdownMenuItem onSelect={() => onExport("txt-somali")}>Somali</DropdownMenuItem>
      <DropdownMenuItem disabled={!hasEnglish} onSelect={() => onExport("txt-english")}>English</DropdownMenuItem>
      <DropdownMenuItem disabled={!hasEnglish} onSelect={() => onExport("txt-both")}>Somali + English</DropdownMenuItem>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>Word (.docx)</DropdownMenuLabel>
      <DropdownMenuItem onSelect={() => onExport("docx-somali")}>Somali</DropdownMenuItem>
      <DropdownMenuItem disabled={!hasEnglish} onSelect={() => onExport("docx-both")}>Somali + English</DropdownMenuItem>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>PDF</DropdownMenuLabel>
      <DropdownMenuItem onSelect={() => onExport("pdf-somali")}>Somali</DropdownMenuItem>
      <DropdownMenuItem disabled={!hasEnglish} onSelect={() => onExport("pdf-both")}>Somali + English</DropdownMenuItem>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>Subtitles</DropdownMenuLabel>
      <DropdownMenuItem disabled={!hasTiming} onSelect={() => onExport("srt")}>
        SRT (Somali){!hasTiming && " — needs timing"}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

export default ExportMenu;
