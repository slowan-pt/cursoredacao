import { Hono } from 'hono'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { requireAuth, requireRole } from '../middleware'

const app = new Hono<{ Bindings: Env }>()

app.use('*', requireAuth, requireRole('ADMIN', 'SUPERADMIN', 'CORRETOR'))
app.use('*', async (c, next) => {
  const user = c.get('user')
  if (user.role !== 'SUPERADMIN' && user.ativo === false) {
    return c.json({ error: 'Acesso pendente de aprovação.' }, 403)
  }
  await next()
})

const CMS_PREFIX = 'CMS:'

function defaultCms() {
  return {
    layout: {
      eyebrow: 'Site independente do professor',
      hero_title: 'Redação com acompanhamento direto.',
      cta_text: 'Criar acesso de aluno',
      profile_text: 'Este site tem turmas, alunos e correções separados dos demais professores da plataforma.',
      turmas_title: 'Escolha sua turma',
      turmas_subtitle: 'Ao criar acesso por aqui, seu cadastro fica vinculado a este professor.',
      posts_title: 'Dicas e materiais',
      posts_intro: 'Publicações, notícias e matérias do professor.',
      profile_side: 'right',
      block_order: ['hero', 'turmas', 'conteudos', 'aluno'],
      avatar_text: 'PR',
      avatar_image: '',
      hidden_elements: [],
      extra_blocks: [],
      aluno_title: 'Acesse a plataforma',
      aluno_text: 'Entre para acompanhar turmas, envios de redação e correções.',
      aluno_cta: 'Entrar na area do aluno'
    },
    contact: {
      whatsapp_phone: '5521971214042'
    },
    theme: {
      mode: 'auto',
      primary: '#1A3A2A',
      primaryText: '#FFFFFF',
      accent: '#C5F135',
      accentText: '#1A2A00',
      background: '#F8F7F4',
      card: '#FFFFFF',
      border: '#E8E5E0',
      borderStrong: '#D0CCC4',
      text: '#0F0F0F',
      textSoft: '#3A3A3A',
      textMuted: '#787878',
      success: '#2E7D32',
      warning: '#E8A020',
      danger: '#C84040',
      info: '#1565C0'
    },
    posts: [],
    turma_settings: {},
    student_credits: {},
    enrollments: {}
  }
}

function parseCms(site: any) {
  const raw = (site?.allowed_origins || []).find((item: string) => String(item).startsWith(CMS_PREFIX))
  if (!raw) return defaultCms()
  try {
    const cms = JSON.parse(String(raw).slice(CMS_PREFIX.length))
    return {
      ...defaultCms(),
      ...cms,
      layout: { ...defaultCms().layout, ...(cms.layout || {}) },
      contact: { ...defaultCms().contact, ...(cms.contact || {}) },
      theme: { ...defaultCms().theme, ...(cms.theme || {}) },
      posts: Array.isArray(cms.posts) ? cms.posts : [],
      turma_settings: cms.turma_settings && typeof cms.turma_settings === 'object' ? cms.turma_settings : {},
      student_credits: cms.student_credits && typeof cms.student_credits === 'object' ? cms.student_credits : {},
      enrollments: cms.enrollments && typeof cms.enrollments === 'object' ? cms.enrollments : {}
    }
  } catch {
    return defaultCms()
  }
}

function withCmsOrigins(origins: string[] | null | undefined, cms: unknown) {
  const keep = (origins || []).filter((item) => !String(item).startsWith(CMS_PREFIX))
  return [...keep, `${CMS_PREFIX}${JSON.stringify(cms || defaultCms())}`]
}

function missingTurmaAlunos(error: any) {
  return /turma_alunos|relation .* does not exist|schema cache/i.test(String(error?.message || ''))
}

