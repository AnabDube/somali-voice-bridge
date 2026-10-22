-- Phase 1: reliable processing pipeline
--
-- Every recording moves through visible steps, each with its own status,
-- error message, attempt count and timestamp:
--   upload -> transcription -> cleaning / translation / research -> summary
-- A watchdog (pg_cron) fails any step that is stuck, so nothing can hang
-- silently, and every failed step can be retried on its own.
--
-- Additive only: existing tables, columns and policies keep working, so the
-- currently deployed frontend is unaffected. Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Step table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.processing_steps (
  upload_id     UUID        NOT NULL REFERENCES public.audio_uploads(id) ON DELETE CASCADE,
  step          TEXT        NOT NULL CHECK (step IN ('upload','transcription','cleaning','translation','research','summary')),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  error_message TEXT,
  attempts      INTEGER     NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, step)
);

CREATE INDEX IF NOT EXISTS idx_processing_steps_user ON public.processing_steps(user_id);
CREATE INDEX IF NOT EXISTS idx_processing_steps_active
  ON public.processing_steps(status) WHERE status IN ('pending','processing');

ALTER TABLE public.processing_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own steps" ON public.processing_steps;
CREATE POLICY "Users can view own steps" ON public.processing_steps
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins can view all steps" ON public.processing_steps;
CREATE POLICY "Admins can view all steps" ON public.processing_steps
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

