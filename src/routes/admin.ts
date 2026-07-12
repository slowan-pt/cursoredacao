import { Hono } from 'hono'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { requireAuth, requireRole } from '../middleware'
import { dataUrlFromBytes } from '../uploads'
import { getPrivateStorage, keyFromStoredObjectRef } from '../storage'

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
const PENDING_CORRECAO_STATUSES = ['AGUARDANDO', 'EM_ANDAMENTO', 'EM_CORRECAO']

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
    child_teachers: [],
    turma_settings: {},
    student_credits: {},
    enrollments: {},
    blocked_students: {},
    deleted_students: {}
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
      child_teachers: Array.isArray(cms.child_teachers) ? cms.child_teachers : [],
      turma_settings: cms.turma_settings && typeof cms.turma_settings === 'object' ? cms.turma_settings : {},
      student_credits: cms.student_credits && typeof cms.student_credits === 'object' ? cms.student_credits : {},
      enrollments: cms.enrollments && typeof cms.enrollments === 'object' ? cms.enrollments : {},
      blocked_students: cms.blocked_students && typeof cms.blocked_students === 'object' ? cms.blocked_students : {},
      deleted_students: cms.deleted_students && typeof cms.deleted_students === 'object' ? cms.deleted_students : {}
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

async function hydrateArquivoUrl(env: Env, correcao: any) {
  const key = keyFromStoredObjectRef(correcao?.arquivo_url)
  if (!key) return correcao
  const object = await getPrivateStorage(env).get(key)
  if (!object) return { ...correcao, arquivo_url: '' }
  return {
    ...correcao,
    arquivo_url: dataUrlFromBytes(object.mime, await object.arrayBuffer()),
    storage_key: key
  }
}

async function resolveSiteId(sb: ReturnType<typeof getAdmin>, user: any) {
  if (user?.site_id) return user.site_id
  if (!user?.sub) return null
  const { data } = await sb.from('profiles').select('site_id').eq('id', user.sub).maybeSingle()
  return data?.site_id || null
}

const CHILD_TEACHER_PERMISSIONS = {
  gerenciar_turmas: false,
  gerenciar_temas: false,
  gerenciar_comentarios: true,
  enviar_redacoes: false,
  selecionar_corretores: false,
  relatorios_alunos: false,
  gerenciar_cursos: false,
  gerenciar_alunos: false,
  gerenciar_atividades: false,
  gerenciar_redacoes: true,
  ver_todas_redacoes: true,
  excluir_redacoes: false,
  relatorios_professores: false
}

function normalizeChildTeachers(cms: any) {
  return Array.isArray(cms?.child_teachers) ? cms.child_teachers : []
}

function findChildTeacher(cms: any, user: any) {
  return normalizeChildTeachers(cms).find((child: any) => child?.user_id === user?.sub && child?.ativo !== false)
}

function childPermissions(child: any) {
  return { ...CHILD_TEACHER_PERMISSIONS, ...(child?.permissions || {}) }
}

function childCan(child: any, permission: keyof typeof CHILD_TEACHER_PERMISSIONS) {
  return Boolean(childPermissions(child)[permission])
}

function correctionAssignedToChild(child: any, correcao: any) {
  const assignment = child?.assignment || {}
  const turmaIds = Array.isArray(assignment.turma_ids) ? assignment.turma_ids : []
  const alunoIds = Array.isArray(assignment.aluno_ids) ? assignment.aluno_ids : []
  return Boolean(
    (correcao?.turma_id && turmaIds.includes(correcao.turma_id)) ||
    (correcao?.aluno_id && alunoIds.includes(correcao.aluno_id))
  )
}

function assignedChildFor(cms: any, correcao: any) {
  return normalizeChildTeachers(cms).find((child: any) => child?.ativo !== false && correctionAssignedToChild(child, correcao)) || null
}

function assignmentMetaFor(child: any, correcao: any) {
  const assignedAt = child?.assignment?.assigned_at || {}
  const keyAluno = correcao?.aluno_id ? `aluno:${correcao.aluno_id}` : ''
  const keyTurma = correcao?.turma_id ? `turma:${correcao.turma_id}` : ''
  const assigned = assignedAt[keyAluno] || assignedAt[keyTurma] || child?.updated_at || child?.created_at || null
  const corrected = correcao?.status === 'FINALIZADA' ? (correcao?.finalizada_em || correcao?.updated_at || null) : null
  const start = assigned ? new Date(assigned).getTime() : NaN
  const end = corrected ? new Date(corrected).getTime() : Date.now()
  const pendingDays = Number.isFinite(start) ? Math.max(0, Math.floor((end - start) / 86400000)) : null
  return { assigned, corrected, pendingDays }
}

