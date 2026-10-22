import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface GlossaryEntry {
  id: string;
  find_text: string;
  replace_text: string;
}

/** The user's saved corrections (a name or term the model keeps getting wrong). */
export const useGlossary = () => {
  const { user } = useAuth();
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);

  const load = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("user_glossary")
      .select("id, find_text, replace_text")
      .order("created_at", { ascending: true });
    setEntries((data ?? []) as GlossaryEntry[]);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const remember = useCallback(
    async (find: string, replace: string) => {
      if (!user || !find.trim()) return;
      const { error } = await supabase
        .from("user_glossary")
        .upsert({ user_id: user.id, find_text: find, replace_text: replace }, { onConflict: "user_id,find_text" });
      if (error) toast.error("The correction couldn't be saved for later.");
      else await load();
    },
    [user, load],
  );

  const forget = useCallback(
    async (id: string) => {
      const { error } = await supabase.from("user_glossary").delete().eq("id", id);
      if (error) toast.error("Couldn't remove that saved correction.");
      else setEntries((prev) => prev.filter((e) => e.id !== id));
    },
    [],
  );

  return { entries, remember, forget };
};
