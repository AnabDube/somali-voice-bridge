import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Whether the signed-in user has the admin role.
 * `null` while the check is in flight. This only drives UI; the database
 * and edge functions enforce the role independently.
 */
export const useIsAdmin = () => {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    let cancelled = false;
    supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .then(({ data }) => {
        if (!cancelled) setIsAdmin(!!data && data.length > 0);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  return isAdmin;
};
