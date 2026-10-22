// Exporting a transcript: plain text, subtitles (SRT), Word and PDF. Every format
// carries the timestamps and speaker names, so an export can be read, searched
// and quoted without going back to the app.

import { formatTimestamp, needsHours, type Section, type TranscriptSegment } from "@/lib/segments";

export interface ExportOptions {
  title?: string;
  timestamps: boolean;
  speakers: boolean;
}

export type ExportLanguage = "somali" | "english" | "both";

const stamp = (seconds: number | null, hours: boolean) => formatTimestamp(seconds, hours);

/** "[0:01:23] Hodan: text" — the timestamp and speaker are left out when they aren't there. */
export const segmentLine = (s: TranscriptSegment, options: ExportOptions, hours: boolean): string => {
  const time = options.timestamps ? stamp(s.start_seconds, hours) : "";
  const speaker = options.speakers && s.speaker ? `${s.speaker}: ` : "";
  return `${time ? `[${time}] ` : ""}${speaker}${s.text}`.trim();
};

const sectionRange = (section: Section, hours: boolean): string => {
  const first = section.segments[0];
  const last = section.segments[section.segments.length - 1];
  const from = stamp(first?.start_seconds ?? null, hours);
  const to = stamp(last?.end_seconds ?? last?.start_seconds ?? null, hours);
  return from && to ? `${from}–${to}` : "";
};

const header = (options: ExportOptions, count: number): string[] =>
  options.title ? [options.title, `${count} segments`, ""] : [];

/** The Somali transcript, one line per segment. */
export const toSomaliTxt = (segments: TranscriptSegment[], options: ExportOptions): string => {
  const hours = needsHours(segments);
  return [...header(options, segments.length), ...segments.map((s) => segmentLine(s, options, hours))].join("\n") + "\n";
};

/** The English translation, one paragraph per section, labelled with the time it covers. */
export const toEnglishTxt = (sections: Section[], options: ExportOptions): string => {
  const hours = needsHours(sections.flatMap((s) => s.segments));
  const lines = header(options, sections.length);
  for (const section of sections) {
    if (!section.english) continue;
    const range = options.timestamps ? sectionRange(section, hours) : "";
    if (range) lines.push(`[${range}]`);
    lines.push(section.english, "");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
};

/** Somali segments with each section's English translation underneath. */
export const toBilingualTxt = (sections: Section[], options: ExportOptions): string => {
  const all = sections.flatMap((s) => s.segments);
  const hours = needsHours(all);
  const lines = header(options, all.length);
  for (const section of sections) {
    const range = options.timestamps ? sectionRange(section, hours) : "";
    if (range) lines.push(`── ${range} ──`);
    for (const s of section.segments) lines.push(segmentLine(s, options, hours));
    if (section.english) lines.push("", `English: ${section.english}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
};

// ---------------------------------------------------------------- SRT (subtitles)
export const srtTimestamp = (seconds: number): string => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(milli, 3)}`;
};

/** Wraps a subtitle at word boundaries. */
export const wrapSubtitle = (text: string, width = 42): string[] => {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
};

/** Subtitles for the Somali segments that have timing. A cue always ends after it starts. */
export const toSrt = (segments: TranscriptSegment[], options: { speakers: boolean }): string => {
  const cues: string[] = [];
  let n = 0;
  for (const s of segments) {
    if (s.start_seconds === null || !s.text.trim()) continue;
    const start = s.start_seconds;
    const end = s.end_seconds !== null && s.end_seconds > start ? s.end_seconds : start + 2;
    const text = options.speakers && s.speaker ? `${s.speaker}: ${s.text}` : s.text;
    n += 1;
    cues.push(`${n}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${wrapSubtitle(text).join("\n")}\n`);
  }
  return cues.join("\n");
};

// ---------------------------------------------------------------- files
export const exportFileName = (userName: string, audioName: string, suffix: string, extension: string): string =>
  `${userName}_${audioName}_${suffix}.${extension}`.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_");

/** Hands a file to the browser as a download. */
export const downloadBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const textBlob = (text: string, type = "text/plain") => new Blob([text], { type: `${type};charset=utf-8` });

// ---------------------------------------------------------------- Word and PDF (loaded on demand)
interface DocumentExportInput {
  title: string;
  subtitle: string;
  sections: Section[];
  language: ExportLanguage;
  options: ExportOptions;
}

const sectionsFor = (input: DocumentExportInput) => input.sections.filter((s) => s.segments.length > 0);

export const buildDocx = async (input: DocumentExportInput): Promise<Blob> => {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
  const sections = sectionsFor(input);
  const hours = needsHours(sections.flatMap((s) => s.segments));
  const { options, language } = input;
  const children: InstanceType<typeof Paragraph>[] = [
    new Paragraph({ text: input.title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: input.subtitle, color: "666666", size: 20 })], spacing: { after: 240 } }),
  ];

  for (const section of sections) {
    const range = options.timestamps ? sectionRange(section, hours) : "";
    if (range && language !== "somali") {
      children.push(new Paragraph({ text: range, heading: HeadingLevel.HEADING_3, spacing: { before: 240 } }));
    }
    if (language !== "english") {
      for (const s of section.segments) {
        const time = options.timestamps ? stamp(s.start_seconds, hours) : "";
        children.push(
          new Paragraph({
            spacing: { after: 80 },
            children: [
              ...(time ? [new TextRun({ text: `[${time}] `, color: "888888", font: "Consolas", size: 18 })] : []),
              ...(options.speakers && s.speaker ? [new TextRun({ text: `${s.speaker}: `, bold: true })] : []),
              new TextRun({ text: s.text }),
            ],
          }),
        );
      }
    }
    if (language !== "somali" && section.english) {
      children.push(
        new Paragraph({
          spacing: { before: 80, after: 200 },
          children: [new TextRun({ text: section.english, italics: true, color: "333333" })],
        }),
      );
    }
  }

  return Packer.toBlob(new Document({ sections: [{ children }] }));
};

export const buildPdf = async (input: DocumentExportInput): Promise<Blob> => {
  const { default: JsPDF } = await import("jspdf");
  const doc = new JsPDF();
  const sections = sectionsFor(input);
  const hours = needsHours(sections.flatMap((s) => s.segments));
  const { options, language } = input;
  const margin = 15;
  const width = doc.internal.pageSize.getWidth() - margin * 2;
  const pageHeight = doc.internal.pageSize.getHeight();
  let y = 20;

  const write = (text: string, size = 10, style: "normal" | "bold" | "italic" = "normal", gap = 1.5) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    const lineHeight = size * 0.5;
    for (const line of doc.splitTextToSize(text, width) as string[]) {
      if (y + lineHeight > pageHeight - 15) {
        doc.addPage();
        y = 20;
      }
      doc.text(line, margin, y);
      y += lineHeight;
    }
    y += gap;
  };

  write(input.title, 16, "bold", 2);
  write(input.subtitle, 9, "normal", 5);
  for (const section of sections) {
    const range = options.timestamps ? sectionRange(section, hours) : "";
    if (range && language !== "somali") write(range, 9, "bold", 1);
    if (language !== "english") for (const s of section.segments) write(segmentLine(s, options, hours));
    if (language !== "somali" && section.english) write(section.english, 10, "italic", 4);
  }
  return doc.output("blob");
};