app.get('/stats', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const siteId = user.site_id

  const [aguardando, finalizadas, alunos, alunosLista, alunosPendentes, turmasAbertas, site] = await Promise.all([
    sb.from('correcoes').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).eq('status', 'AGUARDANDO'),
    sb.from('correcoes').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).eq('status', 'FINALIZADA'),
    sb.from('profiles').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).eq('role', 'ALUNO'),
    sb.from('profiles').select('id').eq('site_id', siteId).eq('role', 'ALUNO'),
    sb.from('profiles').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).eq('role', 'ALUNO').eq('ativo', false),
    sb.from('turmas').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).eq('status', 'ABERTA'),
    sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  ])
  const cms = parseCms(site.data)
  const creditosAtivos = (alunosLista.data ?? []).reduce((sum, aluno) => {
    const info = cms.student_credits?.[aluno.id]
    const venceEm = info?.vence_em ? new Date(`${info.vence_em}T23:59:59`) : null
    const vencido = venceEm && Number.isFinite(venceEm.getTime()) && venceEm.getTime() < Date.now()
    return sum + (!vencido ? Math.max(0, Number(info?.creditos) || 0) : 0)
  }, 0)

  return c.json({
    aguardando: aguardando.count ?? 0,
    finalizadas: finalizadas.count ?? 0,
    alunos: alunos.count ?? 0,
    alunos_pendentes: alunosPendentes.count ?? 0,
    turmas_abertas: turmasAbertas.count ?? 0,
    creditos_ativos: creditosAtivos
  })
})

app.get('/site', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  if (!user.site_id) return c.json({ error: 'Professor sem site vinculado' }, 400)

  const { data, error } = await sb.from('sites')
    .select('id, slug, domain_custom, nome_prof, bio_prof, foto_url, cor_primaria, cor_accent, logo_url, ativo, allowed_origins')
    .eq('id', user.site_id)
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ...data, cms: parseCms(data), allowed_origins: undefined })
})

app.patch('/site', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  if (!user.site_id) return c.json({ error: 'Professor sem site vinculado' }, 400)

  const allowed = ['nome_prof', 'bio_prof', 'foto_url', 'cor_primaria', 'cor_accent', 'logo_url']
  const update = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)))
  if ('cms' in body) {
    const { data: current, error: currentErr } = await sb.from('sites')
      .select('allowed_origins')
      .eq('id', user.site_id)
      .single()
    if (currentErr) return c.json({ error: currentErr.message }, 500)
    update.allowed_origins = withCmsOrigins(current?.allowed_origins, body.cms)
  }
  if (!Object.keys(update).length) return c.json({ error: 'Nada para atualizar' }, 400)

  const { data, error } = await sb.from('sites')
    .update(update)
    .eq('id', user.site_id)
    .select('id, slug, domain_custom, nome_prof, bio_prof, foto_url, cor_primaria, cor_accent, logo_url, ativo, allowed_origins')
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ...data, cms: parseCms(data), allowed_origins: undefined })
})

app.get('/correcoes', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const status = c.req.query('status')?.trim().toUpperCase()
  const limit = Math.max(1, Math.min(1000, Number(c.req.query('limit')) || 50))

  let q = sb.from('correcoes')
    .select('id, titulo, status, nota, created_at, aluno_id, turma_id')
    .eq('site_id', user.site_id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status) q = q.eq('status', status)

  const { data, error } = await q
  if (error) return c.json({ error: error.message }, 500)

  const alunoIds = [...new Set((data ?? []).map((c) => c.aluno_id).filter(Boolean))]
  const turmaIds = [...new Set((data ?? []).map((c) => c.turma_id).filter(Boolean))]

  const [{ data: alunos }, { data: turmas }] = await Promise.all([
    alunoIds.length
      ? sb.from('profiles').select('id, nome').in('id', alunoIds)
      : Promise.resolve({ data: [] as Array<{ id: string; nome: string }> }),
    turmaIds.length
      ? sb.from('turmas').select('id, nome').in('id', turmaIds)
      : Promise.resolve({ data: [] as Array<{ id: string; nome: string }> })
  ])

  const alunoMap = new Map((alunos ?? []).map((a) => [a.id, a.nome]))
  const turmaMap = new Map((turmas ?? []).map((t) => [t.id, t.nome]))

  return c.json({
    data: (data ?? []).map((correcao) => ({
      ...correcao,
      aluno_nome: alunoMap.get(correcao.aluno_id) ?? 'Aluno',
      turma_nome: correcao.turma_id ? turmaMap.get(correcao.turma_id) ?? null : null
    }))
  })
})

app.get('/correcoes/:id', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const { data, error } = await sb.from('correcoes')
    .select('*, anotacoes(*)')
    .eq('id', c.req.param('id'))
    .eq('site_id', user.site_id)
    .maybeSingle()
  if (error) return c.json({ error: error.message }, 500)
  if (!data) return c.json({ error: 'Redação não encontrada neste site.' }, 404)

  const [{ data: aluno }, { data: turma }] = await Promise.all([
    sb.from('profiles').select('id, nome').eq('id', data.aluno_id).maybeSingle(),
    data.turma_id
      ? sb.from('turmas').select('id, nome').eq('id', data.turma_id).maybeSingle()
      : Promise.resolve({ data: null as { id: string; nome: string } | null })
  ])

  return c.json({
    ...data,
    aluno_nome: aluno?.nome ?? 'Aluno',
    turma_nome: turma?.nome ?? null
  })
})