function normalizeAssignmentInput(input: any, previous: any = {}) {
  const turmaIds = Array.isArray(input?.turma_ids) ? [...new Set(input.turma_ids.filter(Boolean))] : []
  const alunoIds = Array.isArray(input?.aluno_ids) ? [...new Set(input.aluno_ids.filter(Boolean))] : []
  const now = new Date().toISOString()
  const oldAssigned = previous?.assigned_at || {}
  const assignedAt: Record<string, string> = {}
  turmaIds.forEach((id) => { assignedAt[`turma:${id}`] = oldAssigned[`turma:${id}`] || now })
  alunoIds.forEach((id) => { assignedAt[`aluno:${id}`] = oldAssigned[`aluno:${id}`] || now })
  return { turma_ids: turmaIds, aluno_ids: alunoIds, assigned_at: assignedAt }
}

function correctionAnnotationsLocked(correcao: any) {
  return correcao?.status === 'FINALIZADA' || (correcao?.nota !== null && correcao?.nota !== undefined)
}

function annotationEditBlockedForUser(cms: any, user: any, correcao: any) {
  const child = findChildTeacher(cms, user)
  const assigned = assignedChildFor(cms, correcao)
  return Boolean(assigned && !child)
}

function annotateCorrecoesForUser(cms: any, user: any, rows: any[]) {
  const child = findChildTeacher(cms, user)
  const filtered = child ? rows.filter((row) => correctionAssignedToChild(child, row)) : rows
  return filtered.map((row) => {
    const assigned = assignedChildFor(cms, row)
    const meta = assigned ? assignmentMetaFor(assigned, row) : null
    return {
      ...row,
      assigned_child_id: assigned?.id || null,
      assigned_child_name: assigned?.nome || null,
      assigned_child_assigned_at: meta?.assigned || null,
      assigned_child_corrected_at: meta?.corrected || null,
      assigned_child_pending_days: meta?.pendingDays ?? null
    }
  })
}

async function getSiteCms(sb: ReturnType<typeof getAdmin>, siteId: string | null) {
  if (!siteId) return defaultCms()
  const { data } = await sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  return parseCms(data)
}

async function requireCorrecaoAccess(
  sb: ReturnType<typeof getAdmin>,
  user: any,
  correcaoId: string,
  permission?: keyof typeof CHILD_TEACHER_PERMISSIONS
) {
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return { error: 'Professor sem site vinculado.', status: 400 as const }
  const { data: correcao, error } = await sb.from('correcoes')
    .select('id, site_id, turma_id, aluno_id, status, nota')
    .eq('id', correcaoId)
    .eq('site_id', siteId)
    .maybeSingle()
  if (error) return { error: error.message, status: 500 as const }
  if (!correcao) return { error: 'Redação não encontrada neste site.', status: 404 as const }
  const cms = await getSiteCms(sb, siteId)
  const child = findChildTeacher(cms, user)
  if (child && !correctionAssignedToChild(child, correcao)) {
    return { error: 'Esta redação não foi direcionada para este corretor.', status: 403 as const }
  }
  if (child && permission && !childCan(child, permission)) {
    return { error: 'Este corretor não tem permissão para esta ação.', status: 403 as const }
  }
  return { siteId, cms, child, correcao }
}

async function requireChildPermission(
  sb: ReturnType<typeof getAdmin>,
  user: any,
  permission: keyof typeof CHILD_TEACHER_PERMISSIONS
) {
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return { error: 'Professor sem site vinculado.', status: 400 as const }
  const cms = await getSiteCms(sb, siteId)
  const child = findChildTeacher(cms, user)
  if (child && !childCan(child, permission)) {
    return { error: 'Este corretor não tem permissão para esta ação.', status: 403 as const }
  }
  return { siteId, cms, child }
}

