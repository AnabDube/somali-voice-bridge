
-- Timestamp update function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Roles enum and table
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE POLICY "Users can view own roles" ON public.user_roles
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage roles" ON public.user_roles
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Subscription plan enum
CREATE TYPE public.subscription_plan AS ENUM ('free', 'starter', 'professional', 'business');

-- Profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT,
  organization TEXT,
  subscription_plan subscription_plan NOT NULL DEFAULT 'free',
  minutes_used NUMERIC(10,2) NOT NULL DEFAULT 0,
  minutes_limit NUMERIC(10,2) NOT NULL DEFAULT 30,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can view all profiles" ON public.profiles
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Dialect enum
CREATE TYPE public.somali_dialect AS ENUM ('standard', 'af_maay', 'northern', 'benaadir', 'other');

-- Audio uploads table
CREATE TABLE public.audio_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size_bytes BIGINT,
  duration_seconds NUMERIC(10,2),
  dialect somali_dialect DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  approved_for_training BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.audio_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own uploads" ON public.audio_uploads
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create uploads" ON public.audio_uploads
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own uploads" ON public.audio_uploads
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own uploads" ON public.audio_uploads
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all uploads" ON public.audio_uploads
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_audio_uploads_updated_at
  BEFORE UPDATE ON public.audio_uploads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Transcriptions table
CREATE TABLE public.transcriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID REFERENCES public.audio_uploads(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  somali_text TEXT,
  english_text TEXT,
  speaker_timestamps JSONB,
  confidence_score NUMERIC(5,4),
  processing_time_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.transcriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own transcriptions" ON public.transcriptions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create transcriptions" ON public.transcriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own transcriptions" ON public.transcriptions
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own transcriptions" ON public.transcriptions
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all transcriptions" ON public.transcriptions
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_transcriptions_updated_at
  BEFORE UPDATE ON public.transcriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Audio storage bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('audio-uploads', 'audio-uploads', false);

CREATE POLICY "Users can upload own audio" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'audio-uploads' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can view own audio" ON storage.objects
  FOR SELECT USING (bucket_id = 'audio-uploads' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete own audio" ON storage.objects
  FOR DELETE USING (bucket_id = 'audio-uploads' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Indexes
CREATE INDEX idx_profiles_user_id ON public.profiles(user_id);
CREATE INDEX idx_audio_uploads_user_id ON public.audio_uploads(user_id);
CREATE INDEX idx_audio_uploads_status ON public.audio_uploads(status);
CREATE INDEX idx_transcriptions_user_id ON public.transcriptions(user_id);
CREATE INDEX idx_transcriptions_upload_id ON public.transcriptions(upload_id);
