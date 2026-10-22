-- The uploader offers "maxaatiri" (Maxaa-tiri) as a dialect, but the original
-- enum never included it, so every upload using it failed with
-- "invalid input value for enum somali_dialect". Legacy values are kept so
-- existing rows stay valid.
ALTER TYPE public.somali_dialect ADD VALUE IF NOT EXISTS 'maxaatiri';
