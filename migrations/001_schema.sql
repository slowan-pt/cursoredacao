-- ============================================================
-- CursosRedação — Schema Supabase
-- Execute no SQL Editor: https://supabase.com/dashboard/project/qizhulhyodpxoowxmqct/sql/new
-- ============================================================

-- Tipo de papel do usuário
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('SUPERADMIN', 'ADMIN', 'CORRETOR', 'ALUNO');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── SITES (multi-tenant) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  domain_custom TEXT UNIQUE,
  nome_prof TEXT NOT NULL DEFAULT '',
  bio_prof TEXT,
  foto_url TEXT,
  cor_primaria TEXT DEFAULT '#1A3A2A',
  cor_accent TEXT DEFAULT '#C5F135',
  logo_url TEXT,
  ativo BOOLEAN DEFAULT true,
  allowed_origins TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── PROFILES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  site_id UUID REFERENCES public.sites(id) ON DELETE SET NULL,
  nome TEXT NOT NULL DEFAULT '',
  role user_role DEFAULT 'ALUNO',
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── TURMAS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.turmas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  concurso TEXT NOT NULL DEFAULT '',
  descricao TEXT,
  status TEXT DEFAULT 'ABERTA',
  preco FLOAT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── CORREÇÕES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.correcoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  turma_id UUID REFERENCES public.turmas(id) ON DELETE SET NULL,
  aluno_id UUID NOT NULL REFERENCES auth.users(id),
  prof_id UUID REFERENCES auth.users(id),
  titulo TEXT NOT NULL,
  arquivo_url TEXT DEFAULT '',
  tipo_arq TEXT DEFAULT 'PDF',
  status TEXT DEFAULT 'AGUARDANDO',
  nota FLOAT,
  nota_max FLOAT DEFAULT 10,
  texto_ocr TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  finalizada_em TIMESTAMPTZ
);

-- ── ANOTAÇÕES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.anotacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  correcao_id UUID NOT NULL REFERENCES public.correcoes(id) ON DELETE CASCADE,
  pagina INT DEFAULT 1,
  x_inicio FLOAT NOT NULL DEFAULT 0,
  y_inicio FLOAT NOT NULL DEFAULT 0,
  x_fim FLOAT NOT NULL DEFAULT 0,
  y_fim FLOAT NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL DEFAULT 'HIGHLIGHT',
  cor TEXT DEFAULT '#EF4444',
  opacidade FLOAT DEFAULT 0.7,
  categoria TEXT NOT NULL DEFAULT 'ORTOGRAFIA',
  numero INT NOT NULL DEFAULT 1,
  comentario TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turmas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.correcoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anotacoes ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (nosso Worker usa service_role → acesso total)

-- ── TRIGGER: criar profile automático no signup ───────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, nome, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'nome', split_part(NEW.email, '@', 1)),
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'ALUNO')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
