CREATE TABLE IF NOT EXISTS public.turma_alunos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  turma_id UUID NOT NULL REFERENCES public.turmas(id) ON DELETE CASCADE,
  aluno_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ativo BOOLEAN DEFAULT true,
  origem TEXT DEFAULT 'PROFESSOR',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(turma_id, aluno_id)
);

ALTER TABLE public.turma_alunos ENABLE ROW LEVEL SECURITY;
