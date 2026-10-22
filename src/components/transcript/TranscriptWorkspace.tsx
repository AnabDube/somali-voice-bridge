import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  RefreshCw,
  Replace,
  Search,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
import { supabase } from "@/integrations/supabase/client";
import { useGlossary } from "@/hooks/useGlossary";
import { useSegments } from "@/hooks/useSegments";
import {
  buildBlocks,
  buildSections,
  confidenceSummary,
  findActiveIndex,
  formatTimestamp,
  hasTiming,
  isEdited,
  isLowConfidence,
  needsHours,
  parseTranslatedSections,
  speakersOf,
  type Section,
  type TranscriptSegment,
} from "@/lib/segments";
import { DEFAULT_SEARCH, buildPattern, findMatches, type SearchOptions, type TextUpdate } from "@/lib/transcriptSearch";
import {
  buildDocx,
  buildPdf,
  downloadBlob,
  exportFileName,
  textBlob,
  toBilingualTxt,
  toEnglishTxt,
  toSomaliTxt,
  toSrt,
} from "@/lib/transcriptExport";
import SegmentRow from "@/components/transcript/SegmentRow";
import ExportMenu, { type ExportKind } from "@/components/transcript/ExportMenu";
import FindReplaceDialog from "@/components/transcript/FindReplaceDialog";
import SpeakersDialog from "@/components/transcript/SpeakersDialog";
import { cn } from "@/lib/utils";

export interface TranslationState {
  active: boolean;
  failed: boolean;
  error: string | null;
  progress: string | null;
  retrying: boolean;
}