app.patch('/correcoes/:id', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)

  if (body.status === 'FINALIZADA') body.finalizada_em = new Date().toISOString()
  body.prof_id = user.sub
  body.updated_at = new Date().toISOString()

  const { data, error } = await sb.from('correcoes')
    .update(body)
    .eq('id', c.req.param('id'))
    .eq('site_id', user.site_id)
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.post('/correcoes/:id/excluir', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)

  const { data, error } = await sb.from('correcoes')
    .update({
      status: 'EXCLUIDA_PELO_PROFESSOR',
      prof_id: user.sub,
      updated_at: new Date().toISOString()
    })
    .eq('id', c.req.param('id'))
    .eq('site_id', user.site_id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.post('/correcoes/:id/anotacoes', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)

  const { data: correcao } = await sb.from('correcoes')
    .select('id')
    .eq('id', c.req.param('id'))
    .eq('site_id', user.site_id)
    .maybeSingle()
  if (!correcao) return c.json({ error: 'Redação não encontrada neste site.' }, 404)

  const payload = { ...body, correcao_id: c.req.param('id') }
  let { data, error } = await sb.from('anotacoes').insert(payload).select().single()
  // Fallback em cascata: trata colunas inexistentes separadamente para não perder dados.
  // 1) Se falhou por tipo_erro_id (coluna ausente ou FK inválido): zera só ele, mantém categoria.
  if (error && /tipo_erro_id/i.test(error.message)) {
    const { tipo_erro_id, pontos, ...rest } = payload
    ;({ data, error } = await sb.from('anotacoes').insert({ ...rest, pontos: 0 }).select().single())
  }
  // 2) Se ainda falhou por categoria ou coluna ausente: remove categoria também.
  if (error && /categoria|column/i.test(error.message)) {
    const { tipo_erro_id, pontos, categoria, ...rest } = payload
    ;({ data, error } = await sb.from('anotacoes').insert(rest).select().single())
  }
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

app.delete('/correcoes/:id/anotacoes/:aid', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const { data: correcao } = await sb.from('correcoes')
    .select('id')
    .eq('id', c.req.param('id'))
    .eq('site_id', user.site_id)
    .maybeSingle()
  if (!correcao) return c.json({ error: 'Redação não encontrada neste site.' }, 404)
  await sb.from('anotacoes').delete().eq('id', c.req.param('aid'))
  return c.json({ ok: true })
})

app.patch('/correcoes/:id/anotacoes/:aid', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const { data: correcao } = await sb.from('correcoes')
    .select('id')
    .eq('id', c.req.param('id'))
    .eq('site_id', user.site_id)
    .maybeSingle()
  if (!correcao) return c.json({ error: 'Redação não encontrada neste site.' }, 404)

  const allowed = ['tipo', 'categoria', 'comentario', 'cor', 'opacidade', 'x_inicio', 'y_inicio', 'x_fim', 'y_fim', 'tipo_erro_id', 'pontos']
  const patch: Record<string, unknown> = {}
  for (const key of allowed) if (key in body) patch[key] = body[key]

  let { data, error } = await sb.from('anotacoes')
    .update(patch)
    .eq('id', c.req.param('aid'))
    .eq('correcao_id', c.req.param('id'))
    .select()
    .single()
  if (error && /tipo_erro_id|pontos|categoria|column/i.test(error.message)) {
    const { tipo_erro_id, pontos, categoria, ...rest } = patch
    ;({ data, error } = await sb.from('anotacoes')
      .update(rest)
      .eq('id', c.req.param('aid'))
      .eq('correcao_id', c.req.param('id'))
      .select()
      .single())
  }
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.get('/alunos', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const [{ data, error }, { data: site }] = await Promise.all([
    sb.from('profiles')
    .select('id, nome, ativo, created_at')
    .eq('site_id', user.site_id).eq('role', 'ALUNO')
    .order('nome'),
    sb.from('sites').select('allowed_origins').eq('id', user.site_id).maybeSingle()
  ])
  if (error) return c.json({ error: error.message }, 500)
  const cms = parseCms(site)
  return c.json({
    data: (data ?? []).map((aluno) => ({
      ...aluno,
      creditos_info: cms.student_credits?.[aluno.id] ?? { creditos: 0, vence_em: null }
    }))
  })
})

