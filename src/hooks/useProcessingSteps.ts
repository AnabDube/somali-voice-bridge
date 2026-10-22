import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toStepMap, type StepMap, type StepRow } from "@/lib/pipeline";

const POLL_MS = 5000;

/**
 * Live processing steps for a set of recordings.
 *
 * Listens for changes over Supabase Realtime, so the page updates by itself
 * without a refresh. While anything is still running it also polls every few
 * seconds, so a dropped Realtime connection can't leave the page stale.
 */
export const useProcessingSteps = (uploadIds: string[]) => {
  const { user } = useAuth();
  const [steps, setSteps] = useState<Record<string, StepMap>>({});

  // A stable key, so a new array with the same ids doesn't re-run effects.
  const key = [...uploadIds].sort().join(",");
  const ids = useMemo(() => (key ? key.split(",") : []), [key]);

  const refetch = useCallback(async () => {
    if (!user || ids.length === 0) return;
    const { data, error } = await supabase.from("processing_steps").select("*").in("upload_id", ids);
    if (error || !data) return;

    const grouped: Record<string, StepRow[]> = Object.fromEntries(ids.map((id) => [id, []]));
    for (const row of data as StepRow[]) grouped[row.upload_id]?.push(row);

    setSteps((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = toStepMap(grouped[id]);
      return next;
    });
  }, [user, ids]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Realtime: apply each change as it arrives.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`processing-steps-${user.id}-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "processing_steps", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const row = payload.new as StepRow | undefined;
          if (!row?.upload_id) return;
          setSteps((prev) => ({
            ...prev,
            [row.upload_id]: { ...(prev[row.upload_id] ?? {}), [row.step]: row },
          }));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  // Safety net while anything is in progress.
  const anyActive = ids.some((id) =>
    Object.values(steps[id] ?? {}).some((s) => s?.status === "pending" || s?.status === "processing"),
  );
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(refetch, POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, refetch]);

  return { steps, refetch };
};
