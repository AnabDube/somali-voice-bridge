-- Phase 3: transcript workspace
--
-- The transcript is now stored as structured segments (timestamps, Whisper's
-- confidence measures, speaker, the corrected text AND the original machine
-- text) instead of one long string, so the workspace can seek the audio, flag
-- uncertain parts, edit in place, label speakers, and measure how much a
-- human had to correct.
--
-- transcriptions.somali_text stays the single "current text" every other
-- feature reads (translation, summary, training export); a trigger keeps it in
-- sync with the segments, so edits flow through everywhere.
--
-- Additive and idempotent. Older transcripts are converted in section 6.

-- ---------------------------------------------------------------------------
-- 1. Segments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transcript_segments (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  transcription_id  UUID          NOT NULL REFERENCES public.transcriptions(id) ON DELETE CASCADE,
  upload_id         UUID          NOT NULL REFERENCES public.audio_uploads(id) ON DELETE CASCADE,
  user_id           UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  idx               INTEGER       NOT NULL CHECK (idx >= 0),
  -- null for older transcripts that were saved as plain text with no timing
  start_seconds     NUMERIC(10,2),
  end_seconds       NUMERIC(10,2),
  text              TEXT          NOT NULL,                 -- current (possibly corrected) text
  original_text     TEXT          NOT NULL,                 -- what the model produced; never changed
  avg_logprob       REAL,
  no_speech_prob    REAL,
  compression_ratio REAL,
  speaker           TEXT,
  edited_at         TIMESTAMPTZ,                            -- set when the text was changed by a person
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (transcription_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_transcript_segments_upload ON public.transcript_segments(upload_id);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_user ON public.transcript_segments(user_id);

ALTER TABLE public.transcript_segments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own segments" ON public.transcript_segments;
CREATE POLICY "Users can view own segments" ON public.transcript_segments
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins can view all segments" ON public.transcript_segments;
CREATE POLICY "Admins can view all segments" ON public.transcript_segments
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

-- No direct write policies: segments are created and changed only through the
-- functions below, which can never touch original_text, timing or confidence.

DROP TRIGGER IF EXISTS update_transcript_segments_updated_at ON public.transcript_segments;
CREATE TRIGGER update_transcript_segments_updated_at
  BEFORE UPDATE ON public.transcript_segments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 2. Other additions
-- ---------------------------------------------------------------------------
-- "I have reviewed this transcript": removes the draft label for people who
-- aren't admins (admins can additionally verify for training).
ALTER TABLE public.transcriptions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- Per-user list of corrections to apply again, e.g. a name the model always gets wrong.
CREATE TABLE IF NOT EXISTS public.user_glossary (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  find_text    TEXT        NOT NULL CHECK (length(find_text) BETWEEN 1 AND 200),
  replace_text TEXT        NOT NULL CHECK (length(replace_text) <= 200),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, find_text)
);

ALTER TABLE public.user_glossary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own glossary" ON public.user_glossary;
CREATE POLICY "Users manage own glossary" ON public.user_glossary
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. Keep transcriptions.somali_text in step with the segments
-- ---------------------------------------------------------------------------
-- Everything that reads the transcript text (translation, summary, the
-- training export) keeps working, and always sees the corrected text.
CREATE OR REPLACE FUNCTION public.sync_transcript_text()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM new_rows n JOIN old_rows o ON o.id = n.id WHERE n.text IS DISTINCT FROM o.text
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE transcriptions t
     SET somali_text = s.joined, updated_at = now()
    FROM (
      SELECT seg.transcription_id,
             COALESCE(string_agg(seg.text, ' ' ORDER BY seg.idx) FILTER (WHERE seg.text <> ''), '') AS joined
        FROM transcript_segments seg
       WHERE seg.transcription_id IN (SELECT DISTINCT transcription_id FROM new_rows)
       GROUP BY seg.transcription_id
    ) s
   WHERE t.id = s.transcription_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sync_transcript_text ON public.transcript_segments;
CREATE TRIGGER sync_transcript_text
  AFTER UPDATE ON public.transcript_segments
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.sync_transcript_text();

-- ---------------------------------------------------------------------------
-- 4. Creating segments (also used for older transcripts)
-- ---------------------------------------------------------------------------
-- Builds the segments for a transcript from what it already has, if it has
-- none yet. Uses the saved timestamps when there are any; older transcripts
-- that were stored as plain text become untimed, sentence-sized segments.
-- Safe to call repeatedly. Callable by the owner, or by the server.
CREATE OR REPLACE FUNCTION public.ensure_segments(p_transcription UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t RECORD;
  v_count INTEGER;
BEGIN
  SELECT id, upload_id, user_id, somali_text, speaker_timestamps
    INTO v_t FROM transcriptions WHERE id = p_transcription;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transcript not found' USING ERRCODE = 'P0002';
  END IF;
  IF auth.uid() IS NOT NULL AND v_t.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Transcript not found' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_count FROM transcript_segments WHERE transcription_id = p_transcription;
  IF v_count > 0 THEN
    RETURN v_count;
  END IF;

  IF jsonb_typeof(v_t.speaker_timestamps) = 'array' AND jsonb_array_length(v_t.speaker_timestamps) > 0 THEN
    INSERT INTO transcript_segments
      (transcription_id, upload_id, user_id, idx, start_seconds, end_seconds, text, original_text,
       avg_logprob, no_speech_prob, compression_ratio)
    SELECT p_transcription, v_t.upload_id, v_t.user_id,
           (row_number() OVER (ORDER BY e.ord) - 1)::INTEGER,
           CASE WHEN jsonb_typeof(e.elem->'start') = 'number' THEN (e.elem->>'start')::NUMERIC END,
           CASE WHEN jsonb_typeof(e.elem->'end')   = 'number' THEN (e.elem->>'end')::NUMERIC END,
           btrim(e.elem->>'text'), btrim(e.elem->>'text'),
           CASE WHEN jsonb_typeof(e.elem->'avg_logprob')       = 'number' THEN (e.elem->>'avg_logprob')::REAL END,
           CASE WHEN jsonb_typeof(e.elem->'no_speech_prob')    = 'number' THEN (e.elem->>'no_speech_prob')::REAL END,
           CASE WHEN jsonb_typeof(e.elem->'compression_ratio') = 'number' THEN (e.elem->>'compression_ratio')::REAL END
      FROM jsonb_array_elements(v_t.speaker_timestamps) WITH ORDINALITY AS e(elem, ord)
     WHERE btrim(COALESCE(e.elem->>'text', '')) <> '';
  END IF;

  SELECT count(*) INTO v_count FROM transcript_segments WHERE transcription_id = p_transcription;
  IF v_count = 0 AND btrim(COALESCE(v_t.somali_text, '')) <> '' THEN
    INSERT INTO transcript_segments (transcription_id, upload_id, user_id, idx, text, original_text)
    SELECT p_transcription, v_t.upload_id, v_t.user_id,
           (row_number() OVER () - 1)::INTEGER, s.piece, s.piece
      FROM (
        SELECT btrim(piece) AS piece
          FROM regexp_split_to_table(v_t.somali_text, '(?<=[.!?…])\s+') AS piece
         WHERE btrim(piece) <> ''
      ) s;
    SELECT count(*) INTO v_count FROM transcript_segments WHERE transcription_id = p_transcription;
  END IF;

  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Editing (signed-in owner)
-- ---------------------------------------------------------------------------

-- Apply a batch of edits: [{ "id": "...", "text": "...", "speaker": "..." }, ...].
-- Only text and speaker can change. A change to the text records that a person
-- edited it. Returns how many segments actually changed.
CREATE OR REPLACE FUNCTION public.update_segments(p_updates JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_item JSONB;
  v_changed INTEGER := 0;
  v_n INTEGER;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_updates) <> 'array' OR jsonb_array_length(p_updates) > 2000 THEN
    RAISE EXCEPTION 'Invalid updates' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_updates) LOOP
    IF v_item ? 'text' AND length(v_item->>'text') > 5000 THEN
      RAISE EXCEPTION 'A segment can be at most 5000 characters' USING ERRCODE = '22023';
    END IF;

    UPDATE transcript_segments s
       SET text = CASE WHEN v_item ? 'text' THEN btrim(v_item->>'text') ELSE s.text END,
           speaker = CASE WHEN v_item ? 'speaker' THEN NULLIF(btrim(v_item->>'speaker'), '') ELSE s.speaker END,
           edited_at = CASE WHEN v_item ? 'text' AND btrim(v_item->>'text') IS DISTINCT FROM s.text THEN now() ELSE s.edited_at END
     WHERE s.id = (v_item->>'id')::UUID
       AND s.user_id = v_user
       AND ( (v_item ? 'text' AND btrim(v_item->>'text') IS DISTINCT FROM s.text)
          OR (v_item ? 'speaker' AND NULLIF(btrim(v_item->>'speaker'), '') IS DISTINCT FROM s.speaker) );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_changed := v_changed + v_n;
  END LOOP;

  RETURN v_changed;
END;
$$;

-- Rename a speaker everywhere in one transcript. p_from NULL means "segments with
-- no speaker yet". An empty p_to clears the label.
CREATE OR REPLACE FUNCTION public.rename_speaker(p_transcription UUID, p_from TEXT, p_to TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  UPDATE transcript_segments
     SET speaker = NULLIF(btrim(p_to), '')
   WHERE transcription_id = p_transcription
     AND user_id = auth.uid()
     AND speaker IS NOT DISTINCT FROM NULLIF(btrim(p_from), '');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Convert transcripts that already exist
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_id UUID;
BEGIN
  FOR v_id IN SELECT id FROM public.transcriptions LOOP
    PERFORM public.ensure_segments(v_id);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ensure_segments(UUID)               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_segments(JSONB)              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rename_speaker(UUID, TEXT, TEXT)    FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.ensure_segments(UUID)            TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_segments(JSONB)           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rename_speaker(UUID, TEXT, TEXT) TO authenticated, service_role;