app.patch('/alunos/:id', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)

  const update: { ativo?: boolean; nome?: string } = {}
  if (typeof body.ativo === 'boolean') update.ativo = body.ativo
  if (typeof body.nome === 'string' && body.nome.trim()) update.nome = body.nome.trim()
  if (!Object.keys(update).length) return c.json({ error: 'Nada para atualizar' }, 400)

  const { data, error } = await sb.from('profiles')
    .update(update)
    .eq('id', c.req.param('id'))
    .eq('site_id', user.site_id)
    .eq('role', 'ALUNO')
    .select('id, nome, ativo, created_at')
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.patch('/alunos/:id/creditos', async (c) => {
  const user = c.get('user')
  const alunoId = c.req.param('id')
  const body = await c.req.json()
  const sb = getAdmin(c.env)

  const { data: aluno, error: alunoErr } = await sb.from('profiles')
    .select('id')
    .eq('id', alunoId)
    .eq('site_id', user.site_id)
    .eq('role', 'ALUNO')
    .maybeSingle()
  if (alunoErr) return c.json({ error: alunoErr.message }, 500)
  if (!aluno) return c.json({ error: 'Aluno não encontrado neste site.' }, 404)

  const { data: site, error: siteErr } = await sb.from('sites')
    .select('allowed_origins')
    .eq('id', user.site_id)
    .single()
  if (siteErr) return c.json({ error: siteErr.message }, 500)

  const cms = parseCms(site)
  const creditos = Math.max(0, Math.floor(Number(body.creditos) || 0))
  const venceEm = typeof body.vence_em === 'string' && body.vence_em.trim() ? body.vence_em.slice(0, 10) : null
  cms.student_credits = {
    ...(cms.student_credits || {}),
    [alunoId]: {
      creditos,
      vence_em: venceEm,
      updated_at: new Date().toISOString()
    }
  }

  const { error } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) })
    .eq('id', user.site_id)
  if (error) return c.json({ error: error.message }, 500)

  return c.json({ id: alunoId, creditos_info: cms.student_credits[alunoId] })
})

app.get('/turmas', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const [{ data, error }, { data: site }] = await Promise.all([
    sb.from('turmas')
    .select('*').eq('site_id', user.site_id).order('created_at', { ascending: false })
    ,
    sb.from('sites').select('allowed_origins').eq('id', user.site_id).maybeSingle()
  ])
  if (error) return c.json({ error: error.message }, 500)
  const cms = parseCms(site)

  const { data: matriculas, error: matErr } = await sb.from('turma_alunos')
    .select('turma_id, ativo')
    .eq('site_id', user.site_id)

  if (missingTurmaAlunos(matErr)) {
    const counts = new Map<string, { ativos: number; inativos: number; total: number }>()
    Object.entries(cms.enrollments || {}).forEach(([turmaId, alunosById]: [string, any]) => {
      Object.values(alunosById || {}).forEach((m: any) => {
        const current = counts.get(turmaId) ?? { ativos: 0, inativos: 0, total: 0 }
        current.total += 1
        if (m.ativo !== false) current.ativos += 1
        else current.inativos += 1
        counts.set(turmaId, current)
      })
    })
    return c.json({
      data: (data ?? []).map((t) => ({
        ...t,
        alunos_ativos: counts.get(t.id)?.ativos ?? 0,
        alunos_inativos: counts.get(t.id)?.inativos ?? 0,
        alunos_total: counts.get(t.id)?.total ?? 0,
        settings: {
          matriculas_abertas: cms.turma_settings?.[t.id]?.matriculas_abertas !== false,
          envios_abertos: cms.turma_settings?.[t.id]?.envios_abertos !== false,
          imagem_url: cms.turma_settings?.[t.id]?.imagem_url || '',
          beneficios: cms.turma_settings?.[t.id]?.beneficios || '',
          roteiro: cms.turma_settings?.[t.id]?.roteiro || '',
          destaque: cms.turma_settings?.[t.id]?.destaque || ''
        }
      }))
    })
  }
  if (matErr) return c.json({ error: matErr.message }, 500)

  const counts = new Map<string, { ativos: number; inativos: number; total: number }>()
  ;(matriculas ?? []).forEach((m) => {
    const current = counts.get(m.turma_id) ?? { ativos: 0, inativos: 0, total: 0 }
    current.total += 1
    if (m.ativo) current.ativos += 1
    else current.inativos += 1
    counts.set(m.turma_id, current)
  })

  return c.json({
    data: (data ?? []).map((t) => ({
      ...t,
      alunos_ativos: counts.get(t.id)?.ativos ?? 0,
      alunos_inativos: counts.get(t.id)?.inativos ?? 0,
      alunos_total: counts.get(t.id)?.total ?? 0,
      settings: {
        matriculas_abertas: cms.turma_settings?.[t.id]?.matriculas_abertas !== false,
        envios_abertos: cms.turma_settings?.[t.id]?.envios_abertos !== false,
        imagem_url: cms.turma_settings?.[t.id]?.imagem_url || '',
        beneficios: cms.turma_settings?.[t.id]?.beneficios || '',
        roteiro: cms.turma_settings?.[t.id]?.roteiro || '',
        destaque: cms.turma_settings?.[t.id]?.destaque || ''
      }
    }))
  })
})

