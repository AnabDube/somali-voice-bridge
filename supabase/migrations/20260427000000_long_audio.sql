-- Phase 2: long audio
--
-- Long recordings are converted and split into parts in the browser, uploaded
-- part by part, and transcribed in order by the server (so it keeps going after
-- the tab is closed). This adds:
--   * audio_chunks: one row per uploaded part, with its own status / retries
--   * processing_steps.progress: "3 of 9 parts", shown next to a running step
--   * a per-recording lease so only one worker transcribes a recording at a time
--   * progress columns for batched translation and summary of long transcripts
--   * a chunk-aware watchdog
--
-- Additive and idempotent: the existing single-file path keeps working.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.processing_steps ADD COLUMN IF NOT EXISTS progress TEXT;

ALTER TABLE public.audio_uploads ADD COLUMN IF NOT EXISTS chunk_lease_until TIMESTAMPTZ;

-- Long transcripts are translated / summarised in batches over several calls;
-- the work done so far is kept here so the next call carries on from it.
ALTER TABLE public.transcriptions
  ADD COLUMN IF NOT EXISTS translation_progress JSONB,
  ADD COLUMN IF NOT EXISTS summary_notes JSONB;

-- ---------------------------------------------------------------------------
-- 2. Parts of a recording
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audio_chunks (
  upload_id        UUID          NOT NULL REFERENCES public.audio_uploads(id) ON DELETE CASCADE,
  idx              INTEGER       NOT NULL CHECK (idx >= 0),
  user_id          UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  start_seconds    NUMERIC(10,2) NOT NULL CHECK (start_seconds >= 0),
  duration_seconds NUMERIC(10,2) NOT NULL CHECK (duration_seconds > 0),
  file_path        TEXT          NOT NULL,
  status           TEXT          NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  error_message    TEXT,
  attempts         INTEGER       NOT NULL DEFAULT 0,
  text             TEXT,
  segments         JSONB,
  whisper_seconds  NUMERIC(10,2),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_audio_chunks_user ON public.audio_chunks(user_id);

ALTER TABLE public.audio_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own chunks" ON public.audio_chunks;
CREATE POLICY "Users can view own chunks" ON public.audio_chunks
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins can view all chunks" ON public.audio_chunks;
CREATE POLICY "Admins can view all chunks" ON public.audio_chunks
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

-- Parts are created through register_chunks() and changed by the server only.

DROP TRIGGER IF EXISTS update_audio_chunks_updated_at ON public.audio_chunks;
CREATE TRIGGER update_audio_chunks_updated_at
  BEFORE UPDATE ON public.audio_chunks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 3. Called by the signed-in owner
-- ---------------------------------------------------------------------------

-- Declare the parts of a recording before uploading them. Validates everything
-- the browser says, because the browser can't be trusted with limits:
--   at most 40 parts, each at most 15 minutes, 121 minutes in total,
--   paths inside the user's own folder, and (for non-admins) enough minutes left.
CREATE OR REPLACE FUNCTION public.register_chunks(p_upload UUID, p_chunks JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_count INTEGER;
  v_total NUMERIC := 0;
  v_item JSONB;
  v_i INTEGER := 0;
  v_prefix TEXT;
  v_remaining NUMERIC;
BEGIN
  IF v_user IS NULL OR NOT EXISTS (SELECT 1 FROM audio_uploads WHERE id = p_upload AND user_id = v_user) THEN
    RAISE EXCEPTION 'Recording not found' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_chunks) <> 'array' THEN
    RAISE EXCEPTION 'Invalid parts' USING ERRCODE = '22023';
  END IF;
  v_count := jsonb_array_length(p_chunks);
  IF v_count < 1 OR v_count > 40 THEN
    RAISE EXCEPTION 'A recording must have between 1 and 40 parts' USING ERRCODE = '22023';
  END IF;

  v_prefix := v_user::text || '/' || p_upload::text || '/';

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_chunks) LOOP
    IF (v_item->>'idx')::INTEGER <> v_i
       OR (v_item->>'start')::NUMERIC < 0
       OR (v_item->>'duration')::NUMERIC <= 0
       OR (v_item->>'duration')::NUMERIC > 900
       OR left(v_item->>'path', length(v_prefix)) <> v_prefix
       OR (v_item->>'path') LIKE '%..%' THEN
      RAISE EXCEPTION 'Invalid part %', v_i USING ERRCODE = '22023';
    END IF;
    v_total := v_total + (v_item->>'duration')::NUMERIC;
    v_i := v_i + 1;
  END LOOP;

  IF v_total > 7260 THEN
    RAISE EXCEPTION 'Recordings can be at most 120 minutes long' USING ERRCODE = '22023';
  END IF;

  IF NOT public.has_role(v_user, 'admin') THEN
    SELECT minutes_limit - minutes_used INTO v_remaining FROM profiles WHERE user_id = v_user;
    IF COALESCE(v_remaining, 0) < ceil(v_total / 60.0) THEN
      RAISE EXCEPTION 'insufficient_minutes' USING ERRCODE = '53400';
    END IF;
  END IF;

  INSERT INTO audio_chunks (upload_id, idx, user_id, start_seconds, duration_seconds, file_path)
  SELECT p_upload, (e->>'idx')::INTEGER, v_user, (e->>'start')::NUMERIC, (e->>'duration')::NUMERIC, e->>'path'
    FROM jsonb_array_elements(p_chunks) AS e
  ON CONFLICT (upload_id, idx) DO NOTHING;

  UPDATE audio_uploads SET duration_seconds = v_total WHERE id = p_upload;
