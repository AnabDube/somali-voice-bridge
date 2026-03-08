
ALTER TABLE public.transcriptions
  DROP CONSTRAINT IF EXISTS transcriptions_upload_id_fkey;

ALTER TABLE public.transcriptions
  ADD CONSTRAINT transcriptions_upload_id_fkey
    FOREIGN KEY (upload_id) REFERENCES public.audio_uploads(id) ON DELETE CASCADE;
