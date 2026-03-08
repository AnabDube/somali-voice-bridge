import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatsCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  subtext?: string;
  highlight?: "warning" | "danger";
}

const StatsCard = ({ icon: Icon, label, value, subtext, highlight }: StatsCardProps) => (
  <div
    className={cn(
      "flex items-center gap-4 rounded-xl border p-4 shadow-card",
      highlight === "danger"
        ? "border-destructive/40 bg-destructive/5"
        : highlight === "warning"
          ? "border-accent/40 bg-accent/5"
          : "border-border bg-card"
    )}
  >
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
      <Icon className="h-5 w-5 text-muted-foreground" />
    </div>
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn(
        "font-display text-xl font-bold",
        highlight === "danger" && "text-destructive",
      )}>
        {value}
      </p>
      {subtext && <p className="text-xs text-muted-foreground">{subtext}</p>}
    </div>
  </div>
);

export default StatsCard;
