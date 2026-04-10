CREATE OR REPLACE FUNCTION public.increment_minutes_used(
  p_user_id UUID,
  p_minutes NUMERIC
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.profiles
  SET minutes_used = minutes_used + p_minutes
  WHERE user_id = p_user_id;
$$;