-- The browser may only record the 'upload' step of its own recordings. Every
-- other step is written by edge functions / the database (service role), so a
-- client can't mark work as done.
DROP POLICY IF EXISTS "Users can insert own upload step" ON public.processing_steps;
CREATE POLICY "Users can insert own upload step" ON public.processing_steps
  FOR INSERT WITH CHECK (
    auth.uid() = user_id AND step = 'upload'
    AND EXISTS (SELECT 1 FROM public.audio_uploads a WHERE a.id = upload_id AND a.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Users can update own upload step" ON public.processing_steps;
CREATE POLICY "Users can update own upload step" ON public.processing_steps
  FOR UPDATE USING (auth.uid() = user_id AND step = 'upload')
  WITH CHECK (auth.uid() = user_id AND step = 'upload');

DROP TRIGGER IF EXISTS update_processing_steps_updated_at ON public.processing_steps;
CREATE TRIGGER update_processing_steps_updated_at
  BEFORE UPDATE ON public.processing_steps
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Live updates: the app subscribes to changes on this table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'processing_steps'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.processing_steps;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Retry safety: one transcript per recording, minutes charged once
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS transcriptions_upload_id_key ON public.transcriptions(upload_id);

ALTER TABLE public.audio_uploads
  ADD COLUMN IF NOT EXISTS minutes_charged BOOLEAN NOT NULL DEFAULT false;

-- Everything already completed has been charged (or belongs to an admin).
UPDATE public.audio_uploads SET minutes_charged = true WHERE status = 'completed' AND NOT minutes_charged;

-- ---------------------------------------------------------------------------
-- 3. Step functions (called by edge functions with the service role)
-- ---------------------------------------------------------------------------

-- Atomically claim a step to work on it. Returns:
--   'claimed'    - you own the step now; do the work
--   'processing' - someone else is already doing it (a second click / call)
--   'done'       - already finished (only when p_force is false)
CREATE OR REPLACE FUNCTION public.claim_step(p_upload UUID, p_step TEXT, p_force BOOLEAN DEFAULT false)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  INSERT INTO processing_steps (upload_id, user_id, step, status)
  SELECT a.id, a.user_id, p_step, 'pending' FROM audio_uploads a WHERE a.id = p_upload
  ON CONFLICT (upload_id, step) DO NOTHING;

  UPDATE processing_steps
     SET status = 'processing', attempts = attempts + 1, started_at = now(),
         updated_at = now(), error_message = NULL
   WHERE upload_id = p_upload AND step = p_step
     AND (status IN ('pending', 'failed') OR (p_force AND status = 'done'));
  IF FOUND THEN
    RETURN 'claimed';
  END IF;

  SELECT status INTO v_status FROM processing_steps WHERE upload_id = p_upload AND step = p_step;
  RETURN COALESCE(v_status, 'missing');
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_step(p_upload UUID, p_step TEXT, p_ok BOOLEAN, p_error TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO processing_steps (upload_id, user_id, step, status, error_message, attempts, updated_at)
  SELECT a.id, a.user_id, p_step,
         CASE WHEN p_ok THEN 'done' ELSE 'failed' END,
         CASE WHEN p_ok THEN NULL ELSE left(COALESCE(p_error, 'Something went wrong. Please retry.'), 300) END,
         0, now()
    FROM audio_uploads a WHERE a.id = p_upload
  ON CONFLICT (upload_id, step) DO UPDATE
     SET status = EXCLUDED.status,
         error_message = EXCLUDED.error_message,
         updated_at = now();
END;
$$;

-- Create the follow-up steps once a transcript exists.
CREATE OR REPLACE FUNCTION public.init_pipeline_steps(p_upload UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO processing_steps (upload_id, user_id, step, status)
  SELECT a.id, a.user_id, s.step, 'pending'
    FROM audio_uploads a
   CROSS JOIN (VALUES ('cleaning'), ('translation'), ('research'), ('summary')) AS s(step)
   WHERE a.id = p_upload
  ON CONFLICT (upload_id, step) DO NOTHING;
$$;

-- After a user edits the transcript, the derived steps must run again.
-- Callable by the signed-in owner of the recording.
CREATE OR REPLACE FUNCTION public.reset_pipeline_steps(p_upload UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audio_uploads WHERE id = p_upload AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Recording not found' USING ERRCODE = '42501';
  END IF;

  INSERT INTO processing_steps (upload_id, user_id, step, status, updated_at)
  SELECT a.id, a.user_id, s.step, 'pending', now()
    FROM audio_uploads a
   CROSS JOIN (VALUES ('cleaning'), ('translation'), ('research'), ('summary')) AS s(step)
   WHERE a.id = p_upload
  ON CONFLICT (upload_id, step) DO UPDATE
     SET status = 'pending', error_message = NULL, updated_at = now();
END;
$$;

-- Charge a recording's minutes exactly once, however many times a transcription
-- is retried. Returns true only for the call that actually charged.
CREATE OR REPLACE FUNCTION public.charge_upload_minutes(p_upload UUID, p_minutes NUMERIC)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID;
BEGIN
  UPDATE audio_uploads SET minutes_charged = true
   WHERE id = p_upload AND NOT minutes_charged
  RETURNING user_id INTO v_user;

  IF v_user IS NULL THEN
    RETURN false;
  END IF;

  UPDATE profiles SET minutes_used = minutes_used + p_minutes WHERE user_id = v_user;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Watchdog: fail anything stuck (runs every minute via pg_cron)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fail_stuck_steps()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total INTEGER := 0;
  v_n INTEGER;
BEGIN
  -- Steps that have been running too long. Transcription gets 3 minutes plus
  -- half the audio length; the AI steps get 3 minutes.
  UPDATE processing_steps s
     SET status = 'failed', updated_at = now(),
         error_message = CASE s.step
           WHEN 'upload' THEN 'The upload did not finish. Please upload the file again.'
           WHEN 'transcription' THEN 'Transcription took too long and was stopped. Please retry.'
           ELSE 'This step took longer than 3 minutes and was stopped. Please retry.'
         END
    FROM audio_uploads a
   WHERE a.id = s.upload_id
     AND s.status = 'processing'
     AND COALESCE(s.started_at, s.updated_at) < now() - (CASE s.step
           WHEN 'upload' THEN interval '10 minutes'
           WHEN 'transcription' THEN (180 + 0.5 * COALESCE(a.duration_seconds, 300)) * interval '1 second'
           ELSE interval '3 minutes'
         END);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  -- Steps that were queued but never started (for example the tab was closed).
  UPDATE processing_steps s
     SET status = 'failed', updated_at = now(),
         error_message = CASE s.step
           WHEN 'transcription' THEN 'Transcription did not start. Please retry.'
           ELSE 'This step did not start. Please retry.'
         END
   WHERE s.status = 'pending'
     AND s.step <> 'upload'
     AND s.updated_at < now() - interval '5 minutes'
     AND (
       (s.step = 'transcription' AND EXISTS (
          SELECT 1 FROM processing_steps u
           WHERE u.upload_id = s.upload_id AND u.step = 'upload' AND u.status = 'done'))
       OR
       (s.step <> 'transcription' AND EXISTS (
          SELECT 1 FROM processing_steps t
           WHERE t.upload_id = s.upload_id AND t.step = 'transcription' AND t.status = 'done'))
     );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  -- Keep the older audio_uploads.status column consistent.
  UPDATE audio_uploads a
     SET status = 'failed'
    FROM processing_steps s
   WHERE s.upload_id = a.id
     AND s.step IN ('upload', 'transcription')
     AND s.status = 'failed'
     AND a.status IN ('processing', 'uploaded', 'pending');

  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_step(UUID, TEXT, BOOLEAN)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_step(UUID, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.init_pipeline_steps(UUID)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.charge_upload_minutes(UUID, NUMERIC)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_stuck_steps()                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_pipeline_steps(UUID)             FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.claim_step(UUID, TEXT, BOOLEAN)        TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_step(UUID, TEXT, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.init_pipeline_steps(UUID)              TO service_role;
GRANT EXECUTE ON FUNCTION public.charge_upload_minutes(UUID, NUMERIC)   TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_stuck_steps()                     TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_pipeline_steps(UUID)             TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('fail-stuck-steps', '* * * * *', 'SELECT public.fail_stuck_steps()');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. Backfill existing recordings so the new status display is accurate
-- ---------------------------------------------------------------------------
INSERT INTO public.processing_steps (upload_id, user_id, step, status, attempts, updated_at)
SELECT a.id, a.user_id, 'upload', 'done', 1, a.created_at
  FROM public.audio_uploads a
ON CONFLICT (upload_id, step) DO NOTHING;

INSERT INTO public.processing_steps (upload_id, user_id, step, status, error_message, attempts, updated_at)
SELECT a.id, a.user_id, 'transcription',
       CASE
         WHEN EXISTS (SELECT 1 FROM public.transcriptions t WHERE t.upload_id = a.id AND COALESCE(t.somali_text, '') <> '') THEN 'done'
         WHEN a.status IN ('failed', 'processing') THEN 'failed'
         ELSE 'pending'
       END,
       CASE
         WHEN EXISTS (SELECT 1 FROM public.transcriptions t WHERE t.upload_id = a.id AND COALESCE(t.somali_text, '') <> '') THEN NULL
         WHEN a.status IN ('failed', 'processing') THEN 'Transcription did not finish and the reason was not recorded. Please retry.'
         ELSE NULL
       END,
       1, a.updated_at
  FROM public.audio_uploads a
ON CONFLICT (upload_id, step) DO NOTHING;

INSERT INTO public.processing_steps (upload_id, user_id, step, status, error_message, attempts, updated_at)
SELECT a.id, a.user_id, s.step,
       CASE WHEN (s.step = 'cleaning'    AND t.somali_text_cleaned IS NOT NULL)
              OR (s.step = 'translation' AND t.english_text IS NOT NULL)
              OR (s.step = 'research'    AND t.english_text_research IS NOT NULL)
              OR (s.step = 'summary'     AND t.research_summary IS NOT NULL)
            THEN 'done' ELSE 'failed' END,
       CASE WHEN (s.step = 'cleaning'    AND t.somali_text_cleaned IS NOT NULL)
              OR (s.step = 'translation' AND t.english_text IS NOT NULL)
              OR (s.step = 'research'    AND t.english_text_research IS NOT NULL)
              OR (s.step = 'summary'     AND t.research_summary IS NOT NULL)
            THEN NULL ELSE 'This step did not finish. Click Retry to generate it.' END,
       1, t.updated_at
  FROM public.audio_uploads a
  JOIN public.transcriptions t ON t.upload_id = a.id
 CROSS JOIN (VALUES ('cleaning'), ('translation'), ('research'), ('summary')) AS s(step)
 WHERE COALESCE(t.somali_text, '') <> ''
ON CONFLICT (upload_id, step) DO NOTHING;