END;
$$;

-- Retry: put failed (or stalled) parts back in the queue so the server carries
-- on from where it stopped. Never touches parts that are already done.
CREATE OR REPLACE FUNCTION public.restart_transcription(p_upload UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audio_uploads WHERE id = p_upload AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Recording not found' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM audio_chunks WHERE upload_id = p_upload) THEN
    RETURN false; -- a single-file recording: retried the older way
  END IF;

  UPDATE audio_chunks
     SET status = 'pending', attempts = 0, error_message = NULL
   WHERE upload_id = p_upload AND status IN ('failed', 'processing');

  UPDATE audio_uploads SET chunk_lease_until = NULL WHERE id = p_upload;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Called by edge functions (service role)
-- ---------------------------------------------------------------------------

-- Only one worker at a time may transcribe a recording's parts.
CREATE OR REPLACE FUNCTION public.acquire_chunk_lease(p_upload UUID, p_seconds INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  UPDATE audio_uploads
     SET chunk_lease_until = now() + make_interval(secs => p_seconds)
   WHERE id = p_upload AND (chunk_lease_until IS NULL OR chunk_lease_until < now())
  RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_chunk_lease(p_upload UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE audio_uploads SET chunk_lease_until = NULL WHERE id = p_upload;
$$;

-- 'claimed' | 'processing' | 'done' | 'missing'
CREATE OR REPLACE FUNCTION public.claim_chunk(p_upload UUID, p_idx INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  UPDATE audio_chunks
     SET status = 'processing', attempts = attempts + 1, error_message = NULL
   WHERE upload_id = p_upload AND idx = p_idx AND status IN ('pending', 'failed');
  IF FOUND THEN
    RETURN 'claimed';
  END IF;
  SELECT status INTO v_status FROM audio_chunks WHERE upload_id = p_upload AND idx = p_idx;
  RETURN COALESCE(v_status, 'missing');
END;
$$;

-- Record a part's result and keep the step's progress ("3 of 9 parts") and
-- heartbeat (updated_at, which the watchdog watches) current.
CREATE OR REPLACE FUNCTION public.finish_chunk(
  p_upload UUID, p_idx INTEGER, p_status TEXT, p_error TEXT DEFAULT NULL,
  p_text TEXT DEFAULT NULL, p_segments JSONB DEFAULT NULL, p_seconds NUMERIC DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_done INTEGER;
  v_total INTEGER;
BEGIN
  UPDATE audio_chunks
     SET status = p_status,
         error_message = CASE WHEN p_status = 'failed' THEN left(COALESCE(p_error, 'Something went wrong.'), 300) ELSE NULL END,
         text = CASE WHEN p_status = 'done' THEN p_text ELSE text END,
         segments = CASE WHEN p_status = 'done' THEN p_segments ELSE segments END,
         whisper_seconds = CASE WHEN p_status = 'done' THEN p_seconds ELSE whisper_seconds END
   WHERE upload_id = p_upload AND idx = p_idx;

  SELECT count(*) FILTER (WHERE status = 'done'), count(*) INTO v_done, v_total
    FROM audio_chunks WHERE upload_id = p_upload;

  UPDATE processing_steps
     SET updated_at = now(), progress = v_done || ' of ' || v_total || ' parts'
   WHERE upload_id = p_upload AND step = 'transcription' AND status = 'processing';
END;
$$;

-- Heartbeat + optional progress text for a long-running step.
CREATE OR REPLACE FUNCTION public.set_step_progress(p_upload UUID, p_step TEXT, p_progress TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE processing_steps
     SET updated_at = now(), progress = COALESCE(p_progress, progress)
   WHERE upload_id = p_upload AND step = p_step;
$$;

-- A step that did part of its work and needs another call to finish: put it
-- back in the queue (it stays visibly "in progress") instead of marking it done.
CREATE OR REPLACE FUNCTION public.requeue_step(p_upload UUID, p_step TEXT, p_progress TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE processing_steps
     SET status = 'pending', updated_at = now(), progress = p_progress, error_message = NULL
   WHERE upload_id = p_upload AND step = p_step;
$$;

-- Same as before, but a finished step no longer carries stale progress text.
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
         progress = NULL,
         updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Watchdog, now aware of parts and heartbeats
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
  -- A part that has been transcribing for over 4 minutes has stalled.
  UPDATE audio_chunks
     SET status = 'failed', error_message = 'This part took too long and was stopped. Please retry.'
   WHERE status = 'processing' AND updated_at < now() - interval '4 minutes';

  -- Steps that have shown no sign of life for too long. Every step bumps
  -- updated_at when it starts and as it makes progress, so a long recording
  -- that is still moving is left alone.
  UPDATE processing_steps s
     SET status = 'failed', updated_at = now(), progress = NULL,
         error_message = CASE s.step
           WHEN 'upload' THEN 'The upload did not finish. Please upload the file again.'
           WHEN 'transcription' THEN 'Transcription stalled and was stopped. Click Retry to carry on where it stopped.'
           ELSE 'This step stopped making progress and was cancelled. Please retry.'
         END
    FROM audio_uploads a
   WHERE a.id = s.upload_id
     AND s.status = 'processing'
     AND s.updated_at < now() - (CASE s.step
           WHEN 'upload' THEN interval '10 minutes'
           WHEN 'transcription' THEN
             CASE WHEN EXISTS (SELECT 1 FROM audio_chunks c WHERE c.upload_id = s.upload_id)
                  THEN interval '5 minutes'
                  ELSE (180 + 0.5 * COALESCE(a.duration_seconds, 300)) * interval '1 second' END
           ELSE interval '3 minutes'
         END);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;

  -- Steps that were queued but never started (for example the tab was closed).
  UPDATE processing_steps s
     SET status = 'failed', updated_at = now(), progress = NULL,
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

-- ---------------------------------------------------------------------------
-- 5b. Storage: let owners overwrite their own files
-- ---------------------------------------------------------------------------
-- Part uploads are retried with upsert, which needs UPDATE (the original bucket
-- policies only allowed insert / select / delete).
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Users can update own audio" ON storage.objects;
    CREATE POLICY "Users can update own audio" ON storage.objects
      FOR UPDATE
      USING (bucket_id = 'audio-uploads' AND auth.uid()::text = (storage.foldername(name))[1])
      WITH CHECK (bucket_id = 'audio-uploads' AND auth.uid()::text = (storage.foldername(name))[1]);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.acquire_chunk_lease(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_chunk_lease(UUID)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_chunk(UUID, INTEGER)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_chunk(UUID, INTEGER, TEXT, TEXT, TEXT, JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_step_progress(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requeue_step(UUID, TEXT, TEXT)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_stuck_steps()                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_chunks(UUID, JSONB)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restart_transcription(UUID)         FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.acquire_chunk_lease(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_chunk_lease(UUID)          TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_chunk(UUID, INTEGER)         TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_chunk(UUID, INTEGER, TEXT, TEXT, TEXT, JSONB, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_step_progress(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_step(UUID, TEXT, TEXT)      TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_stuck_steps()                  TO service_role;
GRANT EXECUTE ON FUNCTION public.register_chunks(UUID, JSONB)        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.restart_transcription(UUID)         TO authenticated, service_role;
