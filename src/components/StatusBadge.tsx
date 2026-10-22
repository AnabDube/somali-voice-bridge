import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { DisplayStatus, StatusTone } from "@/lib/pipeline";

const VARIANT: Record<StatusTone, "default" | "secondary" | "destructive" | "outline"> = {
  ready: "default",
  working: "secondary",
  warning: "outline",
  failed: "destructive",
  neutral: "outline",
};

interface StatusBadgeProps {
  status: DisplayStatus;
  className?: string;
}

/** The one place a recording's status is rendered, so every page shows it the same way. */
const StatusBadge = ({ status, className }: StatusBadgeProps) => (
  <Badge
    variant={VARIANT[status.tone]}
    className={cn(
      "max-w-full gap-1 whitespace-normal text-left",
      status.tone === "warning" && "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      className,
    )}
    role="status"
  >
    {status.tone === "working" && <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />}
    {status.label}
  </Badge>
);

export default StatusBadge;
