import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface UsageBarProps {
  minutesUsed: number;
  minutesLimit: number;
  plan: string;
}

const planLabels: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  professional: "Pro",
  business: "Business",
};

const UsageBar = ({ minutesUsed, minutesLimit, plan }: UsageBarProps) => {
  const remaining = Math.max(0, minutesLimit - minutesUsed);
  const pct = minutesLimit > 0 ? Math.min(100, (minutesUsed / minutesLimit) * 100) : 100;
  const isLow = pct >= 80;
  const isExhausted = remaining <= 0;

  return (
    <div className={cn(
      "rounded-xl border p-5 shadow-card",
      isExhausted ? "border-destructive/30 bg-destructive/5" : isLow ? "border-primary/30 bg-primary/5" : "border-border bg-card"
    )}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-foreground">
              {planLabels[plan] || "Free"} Plan
            </p>
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="About your usage"
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[240px] text-xs">
                  Your {planLabels[plan] || "Free"} plan includes {minutesLimit} minutes
                  of transcription per month. Upgrade any time for more minutes.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {minutesUsed} of {minutesLimit} min used · <span className={cn(isExhausted && "text-destructive font-semibold")}>{remaining} min remaining</span>
          </p>
        </div>
        {plan !== "business" && (
          <Button size="sm" variant="outline" asChild>
            <Link to="/pricing">Upgrade Plan</Link>
          </Button>
        )}
      </div>
      <Progress
        value={pct}
        className={cn("mt-3 h-2.5", isExhausted ? "[&>div]:bg-destructive" : isLow ? "[&>div]:bg-primary" : "[&>div]:bg-secondary")}
      />
    </div>
  );
};

export default UsageBar;
