import { useState, useEffect } from "react";
import { Users, FileAudio, Clock, ShieldCheck, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Navbar from "@/components/Navbar";
import StatsCard from "@/components/StatsCard";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

interface UserRow {
  id: string;
  user_id: string;
  display_name: string | null;
  email: string | null;
  subscription_plan: string;
  minutes_used: number;
  minutes_limit: number;
  created_at: string;
}

interface UploadSummary {
  user_id: string;
  upload_count: number;
  transcription_count: number;
}

const planLimits: Record<string, number> = {
  free: 30,
  starter: 120,
  professional: 300,
  business: 9999,
};

const Admin = () => {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [uploadSummary, setUploadSummary] = useState<Map<string, UploadSummary>>(new Map());
  const [loading, setLoading] = useState(true);
  const [updatingUser, setUpdatingUser] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const checkAdmin = async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin");
      setIsAdmin(!!data && data.length > 0);
    };
    checkAdmin();
  }, [user]);

  const fetchData = async () => {
    setLoading(true);

    const { data: profiles, error: profErr } = await supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: false });

    if (profErr) {
      toast.error("Failed to load users");
      setLoading(false);
      return;
    }

    setUsers((profiles ?? []) as UserRow[]);

    const { data: uploads } = await supabase
      .from("audio_uploads")
      .select("user_id, id");

    const { data: transcriptions } = await supabase
      .from("transcriptions")
      .select("user_id, id");

    const summary = new Map<string, UploadSummary>();
    (uploads ?? []).forEach((u) => {
      const existing = summary.get(u.user_id) || { user_id: u.user_id, upload_count: 0, transcription_count: 0 };
      existing.upload_count++;
      summary.set(u.user_id, existing);
    });
    (transcriptions ?? []).forEach((t) => {
      const existing = summary.get(t.user_id) || { user_id: t.user_id, upload_count: 0, transcription_count: 0 };
      existing.transcription_count++;
      summary.set(t.user_id, existing);
    });

    setUploadSummary(summary);
    setLoading(false);
  };

  useEffect(() => {
    if (!isAdmin) return;
    fetchData();
  }, [isAdmin]);

  const handlePlanChange = async (userId: string, newPlan: string) => {
    setUpdatingUser(userId);
    const newLimit = planLimits[newPlan] || 30;
    const { error } = await supabase
      .from("profiles")
      .update({
        subscription_plan: newPlan as any,
        minutes_limit: newLimit,
      })
      .eq("user_id", userId);

    if (error) {
      toast.error("Failed to update plan");
    } else {
      toast.success(`Plan updated to ${newPlan}`);
      setUsers((prev) =>
        prev.map((u) =>
          u.user_id === userId
            ? { ...u, subscription_plan: newPlan, minutes_limit: newLimit }
            : u
        )
      );
    }
    setUpdatingUser(null);
  };

  const handleResetUsage = async (userId: string) => {
    setUpdatingUser(userId);
    const { error } = await supabase
      .from("profiles")
      .update({ minutes_used: 0 })
      .eq("user_id", userId);

    if (error) {
      toast.error("Failed to reset usage");
    } else {
      toast.success("Usage reset to 0");
      setUsers((prev) =>
        prev.map((u) =>
          u.user_id === userId ? { ...u, minutes_used: 0 } : u
        )
      );
    }
    setUpdatingUser(null);
  };

  if (isAdmin === null) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <main className="container mx-auto px-4 pt-24 text-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent mx-auto" />
        </main>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <main className="container mx-auto px-4 pt-24 text-center">
          <ShieldCheck className="mx-auto h-12 w-12 text-destructive" />
          <h1 className="mt-4 font-display text-2xl font-bold">Access Denied</h1>
          <p className="mt-2 text-muted-foreground">You don't have admin privileges to view this page.</p>
        </main>
      </div>
    );
  }

  const totalMinutes = users.reduce((sum, u) => sum + u.minutes_used, 0);
  const totalUploads = Array.from(uploadSummary.values()).reduce((sum, s) => sum + s.upload_count, 0);
  const totalTranscriptions = Array.from(uploadSummary.values()).reduce((sum, s) => sum + s.transcription_count, 0);

  const planVariant: Record<string, "default" | "secondary" | "outline"> = {
    free: "outline",
    starter: "secondary",
    professional: "default",
    business: "default",
  };

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="container mx-auto px-4 pb-12 pt-24">
        <h1 className="mb-6 font-display text-2xl font-bold">Admin Dashboard</h1>

        <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatsCard icon={Users} label="Total Users" value={`${users.length}`} />
          <StatsCard icon={FileAudio} label="Total Uploads" value={`${totalUploads}`} />
          <StatsCard icon={Clock} label="Total Minutes" value={`${Math.round(totalMinutes)}`} />
          <StatsCard icon={ShieldCheck} label="Transcriptions" value={`${totalTranscriptions}`} />
        </div>

        <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
          <div className="border-b border-border px-5 py-3">
            <h3 className="font-display text-sm font-semibold">All Users</h3>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-3 font-medium">User</th>
                    <th className="px-5 py-3 font-medium">Plan</th>
                    <th className="px-5 py-3 font-medium">Usage</th>
                    <th className="px-5 py-3 font-medium">Uploads</th>
                    <th className="px-5 py-3 font-medium">Transcriptions</th>
                    <th className="px-5 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {users.map((u) => {
                    const s = uploadSummary.get(u.user_id);
                    const isUpdating = updatingUser === u.user_id;
                    return (
                      <tr key={u.id} className="hover:bg-muted/30">
                        <td className="px-5 py-3">
                          <p className="font-medium">{u.display_name || "—"}</p>
                          <p className="text-xs text-muted-foreground">{u.email}</p>
                        </td>
                        <td className="px-5 py-3">
                          <Select
                            value={u.subscription_plan}
                            onValueChange={(val) => handlePlanChange(u.user_id, val)}
                            disabled={isUpdating}
                          >
                            <SelectTrigger className="h-8 w-[130px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="free">Free</SelectItem>
                              <SelectItem value="starter">Starter</SelectItem>
                              <SelectItem value="professional">Pro</SelectItem>
                              <SelectItem value="business">Business</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-5 py-3">
                          {u.minutes_used} / {u.minutes_limit} min
                        </td>
                        <td className="px-5 py-3">{s?.upload_count ?? 0}</td>
                        <td className="px-5 py-3">{s?.transcription_count ?? 0}</td>
                        <td className="px-5 py-3">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 text-xs"
                            disabled={isUpdating || u.minutes_used === 0}
                            onClick={() => handleResetUsage(u.user_id)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" /> Reset Usage
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default Admin;
