-- Add admin UPDATE policy on profiles (needed for plan changes, usage resets)
CREATE POLICY "Admins can update all profiles" ON public.profiles
  FOR UPDATE USING (public.has_role(auth.uid(), 'admin'));

-- Add admin UPDATE/DELETE policies on audio_uploads
CREATE POLICY "Admins can update all uploads" ON public.audio_uploads
  FOR UPDATE USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete all uploads" ON public.audio_uploads
  FOR DELETE USING (public.has_role(auth.uid(), 'admin'));

-- Add admin UPDATE/DELETE policies on transcriptions
CREATE POLICY "Admins can update all transcriptions" ON public.transcriptions
  FOR UPDATE USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete all transcriptions" ON public.transcriptions
  FOR DELETE USING (public.has_role(auth.uid(), 'admin'));