app.patch('/turmas/:id/settings', async (c) => {
  const user = c.get('user')
  const turmaId = c.req.param('id')
  const body = await c.req.json()
  const sb = getAdmin(c.env)

  const [{ data: turma }, { data: site }] = await Promise.all([
    sb.from('turmas').select('id').eq('id', turmaId).eq('site_id', user.site_id).maybeSingle(),
    sb.from('sites').select('allowed_origins').eq('id', user.site_id).maybeSingle()
  ])
  if (!turma) return c.json({ error: 'Turma não encontrada neste site.' }, 404)

  const cms = parseCms(site)
  const current = cms.turma_settings?.[turmaId] || {}
  cms.turma_settings = {
    ...(cms.turma_settings || {}),
    [turmaId]: {
      ...current,
      matriculas_abertas: typeof body.matriculas_abertas === 'boolean' ? body.matriculas_abertas : current.matriculas_abertas !== false,
      envios_abertos: typeof body.envios_abertos === 'boolean' ? body.envios_abertos : current.envios_abertos !== false,
      imagem_url: typeof body.imagem_url === 'string' ? body.imagem_url.trim() : current.imagem_url || '',
      beneficios: typeof body.beneficios === 'string' ? body.beneficios.trim() : current.beneficios || '',
      roteiro: typeof body.roteiro === 'string' ? body.roteiro.trim() : current.roteiro || '',
      destaque: typeof body.destaque === 'string' ? body.destaque.trim() : current.destaque || '',
      updated_at: new Date().toISOString()
    }
  }

  const { data, error } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site?.allowed_origins || [], cms) })
    .eq('id', user.site_id)
    .select('allowed_origins')
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ settings: parseCms(data).turma_settings?.[turmaId] })
})

app.get('/turmas/:id/alunos', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const turmaId = c.req.param('id')

  const { data: turma } = await sb.from('turmas')
    .select('id')
    .eq('id', turmaId)
    .eq('site_id', user.site_id)
    .maybeSingle()
  if (!turma) return c.json({ error: 'Turma não encontrada neste site.' }, 404)

  const { data: alunos } = await sb.from('profiles')
    .select('id, nome, ativo')
    .eq('site_id', user.site_id)
    .eq('role', 'ALUNO')
    .order('nome')

  const { data: matriculas, error } = await sb.from('turma_alunos')
    .select('id, aluno_id, ativo, origem, created_at')
    .eq('turma_id', turmaId)
    .eq('site_id', user.site_id)
    .order('created_at', { ascending: false })

  if (missingTurmaAlunos(error)) {
    const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', user.site_id).maybeSingle()
    const cms = parseCms(site)
    const alunoMap = new Map((alunos ?? []).map((a) => [a.id, a]))
    const fallback = Object.entries(cms.enrollments?.[turmaId] || {}).map(([aluno_id, info]: [string, any]) => ({
      id: `${turmaId}:${aluno_id}`,
      aluno_id,
      ativo: info.ativo !== false,
      origem: info.origem || 'PROFESSOR',
      created_at: info.created_at || new Date().toISOString(),
      aluno: alunoMap.get(aluno_id) ?? null
    }))
    return c.json({
      data: fallback,
      alunos: alunos ?? [],
      storage: 'cms'
    })
  }
  if (error) return c.json({ error: error.message }, 500)

  const alunoMap = new Map((alunos ?? []).map((a) => [a.id, a]))
  return c.json({
    data: (matriculas ?? []).map((m) => ({
      ...m,
      aluno: alunoMap.get(m.aluno_id) ?? null
    })),
    alunos: alunos ?? []
  })
})