app.get('/stats', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const siteId = user.site_id
  const cms = await getSiteCms(sb, siteId)
  const child = findChildTeacher(cms, user)

  if (child) {
    const { data: correcoes, error: corrErr } = await sb.from('correcoes')
      .select('id, status, aluno_id, turma_id')
      .eq('site_id', siteId)
      .neq('status', 'EXCLUIDA_PELO_PROFESSOR')
    if (corrErr) return c.json({ error: corrErr.message }, 500)

    const visible = annotateCorrecoesForUser(cms, user, correcoes ?? [])
    const alunoIds = new Set(visible.map((row) => row.aluno_id).filter(Boolean))
    const turmaIds = new Set(visible.map((row) => row.turma_id).filter(Boolean))
    const aguardando = visible.filter((row) => PENDING_CORRECAO_STATUSES.includes(row.status)).length
    const finalizadas = visible.filter((row) => row.status === 'FINALIZADA').length

    return c.json({
      aguardando,
      finalizadas,
      alunos: alunoIds.size,
      alunos_pendentes: 0,
      turmas_abertas: turmaIds.size,
      creditos_ativos: 0,
      child_teacher: true
    })
  }

  const [aguardando, finalizadas, alunosLista, turmasAbertas, site] = await Promise.all([
    sb.from('correcoes').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).in('status', PENDING_CORRECAO_STATUSES),
    sb.from('correcoes').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).eq('status', 'FINALIZADA'),
    sb.from('profiles').select('id, ativo').eq('site_id', siteId).eq('role', 'ALUNO'),
    sb.from('turmas').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).eq('status', 'ABERTA'),
    sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  ])
  const visibleAlunos = (alunosLista.data ?? []).filter((aluno) => !cms.deleted_students?.[aluno.id])
  const creditosAtivos = visibleAlunos.reduce((sum, aluno) => {
    const info = cms.student_credits?.[aluno.id]
    const venceEm = info?.vence_em ? new Date(`${info.vence_em}T23:59:59`) : null
    const vencido = venceEm && Number.isFinite(venceEm.getTime()) && venceEm.getTime() < Date.now()
    return sum + (!vencido ? Math.max(0, Number(info?.creditos) || 0) : 0)
  }, 0)

  return c.json({
    aguardando: aguardando.count ?? 0,
    finalizadas: finalizadas.count ?? 0,
    alunos: visibleAlunos.length,
    alunos_pendentes: visibleAlunos.filter((aluno) => aluno.ativo === false).length,
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
  const cms = parseCms(data)
  const child = findChildTeacher(cms, user)
  return c.json({
    ...data,
    cms,
    current_child_teacher: child ? {
      id: child.id,
      nome: child.nome,
      permissions: childPermissions(child),
      assignment: child.assignment || {}
    } : null,
    allowed_origins: undefined
  })
})

app.patch('/site', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const access = await requireChildPermission(sb, user, 'gerenciar_cursos')
  if ('error' in access) return c.json({ error: access.error }, access.status)
  if (access.child) return c.json({ error: 'Corretores filhos não editam o site público.' }, 403)
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
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado.' }, 400)
  const status = c.req.query('status')?.trim().toUpperCase()
  const limit = Math.max(1, Math.min(1000, Number(c.req.query('limit')) || 50))
  const cms = await getSiteCms(sb, siteId)
  const child = findChildTeacher(cms, user)

  let q = sb.from('correcoes')
    .select('id, titulo, status, nota, created_at, updated_at, finalizada_em, aluno_id, turma_id')
    .eq('site_id', siteId)
    .neq('status', 'EXCLUIDA_PELO_PROFESSOR')
    .order('created_at', { ascending: false })
    .limit(child ? 1000 : limit)

  if (status === 'PENDENTES') q = q.in('status', PENDING_CORRECAO_STATUSES)
  else if (status) q = q.eq('status', status)

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
  const rows = annotateCorrecoesForUser(cms, user, data ?? []).slice(0, limit)

  return c.json({
    data: rows.map((correcao) => ({
      ...correcao,
      aluno_nome: alunoMap.get(correcao.aluno_id) ?? 'Aluno',
      turma_nome: correcao.turma_id ? turmaMap.get(correcao.turma_id) ?? null : null
    }))
  })
})

