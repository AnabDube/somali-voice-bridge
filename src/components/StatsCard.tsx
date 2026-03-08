import { LucideIcon } from "lucide-react";

interface StatsCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  subtext?: string;
}

const StatsCard = ({ icon: Icon, label, value, subtext }: StatsCardProps) => (
  <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-card">
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
      <Icon className="h-5 w-5 text-muted-foreground" />
    </div>
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="font-display text-xl font-bold">{value}</p>
      {subtext && <p className="text-xs text-muted-foreground">{subtext}</p>}
    </div>
  </div>
);

export default StatsCard;