app.post('/turmas/:id/alunos', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const turmaId = c.req.param('id')
  const { aluno_id } = await c.req.json()

  if (!aluno_id) return c.json({ error: 'Aluno obrigatório' }, 400)

  const [{ data: turma }, { data: aluno }] = await Promise.all([
    sb.from('turmas').select('id').eq('id', turmaId).eq('site_id', user.site_id).maybeSingle(),
    sb.from('profiles').select('id').eq('id', aluno_id).eq('site_id', user.site_id).eq('role', 'ALUNO').maybeSingle()
  ])
  if (!turma) return c.json({ error: 'Turma não encontrada neste site.' }, 404)
  if (!aluno) return c.json({ error: 'Aluno não encontrado neste site.' }, 404)

  const { data, error } = await sb.from('turma_alunos')
    .upsert({ site_id: user.site_id, turma_id: turmaId, aluno_id, ativo: true, origem: 'PROFESSOR' }, { onConflict: 'turma_id,aluno_id' })
    .select()
    .single()

  if (missingTurmaAlunos(error)) {
    const { data: site, error: siteErr } = await sb.from('sites').select('allowed_origins').eq('id', user.site_id).single()
    if (siteErr) return c.json({ error: siteErr.message }, 500)
    const cms = parseCms(site)
    cms.enrollments = cms.enrollments || {}
    cms.enrollments[turmaId] = {
      ...(cms.enrollments[turmaId] || {}),
      [aluno_id]: {
        ativo: true,
        origem: 'PROFESSOR',
        created_at: cms.enrollments[turmaId]?.[aluno_id]?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    }
    const { error: saveErr } = await sb.from('sites').update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) }).eq('id', user.site_id)
    if (saveErr) return c.json({ error: saveErr.message }, 500)
    return c.json({ site_id: user.site_id, turma_id: turmaId, aluno_id, ativo: true, origem: 'PROFESSOR' }, 201)
  }
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