app.get('/correcoes/:id', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const access = await requireCorrecaoAccess(sb, user, c.req.param('id'))
  if ('error' in access) return c.json({ error: access.error }, access.status)
  const { data, error } = await sb.from('correcoes')
    .select('*, anotacoes(*)')
    .eq('id', c.req.param('id'))
    .eq('site_id', access.siteId)
    .maybeSingle()
  if (error) return c.json({ error: error.message }, 500)
  if (!data) return c.json({ error: 'Redação não encontrada neste site.' }, 404)

  const [{ data: aluno }, { data: turma }] = await Promise.all([
    sb.from('profiles').select('id, nome').eq('id', data.aluno_id).maybeSingle(),
    data.turma_id
      ? sb.from('turmas').select('id, nome').eq('id', data.turma_id).maybeSingle()
      : Promise.resolve({ data: null as { id: string; nome: string } | null })
  ])

  const assigned = assignedChildFor(access.cms, data)
  const meta = assigned ? assignmentMetaFor(assigned, data) : null
  const hydrated = await hydrateArquivoUrl(c.env, data)
  return c.json({
    ...hydrated,
    aluno_nome: aluno?.nome ?? 'Aluno',
    turma_nome: turma?.nome ?? null,
    assigned_child_id: assigned?.id || null,
    assigned_child_name: assigned?.nome || null,
    assigned_child_assigned_at: meta?.assigned || null,
    assigned_child_corrected_at: meta?.corrected || null,
    assigned_child_pending_days: meta?.pendingDays ?? null
  })
})

app.patch('/correcoes/:id', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const access = await requireCorrecaoAccess(sb, user, c.req.param('id'), 'gerenciar_redacoes')
  if ('error' in access) return c.json({ error: access.error }, access.status)

  if (body.status === 'FINALIZADA') body.finalizada_em = new Date().toISOString()
  body.prof_id = user.sub
  body.updated_at = new Date().toISOString()

  const { data, error } = await sb.from('correcoes')
    .update(body)
    .eq('id', c.req.param('id'))
    .eq('site_id', access.siteId)
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.post('/correcoes/:id/excluir', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const access = await requireCorrecaoAccess(sb, user, c.req.param('id'), 'excluir_redacoes')
  if ('error' in access) return c.json({ error: access.error }, access.status)

  const { data, error } = await sb.from('correcoes')
    .update({
      status: 'EXCLUIDA_PELO_PROFESSOR',
      prof_id: user.sub,
      updated_at: new Date().toISOString()
    })
    .eq('id', c.req.param('id'))
    .eq('site_id', access.siteId)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.post('/correcoes/:id/anotacoes', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const access = await requireCorrecaoAccess(sb, user, c.req.param('id'), 'gerenciar_redacoes')
  if ('error' in access) return c.json({ error: access.error }, access.status)
  if (annotationEditBlockedForUser(access.cms, user, access.correcao)) return c.json({ error: 'Esta redação está direcionada para outro corretor.' }, 403)
  if (correctionAnnotationsLocked(access.correcao)) return c.json({ error: 'Reabra a correção antes de editar marcações.' }, 409)

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
  const access = await requireCorrecaoAccess(sb, user, c.req.param('id'), 'gerenciar_redacoes')
  if ('error' in access) return c.json({ error: access.error }, access.status)
  if (annotationEditBlockedForUser(access.cms, user, access.correcao)) return c.json({ error: 'Esta redação está direcionada para outro corretor.' }, 403)
  if (correctionAnnotationsLocked(access.correcao)) return c.json({ error: 'Reabra a correção antes de editar marcações.' }, 409)
  await sb.from('anotacoes').delete().eq('id', c.req.param('aid'))
  return c.json({ ok: true })
})

app.patch('/correcoes/:id/anotacoes/:aid', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const access = await requireCorrecaoAccess(sb, user, c.req.param('id'), 'gerenciar_redacoes')
  if ('error' in access) return c.json({ error: access.error }, access.status)
  if (annotationEditBlockedForUser(access.cms, user, access.correcao)) return c.json({ error: 'Esta redação está direcionada para outro corretor.' }, 403)
  if (correctionAnnotationsLocked(access.correcao)) return c.json({ error: 'Reabra a correção antes de editar marcações.' }, 409)

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

app.get('/professores-filhos', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado.' }, 400)

  const cms = await getSiteCms(sb, siteId)
  if (findChildTeacher(cms, user)) return c.json({ error: 'Corretores filhos não gerenciam outros corretores.' }, 403)

  const [{ data: turmas }, { data: alunos }, { data: matriculas, error: matErr }] = await Promise.all([
    sb.from('turmas').select('id, nome, status').eq('site_id', siteId).order('nome'),
    sb.from('profiles').select('id, nome, ativo').eq('site_id', siteId).eq('role', 'ALUNO').order('nome'),
    sb.from('turma_alunos').select('turma_id, aluno_id, ativo').eq('site_id', siteId).eq('ativo', true)
  ])

  return c.json({
    data: normalizeChildTeachers(cms),
    turmas: turmas || [],
    alunos: alunos || [],
    matriculas: missingTurmaAlunos(matErr) ? [] : (matriculas || [])
  })
})

app.post('/professores-filhos', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado.' }, 400)

  const cms = await getSiteCms(sb, siteId)
  if (findChildTeacher(cms, user)) return c.json({ error: 'Corretores filhos não gerenciam outros corretores.' }, 403)

  const nome = String(body.nome || '').trim()
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || body.senha || '').trim()
  if (!nome || !email || !password) return c.json({ error: 'Nome, email e senha são obrigatórios.' }, 400)
  if (password.length < 6) return c.json({ error: 'A senha precisa ter pelo menos 6 caracteres.' }, 400)

  const { data: authData, error: authErr } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { nome, site_id: siteId, role: 'CORRETOR' }
  })
  if (authErr || !authData.user) return c.json({ error: authErr?.message || 'Não foi possível criar o usuário.' }, 400)

  const { error: profileErr } = await sb.from('profiles').upsert({
    id: authData.user.id,
    nome,
    role: 'CORRETOR',
    site_id: siteId,
    ativo: true
  })
  if (profileErr) return c.json({ error: profileErr.message }, 500)

  const child = {
    id: crypto.randomUUID(),
    user_id: authData.user.id,
    nome,
    email,
    telefone: String(body.telefone || '').trim(),
    ativo: true,
    valor_correcao: Number(body.valor_correcao || 0),
    valor_revisao: Number(body.valor_revisao || 0),
    permissions: { ...CHILD_TEACHER_PERMISSIONS, ...(body.permissions || {}) },
    assignment: normalizeAssignmentInput(body.assignment),
    created_at: new Date().toISOString()
  }
  cms.child_teachers = [child, ...normalizeChildTeachers(cms)]

  const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  const { error: saveErr } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site?.allowed_origins || [], cms) })
    .eq('id', siteId)
  if (saveErr) return c.json({ error: saveErr.message }, 500)

  return c.json(child, 201)
})

