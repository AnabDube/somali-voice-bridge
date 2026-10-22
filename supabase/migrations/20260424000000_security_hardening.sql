-- Security hardening
--
-- 1. Users could edit their own plan / minutes via the broad "Users can update
--    own profile" policy (no column restriction). A trigger now pins the
--    billing columns for everyone except admins and the service role.
-- 2. increment_minutes_used() is SECURITY DEFINER and was executable by any
--    signed-in user, so anyone could add or subtract minutes for any user.
--    Execution is now limited to the service role (edge functions).
-- 3. Users could flag their own transcripts as "verified for training".
--    Verification columns are now admin-only.
-- 4. Admin dashboard stats are computed server-side (the client-side count
--    silently truncated at 1000 rows).
-- 5. Free-plan minutes now actually reset every month.

-- ---------------------------------------------------------------------------
-- 1. Protect billing columns on profiles
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_profile_billing_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only end-user requests are restricted. The service role (edge functions),
  -- pg_cron and migrations run without the 'authenticated' role.
  IF auth.role() = 'authenticated' AND NOT public.has_role(auth.uid(), 'admin') THEN
    IF NEW.subscription_plan IS DISTINCT FROM OLD.subscription_plan
       OR NEW.minutes_used   IS DISTINCT FROM OLD.minutes_used
       OR NEW.minutes_limit  IS DISTINCT FROM OLD.minutes_limit
       OR NEW.user_id        IS DISTINCT FROM OLD.user_id
       OR NEW.email          IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'Not allowed to modify plan, usage, or identity fields'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_billing_columns ON public.profiles;
CREATE TRIGGER protect_profile_billing_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_billing_columns();

-- Profiles are created by the handle_new_user() trigger; clients never insert.
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;

-- Same policy, but with an explicit WITH CHECK so ownership can't be changed.
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. Lock down increment_minutes_used
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.increment_minutes_used(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_minutes_used(UUID, NUMERIC) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Training verification is admin-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_transcription_verification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'authenticated' AND NOT public.has_role(auth.uid(), 'admin') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.verified_for_training OR NEW.verified_by IS NOT NULL OR NEW.verified_at IS NOT NULL THEN
        RAISE EXCEPTION 'Only admins can verify transcripts for training'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.verified_for_training IS DISTINCT FROM OLD.verified_for_training
       OR NEW.verified_by           IS DISTINCT FROM OLD.verified_by
       OR NEW.verified_at           IS DISTINCT FROM OLD.verified_at THEN
      RAISE EXCEPTION 'Only admins can verify transcripts for training'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_transcription_verification ON public.transcriptions;
CREATE TRIGGER protect_transcription_verification
  BEFORE INSERT OR UPDATE ON public.transcriptions
  FOR EACH ROW EXECUTE FUNCTION public.protect_transcription_verification();

-- ---------------------------------------------------------------------------
-- 4. Admin dashboard stats (per-user upload / transcription counts)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_user_stats()
RETURNS TABLE (user_id UUID, upload_count BIGINT, transcription_count BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.user_id,
         (SELECT count(*) FROM public.audio_uploads a WHERE a.user_id = p.user_id),
         (SELECT count(*) FROM public.transcriptions t WHERE t.user_id = p.user_id)
  FROM public.profiles p;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_user_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_user_stats() TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Monthly usage reset (1st of each month, 00:00 UTC)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'reset-monthly-usage',
      '0 0 1 * *',
      $cron$UPDATE public.profiles SET minutes_used = 0 WHERE minutes_used <> 0$cron$
    );
  END IF;
END
$$;