interface TranscriptWorkspaceProps {
  transcription: {
    id: string;
    somali_text: string | null;
    somali_text_cleaned: string | null;
    english_text: string | null;
    english_text_research: string | null;
    translation_progress: unknown;
    reviewed_at: string | null;
    verified_for_training: boolean;
  };
  fileName: string;
  userName: string;
  audioName: string;
  audioRef: React.RefObject<HTMLAudioElement>;
  hasAudio: boolean;
  translation: TranslationState;
  onRetryTranslation: () => void;
  /** The transcript row changed on the server (e.g. a section was re-translated). */
  onTranscriptChanged: () => void;
  onMarkReviewed: () => Promise<void>;
}

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const TranscriptWorkspace = ({
  transcription,
  fileName,
  userName,
  audioName,
  audioRef,
  hasAudio,
  translation,
  onRetryTranslation,
  onTranscriptChanged,
  onMarkReviewed,
}: TranscriptWorkspaceProps) => {
  const { segments, loading, error, saving, applyUpdates, renameSpeaker } = useSegments(transcription.id);
  const glossary = useGlossary();

  const [tab, setTab] = useState("transcript");
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH);
  const [matchIndex, setMatchIndex] = useState(0);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [showEnglish, setShowEnglish] = useState(true);
  const [follow, setFollow] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [activePos, setActivePos] = useState(-1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [speakersOpen, setSpeakersOpen] = useState(false);
  const [exportTimestamps, setExportTimestamps] = useState(true);
  const [exportSpeakers, setExportSpeakers] = useState(true);
  const [retranslating, setRetranslating] = useState<{ done: number; total: number } | null>(null);
  const [plainSomali, setPlainSomali] = useState<"corrected" | "cleaned">("corrected");
  const [plainEnglish, setPlainEnglish] = useState<"standard" | "research">("standard");
  const [copied, setCopied] = useState<string | null>(null);
  const lastUserScroll = useRef(0);

  // ------------------------------------------------------------------ derived
  const timed = hasTiming(segments);
  const hours = needsHours(segments);
  const confidence = useMemo(() => confidenceSummary(segments), [segments]);
  const speakers = useMemo(() => speakersOf(segments), [segments]);
  const visible = useMemo(() => (onlyFlagged ? segments.filter(isLowConfidence) : segments), [segments, onlyFlagged]);
  const pattern = useMemo(() => buildPattern(query, options), [query, options]);
  const found = useMemo(() => findMatches(visible, query, options), [visible, query, options]);
  const currentMatchId = found.matches[matchIndex]?.segmentId ?? null;

  const translated = useMemo(() => parseTranslatedSections(transcription.translation_progress), [transcription.translation_progress]);
  const sections = useMemo<Section[]>(
    () => buildSections(visible, translated.parts, !!transcription.english_text),
    [visible, translated.parts, transcription.english_text],
  );
  const staleSections = useMemo(() => sections.filter((s) => s.stale), [sections]);
  const hasEnglish = !!transcription.english_text;
  const beside = showEnglish && !onlyFlagged && (translated.parts.length > 0 || translation.active);

  const isDraft = !transcription.reviewed_at && !transcription.verified_for_training && !isEdited(segments);

  // ------------------------------------------------------------ virtual list
  // Only the blocks near the screen are drawn, so a two-hour interview stays fast.
  const blocks = useMemo(
    () => buildBlocks(onlyFlagged ? [{ index: 0, segments: visible, english: null, translatedAt: null, stale: false }] : sections),
    [onlyFlagged, visible, sections],
  );
  const blockOf = useMemo(() => {
    const map = new Map<string, number>();
    blocks.forEach((block, index) => block.segments.forEach((s) => map.set(s.id, index)));
    return map;
  }, [blocks]);

  const hasSegments = segments.length > 0;
  const listRef = useRef<HTMLDivElement>(null);
  const aboveRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // The list does not start at the top of the page; tell the virtualizer where it does.
  // Measured only when something above the list changes size (a banner, the toolbar
  // wrapping), never on every render, because measuring forces the browser to lay the page out.
  useLayoutEffect(() => {
    const above = aboveRef.current;
    if (!above) return;
    const measure = () => {
      const top = (listRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY;
      setScrollMargin((previous) => (Math.abs(previous - top) > 1 ? top : previous));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(above);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [tab, loading, error, hasSegments]);
  const virtualizer = useWindowVirtualizer({
    count: blocks.length,
    estimateSize: (index) => 24 + (blocks[index]?.segments.length ?? 1) * 62,
    overscan: 3,
    scrollMargin,
  });

  /** Bring a segment into view, drawing its block first if it is far from the screen. */
  const scrollToSegment = useCallback(
    (segment: TranscriptSegment | undefined, block: ScrollLogicalPosition = "center") => {
      if (!segment) return;
      const reveal = (behavior: ScrollBehavior) =>
        document.getElementById(`seg-${segment.idx}`)?.scrollIntoView({ block, behavior });
      if (document.getElementById(`seg-${segment.idx}`)) return reveal(prefersReducedMotion() ? "auto" : "smooth");
      const index = blockOf.get(segment.id);
      if (index === undefined) return;
      virtualizer.scrollToIndex(index, { align: "start" });
      // Once the block has been drawn (and measured), centre the row itself.
      setTimeout(() => reveal("auto"), 120);
      setTimeout(() => reveal("auto"), 400);
    },
    [blockOf, virtualizer],
  );

  /**
   * Move keyboard focus to a segment, drawing it first if it isn't on screen.
   * A row that is already drawn is focused at once. A far-away one needs a moment to
   * be drawn, so focus is retried, but only while it is still the row the user asked for
   * (otherwise a late retry would drag focus back from a later key press).
   */
  const focusTarget = useRef<string | null>(null);
  const focusSegment = useCallback(
    (segment: TranscriptSegment | undefined) => {
      if (!segment) return;
      focusTarget.current = segment.id;
      setFocusId(segment.id);
      const row = () => document.querySelector(`[data-segment-id="${segment.id}"]`) as HTMLElement | null;
      const focus = () => {
        if (focusTarget.current === segment.id) row()?.focus({ preventScroll: true });
      };
      if (row()) {
        // Already drawn: just keep it in view.
        row()?.scrollIntoView({ block: "nearest" });
        focus();
        return;
      }
      scrollToSegment(segment, "nearest");
      setTimeout(focus, 150);
      setTimeout(focus, 450);
    },
    [scrollToSegment],
  );

  // --------------------------------------------------------------- playback
  // Which segment is being spoken, tracked while the audio plays.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !timed) {
      setActivePos(-1);
      return;
    }
    let frame = 0;
    const update = () => setActivePos((previous) => {
      // Nothing is "playing" until the audio has started or been moved.
      const next = audio.paused && audio.currentTime === 0 ? -1 : findActiveIndex(segments, audio.currentTime);
      return previous === next ? previous : next;
    });
    const tick = () => {
      update();
      frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      update();
    };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onPause);
    audio.addEventListener("seeked", update);
    audio.addEventListener("timeupdate", update);
    if (!audio.paused) onPlay();
    else update();
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onPause);
      audio.removeEventListener("seeked", update);
      audio.removeEventListener("timeupdate", update);
    };
  }, [audioRef, hasAudio, segments, timed]);

  // The page follows the audio, unless the user has just scrolled on their own.
  useEffect(() => {
    const mark = () => {
      lastUserScroll.current = Date.now();
    };
    window.addEventListener("wheel", mark, { passive: true });
    window.addEventListener("touchmove", mark, { passive: true });
    window.addEventListener("keydown", mark);
    return () => {
      window.removeEventListener("wheel", mark);
      window.removeEventListener("touchmove", mark);
      window.removeEventListener("keydown", mark);
    };
  }, []);

  useEffect(() => {
    if (!follow || !playing || activePos < 0 || tab !== "transcript") return;
    if (Date.now() - lastUserScroll.current < 4000) return;
    scrollToSegment(segments[activePos]);
    // Only when the playing segment changes: re-running when scrollToSegment's identity changes
    // (for example after an edit) would scroll the page unexpectedly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePos, follow, playing, segments, tab]);

  const seek = useCallback(
    (segment: TranscriptSegment) => {
      const audio = audioRef.current;
      if (!audio || segment.start_seconds === null) return;
      audio.currentTime = segment.start_seconds;
      void audio.play().catch(() => undefined);
      lastUserScroll.current = 0;
    },
    [audioRef],
  );

  // ----------------------------------------------------------------- editing
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const saveEdit = useCallback(
    async (id: string, text: string) => {
      if (await applyUpdates([{ id, text }])) setEditingId(null);
    },
    [applyUpdates],
  );
  const changeSpeaker = useCallback((id: string, name: string | null) => void applyUpdates([{ id, speaker: name }]), [applyUpdates]);
  const applyTextUpdates = useCallback((updates: TextUpdate[]) => applyUpdates(updates), [applyUpdates]);

  // -------------------------------------------------------------- navigation
  useEffect(() => setMatchIndex(0), [query, options, onlyFlagged]);

  useEffect(() => {
    if (query && currentMatchId) scrollToSegment(visible.find((s) => s.id === currentMatchId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchIndex, found.total]);

  const stepMatch = (delta: number) => {
    if (found.matches.length === 0) return;
    setMatchIndex((i) => (i + delta + found.matches.length) % found.matches.length);
  };

  const jumpToFlagged = (delta: 1 | -1) => {
    const flagged = visible.filter(isLowConfidence);
    if (flagged.length === 0) return;
    const here = visible.findIndex((s) => s.id === (focusId ?? visible[Math.max(activePos, 0)]?.id));
    let target: TranscriptSegment | undefined;
    if (delta === 1) target = visible.slice(Math.max(here, -1) + 1).find(isLowConfidence) ?? flagged[0];
    else target = [...visible.slice(0, Math.max(here, 0))].reverse().find(isLowConfidence) ?? flagged[flagged.length - 1];
    if (!target) return;
    scrollToSegment(target);
    focusSegment(target);
  };

  // Arrow keys move between segments; Enter plays; E edits.
  const onListKeyDown = (e: React.KeyboardEvent) => {
    const row = (e.target as HTMLElement).closest("[data-segment-id]") as HTMLElement | null;
    if (!row || e.target !== row) return;
    const position = visible.findIndex((s) => s.id === row.dataset.segmentId);
    if (position < 0) return;
    const move = (to: number) => {
      const next = visible[Math.min(visible.length - 1, Math.max(0, to))];
      if (next) {
        e.preventDefault();
        focusSegment(next);
      }
    };
    switch (e.key) {
      case "ArrowDown": return move(position + 1);
      case "ArrowUp": return move(position - 1);
      case "Home": return move(0);
      case "End": return move(visible.length - 1);
      case "Enter":
      case " ":
        e.preventDefault();
        return seek(visible[position]);
      case "e":
      case "E":
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          setEditingId(visible[position].id);
        }
        return;
    }
  };

  // ------------------------------------------------------------ translation
  const retranslate = async (indices: number[]) => {
    if (indices.length === 0) return;
    setRetranslating({ done: 0, total: indices.length });
    let failed = 0;
    for (const [n, index] of indices.entries()) {
      const { error: invokeError } = await supabase.functions.invoke("translate-text", {
        body: { transcription_id: transcription.id, section: index },
      });
      if (invokeError) failed++;
      setRetranslating({ done: n + 1, total: indices.length });
    }
    setRetranslating(null);
    onTranscriptChanged();
    if (failed > 0) toast.error(`${failed} ${failed === 1 ? "section" : "sections"} couldn't be re-translated. Please try again.`);
    else toast.success("Translation updated.");
  };

  // ------------------------------------------------------------------ export
  const doExport = async (kind: ExportKind) => {
    const options = { title: fileName, timestamps: exportTimestamps, speakers: exportSpeakers };
    const allSections = buildSections(segments, translated.parts, hasEnglish);
    const status = isDraft ? "Draft: machine transcript, not yet reviewed" : "Reviewed";
    const subtitle = `${segments.length} segments · ${status} · exported ${new Date().toLocaleDateString()}`;
    const name = (suffix: string, ext: string) => exportFileName(userName, audioName, suffix, ext);
    try {
      switch (kind) {
        case "txt-somali":
          return downloadBlob(textBlob(toSomaliTxt(segments, options)), name("transcript", "txt"));
        case "txt-english":
          return downloadBlob(textBlob(toEnglishTxt(allSections, options)), name("translation", "txt"));
        case "txt-both":
          return downloadBlob(textBlob(toBilingualTxt(allSections, options)), name("bilingual", "txt"));
        case "srt":
          return downloadBlob(textBlob(toSrt(segments, { speakers: exportSpeakers }), "application/x-subrip"), name("subtitles", "srt"));
        case "docx-somali":
        case "docx-both": {
          const language = kind === "docx-both" ? "both" : "somali";
          return downloadBlob(await buildDocx({ title: fileName, subtitle, sections: allSections, language, options }), name(language === "both" ? "bilingual" : "transcript", "docx"));
        }
        case "pdf-somali":
        case "pdf-both": {
          const language = kind === "pdf-both" ? "both" : "somali";
          return downloadBlob(await buildPdf({ title: fileName, subtitle, sections: allSections, language, options }), name(language === "both" ? "bilingual" : "transcript", "pdf"));
        }
      }
    } catch (e) {
      console.error("Export failed:", e);
      toast.error("The export couldn't be created. Please try again.");
    }
  };

  const copy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
    toast.success("Copied to clipboard");
  };

  // ------------------------------------------------------------------ render
  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border bg-card py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading the transcript" />
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (segments.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        There is no transcript text yet.
      </div>
    );
  }

  const renderRow = (segment: TranscriptSegment) => (
    <SegmentRow
      key={segment.id}
      segment={segment}
      hours={hours}
      active={segments[activePos]?.id === segment.id}
      tabbable={(focusId ?? visible[0]?.id) === segment.id}
      flagged={isLowConfidence(segment)}
      pattern={pattern}
      currentMatch={segment.id === currentMatchId}
      editing={editingId === segment.id}
      speakers={speakers}
      canSeek={hasAudio && timed}
      onSeek={seek}
      onStartEdit={startEdit}
      onSave={saveEdit}
      onCancelEdit={cancelEdit}
      onSpeaker={changeSpeaker}
      onFocusRow={setFocusId}
    />
  );

  const englishCard = (section: Section) => {
    const first = section.segments[0];
    const last = section.segments[section.segments.length - 1];
    const range = [formatTimestamp(first?.start_seconds ?? null, hours), formatTimestamp(last?.end_seconds ?? null, hours)].filter(Boolean).join("–");
    return (
      <aside
        aria-label={`English translation${range ? ` for ${range}` : ""}`}
        className="mt-1 rounded-lg border border-border bg-muted/30 p-3 text-sm md:sticky md:top-44 md:mt-0 md:self-start"
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">English</span>
          {range && <span className="font-mono text-xs text-muted-foreground">{range}</span>}
          {section.stale && (
            <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Edited since translated
            </Badge>
          )}
        </div>
        {section.english ? (
          <p className="whitespace-pre-wrap leading-relaxed">{section.english}</p>
        ) : translation.active ? (
          <p className="flex items-center gap-2 italic text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Translating…
          </p>
        ) : (
          <p className="italic text-muted-foreground">No translation for this part yet.</p>
        )}
        {section.stale && (
          <Button
            size="sm"
            variant="outline"
            className="mt-2 gap-1.5"
            disabled={!!retranslating}
            onClick={() => retranslate([section.index])}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Re-translate this part
          </Button>
        )}
      </aside>
    );
  };

  return (
    <div className="space-y-4">
      {isDraft && (
        <div role="note" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <p className="min-w-0 flex-1">
            <strong>Draft: machine transcript, please review.</strong> Listen along, check the underlined parts, and correct
            anything that’s wrong.
          </p>
          <Button size="sm" variant="outline" onClick={onMarkReviewed}>
            <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Mark as reviewed
          </Button>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
            <TabsTrigger value="somali">Somali text</TabsTrigger>
            <TabsTrigger value="english" disabled={!hasEnglish}>English</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
              {saving ? "Saving…" : "All changes saved"}
            </span>
            <ExportMenu
              hasEnglish={hasEnglish}
              hasTiming={timed}
              timestamps={exportTimestamps}
              speakers={exportSpeakers}
              onTimestamps={setExportTimestamps}
              onSpeakers={setExportSpeakers}
              onExport={doExport}
            />
          </div>
        </div>

        {/* ----------------------------------------------------- segments */}
        <TabsContent value="transcript" className="mt-3 space-y-3">
          <div ref={aboveRef} className="space-y-3">
          <div className="space-y-2 rounded-xl border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[12rem] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      stepMatch(e.shiftKey ? -1 : 1);
                    } else if (e.key === "Escape") setQuery("");
                  }}
                  placeholder="Search this transcript"
                  aria-label="Search this transcript"
                  className="pl-8 pr-8"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
              <Toggle size="sm" pressed={options.matchCase} onPressedChange={(v) => setOptions((o) => ({ ...o, matchCase: v }))} aria-label="Match case">Aa</Toggle>
              <Toggle size="sm" pressed={options.wholeWord} onPressedChange={(v) => setOptions((o) => ({ ...o, wholeWord: v }))} aria-label="Whole word">“ab”</Toggle>
              <span className="min-w-[4.5rem] text-xs text-muted-foreground" role="status" aria-live="polite">
                {query ? (found.total > 0 ? `${matchIndex + 1} of ${found.matches.length}` : "No matches") : ""}
              </span>
              <Button size="icon" variant="outline" className="h-8 w-8" aria-label="Previous match" disabled={found.matches.length === 0} onClick={() => stepMatch(-1)}>
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Button size="icon" variant="outline" className="h-8 w-8" aria-label="Next match" disabled={found.matches.length === 0} onClick={() => stepMatch(1)}>
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setFindOpen(true)}>
                <Replace className="h-3.5 w-3.5" aria-hidden="true" /> Find &amp; replace
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSpeakersOpen(true)}>
                <Users className="h-3.5 w-3.5" aria-hidden="true" /> Speakers{speakers.length > 0 && ` (${speakers.length})`}
              </Button>
              {translated.parts.length > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={showEnglish} onCheckedChange={setShowEnglish} aria-label="Show English beside the Somali" /> English beside
                </label>
              )}
              {hasAudio && timed && (
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={follow} onCheckedChange={setFollow} aria-label="Follow playback" /> Follow playback
                </label>
              )}
            </div>
          </div>

          {/* confidence legend + summary */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border px-3 py-2 text-sm" aria-label="Confidence">
            {confidence.measured === 0 ? (
              <p className="text-muted-foreground">Confidence information isn’t available for this older transcript.</p>
            ) : (
              <>
                <p>
                  <span className="underline decoration-amber-500 decoration-dotted decoration-2 underline-offset-4">Underlined</span>{" "}
                  = <strong>check this part</strong>: the model was unsure.{" "}
                  <span className="text-muted-foreground">
                    {confidence.flagged} of {confidence.measured} parts flagged.
                  </span>
                </p>
                {confidence.flagged > 0 && (
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2">
                      <Switch checked={onlyFlagged} onCheckedChange={setOnlyFlagged} aria-label="Show only flagged parts" /> Only flagged
                    </label>
                    <Button size="sm" variant="outline" onClick={() => jumpToFlagged(-1)}>Previous flagged</Button>
                    <Button size="sm" variant="outline" onClick={() => jumpToFlagged(1)}>Next flagged</Button>
                  </div>
                )}
              </>
            )}
            {confidence.mostlyFlagged && (
              <p className="w-full text-amber-800 dark:text-amber-300">
                Most of this transcript is low confidence, so the audio may be difficult. Listen along as you review.
              </p>
            )}
          </div>

          {/* translation state */}
          {translation.failed && !hasEnglish && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-destructive">Translation failed</p>
                <p className="text-muted-foreground">{translation.error ?? "Something went wrong."} Your Somali transcript is not affected.</p>
              </div>
              <Button size="sm" variant="outline" className="gap-1.5" disabled={translation.retrying} onClick={onRetryTranslation}>
                {translation.retrying && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} Retry translation
              </Button>
            </div>
          )}
          {translation.active && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Translating…{translation.progress ? ` (${translation.progress})` : ""}
            </p>
          )}
          {staleSections.length > 0 && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm">
              <span className="flex-1">
                {staleSections.length} {staleSections.length === 1 ? "part was" : "parts were"} edited after being translated.
              </span>
              <Button size="sm" variant="outline" className="gap-1.5" disabled={!!retranslating} onClick={() => retranslate(staleSections.map((s) => s.index))}>
                {retranslating ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                {retranslating ? `Updating ${retranslating.done} of ${retranslating.total}…` : "Update translation"}
              </Button>
            </div>
          )}

          </div>

          {visible.length === 0 ? (
            <p className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">No flagged parts.</p>
          ) : (
            <div ref={listRef} onKeyDown={onListKeyDown} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const block = blocks[item.index];
                if (!block) return null;
                return (
                  <div
                    key={block.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="pb-3"
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}
                  >
                    <section
                      aria-label={onlyFlagged ? "Flagged segments" : `Part ${block.section.index + 1}`}
                      className={cn(beside && "gap-x-6 rounded-xl border border-border bg-card p-2 md:grid md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]")}
                    >
                      <div role="list" aria-label="Transcript segments">{block.segments.map(renderRow)}</div>
                      {beside && block.showEnglish && englishCard(block.section)}
                    </section>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ------------------------------------------------- plain Somali */}
        <TabsContent value="somali" className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={plainSomali === "corrected" ? "default" : "outline"} onClick={() => setPlainSomali("corrected")}>
              {isEdited(segments) ? "Your corrected text" : "Transcript text"}
            </Button>
            {transcription.somali_text_cleaned && (
              <Button size="sm" variant={plainSomali === "cleaned" ? "default" : "outline"} onClick={() => setPlainSomali("cleaned")}>
                AI-cleaned
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto gap-1.5"
              onClick={() => copy("somali", plainSomali === "cleaned" ? transcription.somali_text_cleaned ?? "" : transcription.somali_text ?? "")}
            >
              {copied === "somali" ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />} Copy
            </Button>
          </div>
          {plainSomali === "cleaned" && (
            <p className="text-xs text-muted-foreground">The AI-cleaned version is made from the model’s original text, so it doesn’t include your corrections.</p>
          )}
          <div className="whitespace-pre-wrap rounded-xl border border-border bg-card p-5 leading-relaxed">
            {plainSomali === "cleaned" ? transcription.somali_text_cleaned : transcription.somali_text}
          </div>
        </TabsContent>

        {/* ------------------------------------------------ plain English */}
        <TabsContent value="english" className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={plainEnglish === "standard" ? "default" : "outline"} onClick={() => setPlainEnglish("standard")}>
              Translation
            </Button>
            {transcription.english_text_research && (
              <Button size="sm" variant={plainEnglish === "research" ? "default" : "outline"} onClick={() => setPlainEnglish("research")}>
                Research translation
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto gap-1.5"
              onClick={() => copy("english", plainEnglish === "research" ? transcription.english_text_research ?? "" : transcription.english_text ?? "")}
            >
              {copied === "english" ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />} Copy
            </Button>
          </div>
          <div className="whitespace-pre-wrap rounded-xl border border-border bg-card p-5 leading-relaxed">
            {plainEnglish === "research" ? transcription.english_text_research : transcription.english_text}
          </div>
        </TabsContent>
      </Tabs>

      <FindReplaceDialog
        open={findOpen}
        onOpenChange={setFindOpen}
        segments={segments}
        initialFind={query}
        initialOptions={options}
        glossary={glossary}
        onApply={applyTextUpdates}
      />
      <SpeakersDialog open={speakersOpen} onOpenChange={setSpeakersOpen} segments={segments} onRename={renameSpeaker} />
    </div>
  );
};

export default TranscriptWorkspace;