app.patch('/professores-filhos/:id', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado.' }, 400)

  const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  const cms = parseCms(site)
  if (findChildTeacher(cms, user)) return c.json({ error: 'Corretores filhos não gerenciam outros corretores.' }, 403)

  const id = c.req.param('id')
  const list = normalizeChildTeachers(cms)
  const index = list.findIndex((child: any) => child.id === id)
  if (index < 0) return c.json({ error: 'Corretor não encontrado.' }, 404)

  const current = list[index]
  const nextAssignment = body.assignment ? normalizeAssignmentInput(body.assignment, current.assignment) : current.assignment
  if (body.assignment) {
    const oldTurmas = new Set(current.assignment?.turma_ids || [])
    const oldAlunos = new Set(current.assignment?.aluno_ids || [])
    const newTurmas = new Set(nextAssignment.turma_ids || [])
    const newAlunos = new Set(nextAssignment.aluno_ids || [])
    const removedTurmas = [...oldTurmas].filter((id) => !newTurmas.has(id))
    const removedAlunos = [...oldAlunos].filter((id) => !newAlunos.has(id))
    if (removedTurmas.length || removedAlunos.length) {
      let lockQuery = sb.from('correcoes')
        .select('id')
        .eq('site_id', siteId)
        .eq('status', 'FINALIZADA')
        .limit(1)
      if (removedTurmas.length && removedAlunos.length) {
        lockQuery = lockQuery.or(`turma_id.in.(${removedTurmas.join(',')}),aluno_id.in.(${removedAlunos.join(',')})`)
      } else if (removedTurmas.length) {
        lockQuery = lockQuery.in('turma_id', removedTurmas)
      } else {
        lockQuery = lockQuery.in('aluno_id', removedAlunos)
      }
      const { data: locked, error: lockErr } = await lockQuery
      if (lockErr) return c.json({ error: lockErr.message }, 500)
      if ((locked || []).length) return c.json({ error: 'Há correções já finalizadas nesse direcionamento. Reabra a correção antes de remover do corretor.' }, 409)
    }
  }
  const updated = {
    ...current,
    nome: typeof body.nome === 'string' && body.nome.trim() ? body.nome.trim() : current.nome,
    telefone: typeof body.telefone === 'string' ? body.telefone.trim() : current.telefone,
    ativo: typeof body.ativo === 'boolean' ? body.ativo : current.ativo,
    valor_correcao: 'valor_correcao' in body ? Number(body.valor_correcao || 0) : current.valor_correcao,
    valor_revisao: 'valor_revisao' in body ? Number(body.valor_revisao || 0) : current.valor_revisao,
    permissions: body.permissions ? { ...CHILD_TEACHER_PERMISSIONS, ...body.permissions } : current.permissions,
    assignment: nextAssignment,
    updated_at: new Date().toISOString()
  }
  list[index] = updated
  cms.child_teachers = list

  if (current.user_id) {
    await sb.from('profiles').update({ nome: updated.nome, ativo: updated.ativo }).eq('id', current.user_id).eq('site_id', siteId)
  }

  const { error: saveErr } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site?.allowed_origins || [], cms) })
    .eq('id', siteId)
  if (saveErr) return c.json({ error: saveErr.message }, 500)
  return c.json(updated)
})

