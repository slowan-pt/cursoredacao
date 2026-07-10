-- ============================================================
-- CursosRedação — Corretor automático (tipos de erro)
-- Execute no SQL Editor do Supabase:
-- https://supabase.com/dashboard/project/qizhulhyodpxoowxmqct/sql/new
-- ============================================================

-- Catálogo de tipos de erro (por site, reutilizável entre todas as turmas)
CREATE TABLE IF NOT EXISTS public.tipos_erro (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  pontos FLOAT NOT NULL DEFAULT 0,   -- magnitude de pontos a descontar (ex: 0.5)
  cor TEXT DEFAULT '#EF4444',
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.tipos_erro ENABLE ROW LEVEL SECURITY;

-- Associação turma ↔ tipo de erro (ativa o tipo numa turma e permite sobrescrever os pontos)
CREATE TABLE IF NOT EXISTS public.turma_tipos_erro (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  turma_id UUID NOT NULL REFERENCES public.turmas(id) ON DELETE CASCADE,
  tipo_erro_id UUID NOT NULL REFERENCES public.tipos_erro(id) ON DELETE CASCADE,
  pontos FLOAT,                       -- override; se NULL usa tipos_erro.pontos
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(turma_id, tipo_erro_id)
);
ALTER TABLE public.turma_tipos_erro ENABLE ROW LEVEL SECURITY;

-- Anotações: vincular tipo de erro + pontos efetivamente aplicados naquela marcação
ALTER TABLE public.anotacoes
  ADD COLUMN IF NOT EXISTS tipo_erro_id UUID REFERENCES public.tipos_erro(id) ON DELETE SET NULL;
ALTER TABLE public.anotacoes
  ADD COLUMN IF NOT EXISTS pontos FLOAT DEFAULT 0;
