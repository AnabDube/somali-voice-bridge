-- Phase 2: AI research assistant layer powered by Claude
-- Adds columns to store cleaned transcripts, research-grade translations,
-- structured summaries, speaker segmentation, terminology glossaries, and
-- per-transcript pipeline stage so the UI can show progress.

ALTER TABLE public.transcriptions
  ADD COLUMN IF NOT EXISTS somali_text_cleaned TEXT,
  ADD COLUMN IF NOT EXISTS english_text_research TEXT,
  ADD COLUMN IF NOT EXISTS research_summary JSONB,
  ADD COLUMN IF NOT EXISTS speaker_segments JSONB,
  ADD COLUMN IF NOT EXISTS terminology JSONB,
  ADD COLUMN IF NOT EXISTS processing_stage TEXT;