app.delete('/professores-filhos/:id', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado.' }, 400)

  const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  const cms = parseCms(site)
  if (findChildTeacher(cms, user)) return c.json({ error: 'Corretores filhos não gerenciam outros corretores.' }, 403)

  const id = c.req.param('id')
  const list = normalizeChildTeachers(cms)
  const index = list.findIndex((child: any) => child.id === id)
  if (index < 0) return c.json({ error: 'Corretor não encontrado.' }, 404)
  list[index] = { ...list[index], ativo: false, updated_at: new Date().toISOString() }
  cms.child_teachers = list

  if (list[index].user_id) {
    await sb.from('profiles').update({ ativo: false }).eq('id', list[index].user_id).eq('site_id', siteId)
  }

  const { error: saveErr } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site?.allowed_origins || [], cms) })
    .eq('id', siteId)
  if (saveErr) return c.json({ error: saveErr.message }, 500)
  return c.json({ ok: true })
})

app.get('/alunos', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado.' }, 400)
  const [{ data, error }, { data: site }] = await Promise.all([
    sb.from('profiles')
    .select('id, nome, ativo, created_at')
    .eq('site_id', siteId).eq('role', 'ALUNO')
    .order('nome'),
    sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  ])
  if (error) return c.json({ error: error.message }, 500)
  const cms = parseCms(site)
  const child = findChildTeacher(cms, user)
  let visible = data ?? []
  visible = visible.filter((aluno) => !cms.deleted_students?.[aluno.id])
  if (child) {
    const assigned = new Set(Array.isArray(child.assignment?.aluno_ids) ? child.assignment.aluno_ids : [])
    visible = visible.filter((aluno) => assigned.has(aluno.id))
  }
  return c.json({
    data: visible.map((aluno) => ({
      ...aluno,
      creditos_info: cms.student_credits?.[aluno.id] ?? { creditos: 0, vence_em: null }
    }))
  })
})

app.patch('/alunos/:id', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const access = await requireChildPermission(sb, user, 'gerenciar_alunos')
  if ('error' in access) return c.json({ error: access.error }, access.status)

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

  if (typeof body.ativo === 'boolean') {
    const siteId = await resolveSiteId(sb, user)
    if (siteId) {
      const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
      const cms = parseCms(site)
      cms.blocked_students = { ...(cms.blocked_students || {}) }
      if (body.ativo === false) cms.blocked_students[c.req.param('id')] = { blocked_at: new Date().toISOString(), reason: 'INATIVADO_PELO_PROFESSOR' }
      else delete cms.blocked_students[c.req.param('id')]
      await sb.from('sites').update({ allowed_origins: withCmsOrigins(site?.allowed_origins || [], cms) }).eq('id', siteId)
    }
  }
  return c.json(data)
})

