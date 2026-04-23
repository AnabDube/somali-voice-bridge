import { Sparkles, Loader2, FileText, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface ResearchSummary {
  overview?: string;
  key_themes?: string[];
  notable_quotes?: Array<{ quote: string; context?: string }>;
  action_points?: string[];
}

interface Props {
  summary: ResearchSummary | null;
  isPending: boolean;
  onExportDoc?: () => void;
  onRetry?: () => void;
}

const ResearchSummaryPanel = ({ summary, isPending, onExportDoc, onRetry }: Props) => {
  const hasContent = !!summary && (
    !!summary.overview ||
    (summary.key_themes?.length ?? 0) > 0 ||
    (summary.notable_quotes?.length ?? 0) > 0 ||
    (summary.action_points?.length ?? 0) > 0
  );

  return (
    <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h3 className="font-display text-sm font-semibold">Research Summary</h3>
          {isPending && !hasContent && (
            <Badge variant="secondary" className="h-5 gap-1 text-[10px]">
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> Analysing
            </Badge>
          )}
        </div>
        {hasContent && onExportDoc && (
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={onExportDoc}>
            <FileText className="h-3.5 w-3.5" /> Export .doc
          </Button>
        )}
      </div>

      <div className="p-5">
        {!hasContent && isPending ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/50" />
            <p className="mt-3 text-sm italic text-muted-foreground">
              Generating research summary…
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Extracting themes, quotes, and action points from the translation.
            </p>
          </div>
        ) : !hasContent ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <AlertCircle className="h-6 w-6 text-muted-foreground/50" />
            <p className="mt-3 text-sm text-muted-foreground">No summary available yet.</p>
            {onRetry && (
              <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
                Generate Summary
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {summary?.overview && (
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Overview
                </h4>
                <p className="text-sm leading-relaxed">{summary.overview}</p>
              </section>
            )}

            {(summary?.key_themes?.length ?? 0) > 0 && (
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Key Themes
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {summary!.key_themes!.map((theme, i) => (
                    <Badge key={i} variant="secondary" className="text-xs">
                      {theme}
                    </Badge>
                  ))}
                </div>
              </section>
            )}

            {(summary?.notable_quotes?.length ?? 0) > 0 && (
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Notable Quotes
                </h4>
                <div className="space-y-3">
                  {summary!.notable_quotes!.map((q, i) => (
                    <div
                      key={i}
                      className="border-l-2 border-primary/40 pl-3"
                    >
                      <p className="text-sm italic leading-relaxed">"{q.quote}"</p>
                      {q.context && (
                        <p className="mt-1 text-xs text-muted-foreground">{q.context}</p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {(summary?.action_points?.length ?? 0) > 0 && (
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Action Points
                </h4>
                <ul className="space-y-1.5">
                  {summary!.action_points!.map((point, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm leading-relaxed">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ResearchSummaryPanel;
