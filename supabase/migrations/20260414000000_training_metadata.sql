-- Phase 1: Training data collection — metadata columns
-- These columns let us filter verified transcripts into a clean training set
-- and track dialect/speaker diversity across the dataset.

ALTER TABLE public.audio_uploads
  ADD COLUMN IF NOT EXISTS audio_quality TEXT
    CHECK (audio_quality IN ('clean', 'noisy', 'poor')),
  ADD COLUMN IF NOT EXISTS speaker_gender TEXT
    CHECK (speaker_gender IN ('male', 'female', 'other', 'unknown')),
  ADD COLUMN IF NOT EXISTS speaker_age_range TEXT
    CHECK (speaker_age_range IN ('child', 'teen', 'adult', 'senior', 'unknown'));

-- Track who verified the transcript and when (audit trail for training data)
ALTER TABLE public.transcriptions
  ADD COLUMN IF NOT EXISTS verified_for_training BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- Index for fast export queries
CREATE INDEX IF NOT EXISTS idx_transcriptions_verified
  ON public.transcriptions(verified_for_training)
  WHERE verified_for_training = true;