app.delete('/alunos/:id', async (c) => {
  const user = c.get('user')
  const alunoId = c.req.param('id')
  const sb = getAdmin(c.env)
  const access = await requireChildPermission(sb, user, 'gerenciar_alunos')
  if ('error' in access) return c.json({ error: access.error }, access.status)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado.' }, 400)

  const { data: aluno, error: alunoErr } = await sb.from('profiles')
    .select('id')
    .eq('id', alunoId)
    .eq('site_id', siteId)
    .eq('role', 'ALUNO')
    .maybeSingle()
  if (alunoErr) return c.json({ error: alunoErr.message }, 500)
  if (!aluno) return c.json({ error: 'Aluno não encontrado neste site.' }, 404)

  await sb.from('profiles').update({ ativo: false }).eq('id', alunoId).eq('site_id', siteId).eq('role', 'ALUNO')
  await sb.from('turma_alunos').update({ ativo: false }).eq('site_id', siteId).eq('aluno_id', alunoId)

  const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  const cms = parseCms(site)
  const now = new Date().toISOString()
  cms.blocked_students = { ...(cms.blocked_students || {}), [alunoId]: { blocked_at: now, reason: 'EXCLUIDO_PELO_PROFESSOR' } }
  cms.deleted_students = { ...(cms.deleted_students || {}), [alunoId]: { deleted_at: now } }
  Object.keys(cms.enrollments || {}).forEach((turmaId) => {
    if (cms.enrollments[turmaId]?.[alunoId]) {
      cms.enrollments[turmaId][alunoId] = { ...cms.enrollments[turmaId][alunoId], ativo: false, updated_at: now }
    }
  })
  const { error: saveErr } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site?.allowed_origins || [], cms) })
    .eq('id', siteId)
  if (saveErr) return c.json({ error: saveErr.message }, 500)
  return c.json({ ok: true })
})

app.patch('/alunos/:id/creditos', async (c) => {
  const user = c.get('user')
  const alunoId = c.req.param('id')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const access = await requireChildPermission(sb, user, 'gerenciar_alunos')
  if ('error' in access) return c.json({ error: access.error }, access.status)

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
          destaque: cms.turma_settings?.[t.id]?.destaque || '',
          titulo_publico: cms.turma_settings?.[t.id]?.titulo_publico || '',
          titulo_entregas: cms.turma_settings?.[t.id]?.titulo_entregas || '',
          titulo_roteiro: cms.turma_settings?.[t.id]?.titulo_roteiro || ''
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
        destaque: cms.turma_settings?.[t.id]?.destaque || '',
        titulo_publico: cms.turma_settings?.[t.id]?.titulo_publico || '',
        titulo_entregas: cms.turma_settings?.[t.id]?.titulo_entregas || '',
        titulo_roteiro: cms.turma_settings?.[t.id]?.titulo_roteiro || ''
      }
    }))
  })
})