app.patch('/turmas/:id/alunos/:alunoId', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const body = await c.req.json()

  if (typeof body.ativo !== 'boolean') return c.json({ error: 'Status obrigatório' }, 400)

  const { data, error } = await sb.from('turma_alunos')
    .update({ ativo: body.ativo })
    .eq('turma_id', c.req.param('id'))
    .eq('aluno_id', c.req.param('alunoId'))
    .eq('site_id', user.site_id)
    .select()
    .single()

  if (missingTurmaAlunos(error)) {
    const turmaId = c.req.param('id')
    const alunoId = c.req.param('alunoId')
    const { data: site, error: siteErr } = await sb.from('sites').select('allowed_origins').eq('id', user.site_id).single()
    if (siteErr) return c.json({ error: siteErr.message }, 500)
    const cms = parseCms(site)
    const current = cms.enrollments?.[turmaId]?.[alunoId]
    if (!current) return c.json({ error: 'Aluno não está vinculado a esta turma.' }, 404)
    cms.enrollments[turmaId][alunoId] = { ...current, ativo: body.ativo, updated_at: new Date().toISOString() }
    const { error: saveErr } = await sb.from('sites').update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) }).eq('id', user.site_id)
    if (saveErr) return c.json({ error: saveErr.message }, 500)
    return c.json({ turma_id: turmaId, aluno_id: alunoId, ...cms.enrollments[turmaId][alunoId] })
  }
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.delete('/turmas/:id/alunos/:alunoId', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const hardDelete = c.req.query('hard') === '1'
  const result = hardDelete
    ? await sb.from('turma_alunos')
      .delete()
      .eq('turma_id', c.req.param('id'))
      .eq('aluno_id', c.req.param('alunoId'))
      .eq('site_id', user.site_id)
      .select()
      .single()
    : await sb.from('turma_alunos')
      .update({ ativo: false })
      .eq('turma_id', c.req.param('id'))
      .eq('aluno_id', c.req.param('alunoId'))
      .eq('site_id', user.site_id)
      .select()
      .single()
  const { data, error } = result

  if (missingTurmaAlunos(error)) {
    const turmaId = c.req.param('id')
    const alunoId = c.req.param('alunoId')
    const { data: site, error: siteErr } = await sb.from('sites').select('allowed_origins').eq('id', user.site_id).single()
    if (siteErr) return c.json({ error: siteErr.message }, 500)
    const cms = parseCms(site)
    const current = cms.enrollments?.[turmaId]?.[alunoId]
    if (!current) return c.json({ error: 'Aluno não está vinculado a esta turma.' }, 404)
    if (hardDelete) delete cms.enrollments[turmaId][alunoId]
    else cms.enrollments[turmaId][alunoId] = { ...current, ativo: false, updated_at: new Date().toISOString() }
    const { error: saveErr } = await sb.from('sites').update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) }).eq('id', user.site_id)
    if (saveErr) return c.json({ error: saveErr.message }, 500)
    return c.json({ turma_id: turmaId, aluno_id: alunoId, ativo: hardDelete ? false : cms.enrollments[turmaId]?.[alunoId]?.ativo })
  }
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.post('/turmas/:id/transferir', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const origemTurmaId = c.req.param('id')
  const body = await c.req.json()
  const destinoTurmaId = String(body.destino_turma_id || '')
  const alunoIds = Array.isArray(body.aluno_ids) ? body.aluno_ids.map(String).filter(Boolean) : []

  if (!destinoTurmaId) return c.json({ error: 'Turma de destino obrigatória.' }, 400)
  if (!alunoIds.length) return c.json({ error: 'Selecione ao menos um aluno.' }, 400)
  if (destinoTurmaId === origemTurmaId) return c.json({ error: 'A turma de destino deve ser diferente da origem.' }, 400)

  const { data: turmas } = await sb.from('turmas')
    .select('id')
    .eq('site_id', user.site_id)
    .in('id', [origemTurmaId, destinoTurmaId])
  if ((turmas ?? []).length !== 2) return c.json({ error: 'Turma de origem ou destino inválida.' }, 404)

  const rows = alunoIds.map((aluno_id: string) => ({
    site_id: user.site_id,
    turma_id: destinoTurmaId,
    aluno_id,
    ativo: true,
    origem: 'TRANSFERENCIA'
  }))

  const { error: upsertErr } = await sb.from('turma_alunos')
    .upsert(rows, { onConflict: 'turma_id,aluno_id' })
  if (missingTurmaAlunos(upsertErr)) {
    const { data: site, error: siteErr } = await sb.from('sites').select('allowed_origins').eq('id', user.site_id).single()
    if (siteErr) return c.json({ error: siteErr.message }, 500)
    const cms = parseCms(site)
    cms.enrollments = cms.enrollments || {}
    cms.enrollments[destinoTurmaId] = cms.enrollments[destinoTurmaId] || {}
    cms.enrollments[origemTurmaId] = cms.enrollments[origemTurmaId] || {}
    alunoIds.forEach((aluno_id: string) => {
      cms.enrollments[destinoTurmaId][aluno_id] = {
        ...(cms.enrollments[destinoTurmaId][aluno_id] || {}),
        ativo: true,
        origem: 'TRANSFERENCIA',
        created_at: cms.enrollments[destinoTurmaId][aluno_id]?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      if (cms.enrollments[origemTurmaId][aluno_id]) {
        cms.enrollments[origemTurmaId][aluno_id] = {
          ...cms.enrollments[origemTurmaId][aluno_id],
          ativo: false,
          updated_at: new Date().toISOString()
        }
      }
    })
    const { error: saveErr } = await sb.from('sites').update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) }).eq('id', user.site_id)
    if (saveErr) return c.json({ error: saveErr.message }, 500)
    return c.json({ ok: true, transferidos: alunoIds.length, storage: 'cms' })
  }
  if (upsertErr) return c.json({ error: upsertErr.message }, 500)

  const { error: originErr } = await sb.from('turma_alunos')
    .update({ ativo: false })
    .eq('site_id', user.site_id)
    .eq('turma_id', origemTurmaId)
    .in('aluno_id', alunoIds)
  if (originErr) return c.json({ error: originErr.message }, 500)

  return c.json({ ok: true, transferidos: alunoIds.length })
})

