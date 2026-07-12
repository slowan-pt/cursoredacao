-- ============================================================
-- Redação com Estratégia — Metadados de arquivos privados
-- Migration não destrutiva. Revisar antes de executar no Supabase.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.storage_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  turma_id UUID REFERENCES public.turmas(id) ON DELETE SET NULL,
  aluno_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  correcao_id UUID REFERENCES public.correcoes(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  storage_provider TEXT NOT NULL DEFAULT 'R2',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_storage_files_site ON public.storage_files(site_id);
CREATE INDEX IF NOT EXISTS idx_storage_files_aluno ON public.storage_files(aluno_id);
CREATE INDEX IF NOT EXISTS idx_storage_files_correcao ON public.storage_files(correcao_id);

ALTER TABLE public.storage_files ENABLE ROW LEVEL SECURITY;