app.patch('/turmas/:id/settings', async (c) => {
  const user = c.get('user')
  const turmaId = c.req.param('id')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado. Faça login novamente ou peça ao admin para vincular um site.' }, 400)

  const [{ data: turma }, { data: site }] = await Promise.all([
    sb.from('turmas').select('id').eq('id', turmaId).eq('site_id', siteId).maybeSingle(),
    sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
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
      titulo_publico: typeof body.titulo_publico === 'string' ? body.titulo_publico.trim() : current.titulo_publico || '',
      titulo_entregas: typeof body.titulo_entregas === 'string' ? body.titulo_entregas.trim() : current.titulo_entregas || '',
      titulo_roteiro: typeof body.titulo_roteiro === 'string' ? body.titulo_roteiro.trim() : current.titulo_roteiro || '',
      updated_at: new Date().toISOString()
    }
  }

  const { data, error } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site?.allowed_origins || [], cms) })
    .eq('id', siteId)
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
    const visibleAlunos = (alunos ?? []).filter((a) => !cms.deleted_students?.[a.id])
    const alunoMap = new Map(visibleAlunos.map((a) => [a.id, a]))
    const fallback = Object.entries(cms.enrollments?.[turmaId] || {}).map(([aluno_id, info]: [string, any]) => ({
      id: `${turmaId}:${aluno_id}`,
      aluno_id,
      ativo: info.ativo !== false,
      origem: info.origem || 'PROFESSOR',
      created_at: info.created_at || new Date().toISOString(),
      aluno: alunoMap.get(aluno_id) ?? null
    })).filter((m) => m.aluno)
    return c.json({
      data: fallback,
      alunos: visibleAlunos,
      storage: 'cms'
    })
  }
  if (error) return c.json({ error: error.message }, 500)

  const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', user.site_id).maybeSingle()
  const cms = parseCms(site)
  const visibleAlunos = (alunos ?? []).filter((a) => !cms.deleted_students?.[a.id])
  const alunoMap = new Map(visibleAlunos.map((a) => [a.id, a]))
  return c.json({
    data: (matriculas ?? []).map((m) => ({
      ...m,
      aluno: alunoMap.get(m.aluno_id) ?? null
    })).filter((m) => m.aluno),
    alunos: visibleAlunos
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
  const access = await requireChildPermission(sb, user, 'gerenciar_turmas')
  if ('error' in access) return c.json({ error: access.error }, access.status)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado. Faça login novamente ou peça ao admin para vincular um site.' }, 400)
  const { data, error } = await sb.from('turmas')
    .insert({ ...body, site_id: siteId }).select().single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

app.patch('/turmas/:id', async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const access = await requireChildPermission(sb, user, 'gerenciar_turmas')
  if ('error' in access) return c.json({ error: access.error }, access.status)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado. Faça login novamente ou peça ao admin para vincular um site.' }, 400)

  const allowed = ['nome', 'concurso', 'descricao', 'status', 'preco']
  const update = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)))
  if (!Object.keys(update).length) return c.json({ error: 'Nada para atualizar' }, 400)

  const { data, error } = await sb.from('turmas')
    .update(update)
    .eq('id', c.req.param('id'))
    .eq('site_id', siteId)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.delete('/turmas/:id', async (c) => {
  const user = c.get('user')
  const turmaId = c.req.param('id')
  const sb = getAdmin(c.env)
  const access = await requireChildPermission(sb, user, 'gerenciar_turmas')
  if ('error' in access) return c.json({ error: access.error }, access.status)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado. Faça login novamente ou peça ao admin para vincular um site.' }, 400)

  const { data: turma, error: turmaErr } = await sb.from('turmas')
    .select('id, nome')
    .eq('id', turmaId)
    .eq('site_id', siteId)
    .maybeSingle()
  if (turmaErr) return c.json({ error: turmaErr.message }, 500)
  if (!turma) return c.json({ error: 'Turma não encontrada neste site.' }, 404)

  const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  const cms = parseCms(site)
  const [{ count: alunosCount, error: alunosErr }, { count: correcoesCount, error: corrErr }] = await Promise.all([
    sb.from('turma_alunos').select('id', { count: 'exact', head: true }).eq('site_id', siteId).eq('turma_id', turmaId),
    sb.from('correcoes').select('id', { count: 'exact', head: true }).eq('site_id', siteId).eq('turma_id', turmaId)
  ])

  if (alunosErr && !missingTurmaAlunos(alunosErr)) return c.json({ error: alunosErr.message }, 500)
  if (corrErr) return c.json({ error: corrErr.message }, 500)

  const cmsLinkedAlunos = Object.values(cms.enrollments?.[turmaId] || {})
    .filter((item: any) => item?.ativo !== false).length
  const linkedAlunos = alunosErr && missingTurmaAlunos(alunosErr) ? cmsLinkedAlunos : Number(alunosCount || 0)
  const linkedCorrecoes = Number(correcoesCount || 0)
  if (linkedAlunos > 0) {
    return c.json({
      error: `A turma "${turma.nome}" possui ${linkedAlunos} aluno(s) vinculado(s). Desvincule os alunos no menu "Alunos" da turma antes de excluir.`,
      alunos: linkedAlunos,
      correcoes: linkedCorrecoes
    }, 409)
  }

  if (linkedCorrecoes > 0) {
    const { error: hideCorrecoesErr } = await sb.from('correcoes')
      .update({ status: 'EXCLUIDA_PELO_PROFESSOR', updated_at: new Date().toISOString() })
      .eq('site_id', siteId)
      .eq('turma_id', turmaId)
    if (hideCorrecoesErr) return c.json({ error: hideCorrecoesErr.message }, 500)
  }

  if (cms.turma_settings?.[turmaId]) {
    delete cms.turma_settings[turmaId]
    await sb.from('sites').update({ allowed_origins: withCmsOrigins(site?.allowed_origins || [], cms) }).eq('id', siteId)
  }

  const { error } = await sb.from('turmas').delete().eq('id', turmaId).eq('site_id', siteId)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
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