app.post('/turmas', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const { data, error } = await sb.from('turmas')
    .insert({ ...body, site_id: user.site_id }).select().single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

app.patch('/turmas/:id', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)

  const allowed = ['nome', 'concurso', 'descricao', 'status', 'preco']
  const update = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)))
  if (!Object.keys(update).length) return c.json({ error: 'Nada para atualizar' }, 400)

  const { data, error } = await sb.from('turmas')
    .update(update)
    .eq('id', c.req.param('id'))
    .eq('site_id', user.site_id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// ── CORRETOR AUTOMÁTICO: tipos de erro ───────────────────────
// Catálogo do site (reutilizável entre todas as turmas)
app.get('/tipos-erro', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const { data, error } = await sb.from('tipos_erro')
    .select('*').eq('site_id', user.site_id).order('created_at', { ascending: true })
  if (error?.message?.match(/tipos_erro|relation|does not exist/i)) {
    return c.json({ data: [], warning: 'Rode a migração 003 no Supabase para ativar o corretor automático.' })
  }
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

app.post('/tipos-erro', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const nome = String(body.nome || '').trim()
  if (!nome) return c.json({ error: 'Nome obrigatório' }, 400)
  const insert = {
    site_id: user.site_id,
    nome,
    pontos: Math.abs(Number(body.pontos) || 0),
    cor: typeof body.cor === 'string' ? body.cor : '#EF4444'
  }
  const { data, error } = await sb.from('tipos_erro').insert(insert).select().single()
  if (error?.message?.match(/tipos_erro|relation|does not exist/i)) {
    return c.json({ error: 'Rode a migração 003 no Supabase para ativar o corretor automático.' }, 501)
  }
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

app.patch('/tipos-erro/:id', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const patch: Record<string, unknown> = {}
  if (typeof body.nome === 'string' && body.nome.trim()) patch.nome = body.nome.trim()
  if (body.pontos != null) patch.pontos = Math.abs(Number(body.pontos) || 0)
  if (typeof body.cor === 'string') patch.cor = body.cor
  if (!Object.keys(patch).length) return c.json({ error: 'Nada para atualizar' }, 400)
  const { data, error } = await sb.from('tipos_erro').update(patch)
    .eq('id', c.req.param('id')).eq('site_id', user.site_id).select().single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.delete('/tipos-erro/:id', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const { error } = await sb.from('tipos_erro').delete()
    .eq('id', c.req.param('id')).eq('site_id', user.site_id)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

// Tipos de erro de uma turma (catálogo com ativação + pontos por turma)
app.get('/turmas/:id/tipos-erro', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const turmaId = c.req.param('id')
  const { data: catalogo, error: catErr } = await sb.from('tipos_erro')
    .select('*').eq('site_id', user.site_id).order('created_at', { ascending: true })
  if (catErr?.message?.match(/tipos_erro|relation|does not exist/i)) {
    return c.json({ data: [], ativos: [] })
  }
  if (catErr) return c.json({ error: catErr.message }, 500)

  const { data: assoc } = await sb.from('turma_tipos_erro')
    .select('*').eq('turma_id', turmaId).eq('site_id', user.site_id)
  const assocMap = new Map((assoc ?? []).map((a) => [a.tipo_erro_id, a]))
  const itens = (catalogo ?? []).map((t) => {
    const a = assocMap.get(t.id)
    return {
      ...t,
      ativo: a ? !!a.ativo : false,
      pontos_turma: a && a.pontos != null ? a.pontos : t.pontos
    }
  })
  const ativos = itens
    .filter((i) => i.ativo)
    .map((i) => ({ id: i.id, nome: i.nome, pontos: i.pontos_turma, cor: i.cor }))
  return c.json({ data: itens, ativos })
})

// Define quais tipos estão ativos na turma + pontos por turma
app.put('/turmas/:id/tipos-erro', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const turmaId = c.req.param('id')
  const body = await c.req.json()
  const itens = Array.isArray(body.itens) ? body.itens : []
  const rows = itens
    .filter((i: any) => i && i.tipo_erro_id)
    .map((i: any) => ({
      site_id: user.site_id,
      turma_id: turmaId,
      tipo_erro_id: i.tipo_erro_id,
      ativo: !!i.ativo,
      pontos: i.pontos == null || i.pontos === '' ? null : Math.abs(Number(i.pontos) || 0)
    }))
  if (!rows.length) return c.json({ ok: true })
  const { error } = await sb.from('turma_tipos_erro')
    .upsert(rows, { onConflict: 'turma_id,tipo_erro_id' })
  if (error?.message?.match(/turma_tipos_erro|relation|does not exist/i)) {
    return c.json({ error: 'Rode a migração 003 no Supabase.' }, 501)
  }
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})

export { app as adminRoutes }
