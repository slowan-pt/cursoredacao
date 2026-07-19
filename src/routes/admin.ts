import { Hono } from 'hono'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { requireAuth, requireRole } from '../middleware'
import { dataUrlFromBytes } from '../uploads'
import { getPrivateStorage, keyFromStoredObjectRef } from '../storage'
import { getConfig } from '../config'

const app = new Hono<{ Bindings: Env }>()

function dbError() {
  return { error: 'Erro ao acessar os dados.' }
}

const FINANCIAL_ENTRY_STATUS = {
  AWAITING_CLOSING: 'AWAITING_CLOSING',
  IN_CLOSING: 'IN_CLOSING',
  APPROVED: 'APPROVED',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  CANCELED: 'CANCELED',
  REVERSED: 'REVERSED',
  PENDING_REVIEW: 'PENDING_REVIEW',
  DISPUTED: 'DISPUTED'
} as const

function financialUnavailable(env: Env) {
  const flags = getConfig(env).flags
  return !flags.financialModule
}

function teacherCompensationUnavailable(env: Env) {
  const flags = getConfig(env).flags
  return !flags.financialModule || !flags.teacherCompensation
}

function moneyToCents(value: unknown) {
  if (typeof value === 'number') return Math.round(value * 100)
  const normalized = String(value || '')
    .trim()
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0
}

function centsToMoney(value: unknown) {
  return Math.round(Number(value || 0)) / 100
}

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
    owner_gender: '',
    layout: {
      header_label: 'Redação',
      eyebrow: 'Site independente do professor',
      hero_title: 'Redação com acompanhamento direto.',
      cta_text: 'Criar acesso de aluno',
      profile_text: 'Este site tem turmas, alunos e correções separados dos demais professores da plataforma.',
      turmas_title: 'Escolha sua turma',
      turmas_subtitle: 'Ao criar acesso por aqui, seu cadastro fica vinculado a este professor.',
      posts_title: 'Dicas e materiais',
      posts_intro: 'Publicações, notícias e matérias do professor.',
      profile_side: 'right',
      block_order: ['hero', 'turmas', 'video_courses', 'conteudos', 'aluno'],
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
    video_courses: [],
    child_teachers: [],
    notifications: [],
    turma_settings: {},
    student_credits: {},
    enrollments: {},
    blocked_students: {},
    deleted_students: {}
  }
}

function normalizeProfessorGender(value: unknown, fallback = 'FEMININO') {
  const normalized = String(value || fallback || '').trim().toUpperCase()
  if (['M', 'MASCULINO', 'HOMEM'].includes(normalized)) return 'MASCULINO'
  if (['F', 'FEMININO', 'MULHER'].includes(normalized)) return 'FEMININO'
  return fallback === 'MASCULINO' ? 'MASCULINO' : 'FEMININO'
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
      video_courses: Array.isArray(cms.video_courses) ? cms.video_courses : [],
      child_teachers: Array.isArray(cms.child_teachers) ? cms.child_teachers : [],
      notifications: Array.isArray(cms.notifications) ? cms.notifications : [],
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

function normalizeTurmaSettings(settings: any = {}) {
  const periodicidade = ['DIA', 'SEMANA', 'CUSTOM_DIAS'].includes(String(settings?.limite_redacoes_periodicidade))
    ? String(settings.limite_redacoes_periodicidade)
    : 'SEMANA'
  const methods = settings?.payment_methods && typeof settings.payment_methods === 'object' ? settings.payment_methods : {}
  const paymentMethods = {
    pix: methods.pix !== false,
    boleto: methods.boleto === true,
    credit_card: methods.credit_card === true
  }
  if (!paymentMethods.pix && !paymentMethods.boleto && !paymentMethods.credit_card) paymentMethods.pix = true
  const feePayer = String(settings?.payment_fee_payer || 'PROFESSOR').toUpperCase() === 'ALUNO' ? 'ALUNO' : 'PROFESSOR'
  return {
    limite_redacoes_por_aluno: Math.max(1, Number(settings?.limite_redacoes_por_aluno) || 3),
    limite_redacoes_por_periodo: Math.max(1, Number(settings?.limite_redacoes_por_periodo ?? settings?.limite_redacoes_por_aluno) || 1),
    limite_redacoes_periodicidade: periodicidade,
    limite_redacoes_periodo_dias: Math.max(1, Number(settings?.limite_redacoes_periodo_dias) || 7),
    payment_methods: paymentMethods,
    credit_card_installments: Math.max(1, Math.min(12, Math.floor(Number(settings?.credit_card_installments) || 1))),
    payment_fee_payer: feePayer,
    payment_fee_percent: Math.max(0, Math.min(30, Number(settings?.payment_fee_percent) || 0))
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

async function deleteStoredCorrectionFile(env: Env, sb: ReturnType<typeof getAdmin>, correcao: any) {
  const key = keyFromStoredObjectRef(correcao?.arquivo_url)
  if (!key) return
  await getPrivateStorage(env).delete(key)
  await sb.from('storage_files')
    .update({ status: 'DELETED', deleted_at: new Date().toISOString() })
    .eq('object_key', key)
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

async function appendFinancialNotification(sb: ReturnType<typeof getAdmin>, siteId: string, notification: any) {
  const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  const cms = parseCms(site)
  const notifications = Array.isArray(cms.notifications) ? cms.notifications : []
  notifications.unshift({
    id: crypto.randomUUID(),
    type: 'FINANCIAL',
    read: false,
    created_at: new Date().toISOString(),
    ...notification
  })
  cms.notifications = notifications.slice(0, 100)
  await sb.from('sites').update({ allowed_origins: withCmsOrigins(site?.allowed_origins || [], cms) }).eq('id', siteId)
}

async function logFinancialAudit(sb: ReturnType<typeof getAdmin>, payload: {
  siteId: string
  actorId?: string | null
  targetTable: string
  targetId?: string | null
  action: string
  previous?: unknown
  next?: unknown
  metadata?: Record<string, unknown>
}) {
  await sb.from('financial_audit_logs').insert({
    site_id: payload.siteId,
    actor_id: payload.actorId || null,
    target_table: payload.targetTable,
    target_id: payload.targetId || null,
    action: payload.action,
    previous_data_json: payload.previous || null,
    new_data_json: payload.next || null,
    metadata: payload.metadata || {}
  })
}

async function resolveParentProfessorId(sb: ReturnType<typeof getAdmin>, siteId: string, childUserId: string | null | undefined) {
  const { data } = await sb.from('profiles')
    .select('id')
    .eq('site_id', siteId)
    .in('role', ['ADMIN', 'CORRETOR'])
    .eq('ativo', true)
    .neq('id', childUserId || '')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return data?.id || null
}

async function resolveCorrectionCompensationRule(sb: ReturnType<typeof getAdmin>, siteId: string, child: any, correcao: any) {
  const today = new Date().toISOString().slice(0, 10)
  const { data: rules, error } = await sb.from('correction_compensation_rules')
    .select('id, site_id, child_professor_id, turma_id, correction_type, amount_cents, valid_from, valid_until, active, priority, notes')
    .eq('site_id', siteId)
    .eq('active', true)
    .lte('valid_from', today)
    .order('priority', { ascending: true })
  if (error) return { error }

  const usable = (rules || []).filter((rule: any) =>
    (!rule.valid_until || rule.valid_until >= today) &&
    (!rule.child_professor_id || rule.child_professor_id === child?.user_id) &&
    (!rule.turma_id || rule.turma_id === correcao?.turma_id)
  )
  const exactChildTurma = usable.find((rule: any) => rule.child_professor_id === child?.user_id && rule.turma_id === correcao?.turma_id)
  const exactChild = usable.find((rule: any) => rule.child_professor_id === child?.user_id && !rule.turma_id)
  const exactTurma = usable.find((rule: any) => !rule.child_professor_id && rule.turma_id === correcao?.turma_id)
  const selected = exactChildTurma || exactChild || exactTurma
  if (selected) {
    return {
      amount_cents: Number(selected.amount_cents || 0),
      rule_id: selected.id,
      rule_source: selected === exactChildTurma ? 'CHILD_TURMA' : selected === exactChild ? 'CHILD' : 'TURMA',
      snapshot: selected
    }
  }

  const legacyCents = moneyToCents(child?.valor_correcao)
  if (legacyCents > 0) {
    return {
      amount_cents: legacyCents,
      rule_id: null,
      rule_source: 'LEGACY_CHILD_CMS',
      snapshot: {
        child_id: child?.id || null,
        child_user_id: child?.user_id || null,
        valor_correcao: child?.valor_correcao || 0
      }
    }
  }

  const { data: settings } = await sb.from('financial_settings')
    .select('id, default_correction_amount_cents, currency')
    .eq('site_id', siteId)
    .maybeSingle()
  const defaultCents = Number(settings?.default_correction_amount_cents || 0)
  if (defaultCents > 0) {
    return {
      amount_cents: defaultCents,
      rule_id: null,
      rule_source: 'SITE_DEFAULT',
      snapshot: settings
    }
  }

  return { missing: true }
}

async function ensureCorrectionCompensationEntry(
  env: Env,
  sb: ReturnType<typeof getAdmin>,
  actor: any,
  siteId: string,
  cms: any,
  correcao: any
) {
  if (teacherCompensationUnavailable(env)) return { skipped: true, reason: 'feature_disabled' }
  if (correcao?.status !== 'FINALIZADA') return { skipped: true, reason: 'not_finalized' }
  const assigned = assignedChildFor(cms, correcao)
  if (!assigned?.user_id) return { skipped: true, reason: 'not_assigned_to_child' }

  const { data: existing } = await sb.from('correction_compensation_entries')
    .select('id, status, amount_cents')
    .eq('correction_id', correcao.id)
    .maybeSingle()
  if (existing) return { entry: existing, idempotent: true }

  const resolved = await resolveCorrectionCompensationRule(sb, siteId, assigned, correcao)
  if ('error' in resolved) return { skipped: true, reason: 'rule_lookup_failed' }
  if ('missing' in resolved) {
    await appendFinancialNotification(sb, siteId, {
      title: 'Configuração financeira pendente',
      message: `A correção "${correcao.titulo || 'Redação'}" foi finalizada por ${assigned.nome || 'corretor'}, mas não há regra de remuneração configurada.`,
      severity: 'warning',
      key: `financial-rule-missing:${correcao.id}`,
      correction_id: correcao.id,
      child_professor_id: assigned.user_id
    })
    await logFinancialAudit(sb, {
      siteId,
      actorId: actor?.sub,
      targetTable: 'correcoes',
      targetId: correcao.id,
      action: 'COMPENSATION_RULE_MISSING',
      metadata: { child_professor_id: assigned.user_id, turma_id: correcao.turma_id || null }
    })
    return { skipped: true, reason: 'rule_missing' }
  }

  const meta = assignmentMetaFor(assigned, correcao)
  const parentId = await resolveParentProfessorId(sb, siteId, assigned.user_id)
  const payload = {
    site_id: siteId,
    correction_id: correcao.id,
    child_professor_id: assigned.user_id,
    parent_professor_id: parentId,
    aluno_id: correcao.aluno_id || null,
    turma_id: correcao.turma_id || null,
    rule_id: resolved.rule_id,
    correction_type: 'CORRECAO',
    status: FINANCIAL_ENTRY_STATUS.AWAITING_CLOSING,
    amount_cents: resolved.amount_cents,
    currency: 'BRL',
    assigned_at: meta.assigned,
    corrected_at: correcao.finalizada_em || correcao.updated_at || new Date().toISOString(),
    rule_snapshot_json: { source: resolved.rule_source, rule: resolved.snapshot },
    metadata: { correction_title: correcao.titulo || null },
    created_by: actor?.sub || null,
    updated_by: actor?.sub || null
  }
  const { data, error } = await sb.from('correction_compensation_entries')
    .insert(payload)
    .select('id, status, amount_cents')
    .single()
  if (error) {
    if (String(error.code) === '23505') {
      const { data: again } = await sb.from('correction_compensation_entries')
        .select('id, status, amount_cents')
        .eq('correction_id', correcao.id)
        .maybeSingle()
      return { entry: again, idempotent: true }
    }
    return { skipped: true, reason: 'entry_insert_failed' }
  }
  await logFinancialAudit(sb, {
    siteId,
    actorId: actor?.sub,
    targetTable: 'correction_compensation_entries',
    targetId: data.id,
    action: 'COMPENSATION_CREATED',
    next: payload,
    metadata: { correction_id: correcao.id }
  })
  await appendFinancialNotification(sb, siteId, {
    title: 'Correção remunerada gerada',
    message: `${assigned.nome || 'Corretor'} finalizou uma correção. Valor gerado: R$ ${centsToMoney(resolved.amount_cents).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`,
    severity: 'info',
    key: `compensation-created:${correcao.id}`,
    correction_id: correcao.id,
    child_professor_id: assigned.user_id,
    amount_cents: resolved.amount_cents
  })
  return { entry: data, created: true }
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
  if (error) return { error: dbError().error, status: 500 as const }
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
    if (corrErr) return c.json(dbError(), 500)

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

  const [aguardando, finalizadas, alunosLista, turmasAbertas] = await Promise.all([
    sb.from('correcoes').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).in('status', PENDING_CORRECAO_STATUSES),
    sb.from('correcoes').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).eq('status', 'FINALIZADA'),
    sb.from('profiles').select('id, ativo').eq('site_id', siteId).eq('role', 'ALUNO'),
    sb.from('turmas').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).eq('status', 'ABERTA')
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

  if (error) return c.json(dbError(), 500)
  const cms = parseCms(data)
  const child = findChildTeacher(cms, user)
  const flags = getConfig(c.env).flags
  return c.json({
    ...data,
    cms,
    feature_flags: {
      financial_module: flags.financialModule,
      teacher_compensation: flags.teacherCompensation,
      financial_exports: flags.financialExports,
      financial_charts: flags.financialCharts
    },
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
    if (currentErr) return c.json(dbError(), 500)
    update.allowed_origins = withCmsOrigins(current?.allowed_origins, body.cms)
  }
  if (!Object.keys(update).length) return c.json({ error: 'Nada para atualizar' }, 400)

  const { data, error } = await sb.from('sites')
    .update(update)
    .eq('id', user.site_id)
    .select('id, slug, domain_custom, nome_prof, bio_prof, foto_url, cor_primaria, cor_accent, logo_url, ativo, allowed_origins')
    .single()

  if (error) return c.json(dbError(), 500)
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
  if (error) return c.json(dbError(), 500)

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
    .neq('status', 'EXCLUIDA_PELO_PROFESSOR')
    .maybeSingle()
  if (error) return c.json(dbError(), 500)
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
  if (error) return c.json(dbError(), 500)
  if (data.status === 'FINALIZADA') {
    await ensureCorrectionCompensationEntry(c.env, sb, user, access.siteId, access.cms, data)
  }
  return c.json(data)
})

app.post('/correcoes/:id/excluir', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const access = await requireCorrecaoAccess(sb, user, c.req.param('id'), 'excluir_redacoes')
  if ('error' in access) return c.json({ error: access.error }, access.status)

  const { data: atual, error: atualErr } = await sb.from('correcoes')
    .select('id, site_id, arquivo_url')
    .eq('id', c.req.param('id'))
    .eq('site_id', access.siteId)
    .maybeSingle()
  if (atualErr) return c.json(dbError(), 500)
  if (!atual) return c.json({ error: 'Redação não encontrada neste site.' }, 404)

  const { data, error } = await sb.from('correcoes')
    .update({
      status: 'EXCLUIDA_PELO_PROFESSOR',
      prof_id: user.sub,
      arquivo_url: '',
      updated_at: new Date().toISOString()
    })
    .eq('id', c.req.param('id'))
    .eq('site_id', access.siteId)
    .select()
    .single()

  if (error) return c.json(dbError(), 500)
  try {
    await deleteStoredCorrectionFile(c.env, sb, atual)
  } catch {}
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
  if (error) return c.json(dbError(), 500)
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
  if (error) return c.json(dbError(), 500)
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
  const sexo = normalizeProfessorGender(body.sexo || body.gender || body.professor_gender)
  if (!nome || !email || !password) return c.json({ error: 'Nome, email e senha são obrigatórios.' }, 400)
  if (password.length < 6) return c.json({ error: 'A senha precisa ter pelo menos 6 caracteres.' }, 400)

  const { data: authData, error: authErr } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { nome, site_id: siteId, role: 'CORRETOR', sexo }
  })
  if (authErr || !authData.user) return c.json({ error: authErr?.message || 'Não foi possível criar o usuário.' }, 400)

  const { error: profileErr } = await sb.from('profiles').upsert({
    id: authData.user.id,
    nome,
    role: 'CORRETOR',
    site_id: siteId,
    ativo: true
  })
  if (profileErr) return c.json(dbError(), 500)

  const child = {
    id: crypto.randomUUID(),
    user_id: authData.user.id,
    nome,
    email,
    sexo,
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
  if (saveErr) return c.json(dbError(), 500)

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
      if (lockErr) return c.json(dbError(), 500)
      if ((locked || []).length) return c.json({ error: 'Há correções já finalizadas nesse direcionamento. Reabra a correção antes de remover do corretor.' }, 409)
    }
  }
  const updated = {
    ...current,
    nome: typeof body.nome === 'string' && body.nome.trim() ? body.nome.trim() : current.nome,
    sexo: ('sexo' in body || 'gender' in body || 'professor_gender' in body)
      ? normalizeProfessorGender(body.sexo || body.gender || body.professor_gender, current.sexo || 'FEMININO')
      : current.sexo,
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
    await sb.auth.admin.updateUserById(current.user_id, {
      user_metadata: { nome: updated.nome, site_id: siteId, role: 'CORRETOR', sexo: updated.sexo }
    })
  }

  const { error: saveErr } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site?.allowed_origins || [], cms) })
    .eq('id', siteId)
  if (saveErr) return c.json(dbError(), 500)
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
  if (saveErr) return c.json(dbError(), 500)
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
  if (error) return c.json(dbError(), 500)
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

  if (error) return c.json(dbError(), 500)

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
  if (alunoErr) return c.json(dbError(), 500)
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
  if (saveErr) return c.json(dbError(), 500)
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
  if (alunoErr) return c.json(dbError(), 500)
  if (!aluno) return c.json({ error: 'Aluno não encontrado neste site.' }, 404)

  const { data: site, error: siteErr } = await sb.from('sites')
    .select('allowed_origins')
    .eq('id', user.site_id)
    .single()
  if (siteErr) return c.json(dbError(), 500)

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
  if (error) return c.json(dbError(), 500)

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
  if (error) return c.json(dbError(), 500)
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
          ...normalizeTurmaSettings(cms.turma_settings?.[t.id]),
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
  if (matErr) return c.json(dbError(), 500)

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
        ...normalizeTurmaSettings(cms.turma_settings?.[t.id]),
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
  const currentNormalized = normalizeTurmaSettings(current)
  const periodicidade = ['DIA', 'SEMANA', 'CUSTOM_DIAS'].includes(String(body.limite_redacoes_periodicidade))
    ? String(body.limite_redacoes_periodicidade)
    : currentNormalized.limite_redacoes_periodicidade
  const limitePorPeriodo = Math.max(1, Math.floor(
    Number(body.limite_redacoes_por_periodo) ||
    Number(body.limite_redacoes_por_aluno) ||
    Number(current.limite_redacoes_por_periodo) ||
    Number(current.limite_redacoes_por_aluno) ||
    1
  ))
  cms.turma_settings = {
    ...(cms.turma_settings || {}),
    [turmaId]: {
      ...current,
      matriculas_abertas: typeof body.matriculas_abertas === 'boolean' ? body.matriculas_abertas : current.matriculas_abertas !== false,
      envios_abertos: typeof body.envios_abertos === 'boolean' ? body.envios_abertos : current.envios_abertos !== false,
      limite_redacoes_por_aluno: limitePorPeriodo,
      limite_redacoes_por_periodo: limitePorPeriodo,
      limite_redacoes_periodicidade: periodicidade,
      limite_redacoes_periodo_dias: Math.max(1, Math.floor(Number(body.limite_redacoes_periodo_dias) || Number(current.limite_redacoes_periodo_dias) || 7)),
      payment_methods: normalizeTurmaSettings({ payment_methods: body.payment_methods ?? current.payment_methods }).payment_methods,
      credit_card_installments: Math.max(1, Math.min(12, Math.floor(Number(body.credit_card_installments) || Number(current.credit_card_installments) || 1))),
      payment_fee_payer: String(body.payment_fee_payer || current.payment_fee_payer || 'PROFESSOR').toUpperCase() === 'ALUNO' ? 'ALUNO' : 'PROFESSOR',
      payment_fee_percent: Math.max(0, Math.min(30, Number(body.payment_fee_percent ?? current.payment_fee_percent) || 0)),
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
  if (error) return c.json(dbError(), 500)
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
  if (error) return c.json(dbError(), 500)

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
    if (siteErr) return c.json(dbError(), 500)
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
    if (saveErr) return c.json(dbError(), 500)
    return c.json({ site_id: user.site_id, turma_id: turmaId, aluno_id, ativo: true, origem: 'PROFESSOR' }, 201)
  }
  if (error) return c.json(dbError(), 500)
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
    if (siteErr) return c.json(dbError(), 500)
    const cms = parseCms(site)
    const current = cms.enrollments?.[turmaId]?.[alunoId]
    if (!current) return c.json({ error: 'Aluno não está vinculado a esta turma.' }, 404)
    cms.enrollments[turmaId][alunoId] = { ...current, ativo: body.ativo, updated_at: new Date().toISOString() }
    const { error: saveErr } = await sb.from('sites').update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) }).eq('id', user.site_id)
    if (saveErr) return c.json(dbError(), 500)
    return c.json({ turma_id: turmaId, aluno_id: alunoId, ...cms.enrollments[turmaId][alunoId] })
  }
  if (error) return c.json(dbError(), 500)
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
    if (siteErr) return c.json(dbError(), 500)
    const cms = parseCms(site)
    const current = cms.enrollments?.[turmaId]?.[alunoId]
    if (!current) return c.json({ error: 'Aluno não está vinculado a esta turma.' }, 404)
    if (hardDelete) delete cms.enrollments[turmaId][alunoId]
    else cms.enrollments[turmaId][alunoId] = { ...current, ativo: false, updated_at: new Date().toISOString() }
    const { error: saveErr } = await sb.from('sites').update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) }).eq('id', user.site_id)
    if (saveErr) return c.json(dbError(), 500)
    return c.json({ turma_id: turmaId, aluno_id: alunoId, ativo: hardDelete ? false : cms.enrollments[turmaId]?.[alunoId]?.ativo })
  }
  if (error) return c.json(dbError(), 500)
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
    if (siteErr) return c.json(dbError(), 500)
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
    if (saveErr) return c.json(dbError(), 500)
    return c.json({ ok: true, transferidos: alunoIds.length, storage: 'cms' })
  }
  if (upsertErr) return c.json(dbError(), 500)

  const { error: originErr } = await sb.from('turma_alunos')
    .update({ ativo: false })
    .eq('site_id', user.site_id)
    .eq('turma_id', origemTurmaId)
    .in('aluno_id', alunoIds)
  if (originErr) return c.json(dbError(), 500)

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
  if (error) return c.json(dbError(), 500)
  return c.json(data, 201)
})

async function financialContext(c: any) {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return { error: 'Professor sem site vinculado.', status: 400 as const }
  const cms = await getSiteCms(sb, siteId)
  const child = findChildTeacher(cms, user)
  return { user, sb, siteId, cms, child }
}

async function listFinancialEntries(sb: ReturnType<typeof getAdmin>, siteId: string, childUserId?: string | null, status?: string | null) {
  let query = sb.from('correction_compensation_entries')
    .select('id, site_id, correction_id, child_professor_id, parent_professor_id, aluno_id, turma_id, rule_id, closing_id, correction_type, status, amount_cents, currency, assigned_at, corrected_at, approved_at, paid_at, rule_snapshot_json, metadata, created_at, updated_at')
    .eq('site_id', siteId)
    .order('corrected_at', { ascending: false })
    .limit(500)
  if (childUserId) query = query.eq('child_professor_id', childUserId)
  if (status && status !== 'ALL') query = query.eq('status', status)
  const { data, error } = await query
  if (error) return { error }
  const rows = data || []
  const alunoIds = [...new Set(rows.map((row: any) => row.aluno_id).filter(Boolean))]
  const turmaIds = [...new Set(rows.map((row: any) => row.turma_id).filter(Boolean))]
  const childIds = [...new Set(rows.map((row: any) => row.child_professor_id).filter(Boolean))]
  const correctionIds = [...new Set(rows.map((row: any) => row.correction_id).filter(Boolean))]
  const [{ data: alunos }, { data: turmas }, { data: filhos }, { data: correcoes }] = await Promise.all([
    alunoIds.length ? sb.from('profiles').select('id, nome').eq('site_id', siteId).in('id', alunoIds) : Promise.resolve({ data: [] as any[] }),
    turmaIds.length ? sb.from('turmas').select('id, nome').eq('site_id', siteId).in('id', turmaIds) : Promise.resolve({ data: [] as any[] }),
    childIds.length ? sb.from('profiles').select('id, nome').eq('site_id', siteId).in('id', childIds) : Promise.resolve({ data: [] as any[] }),
    correctionIds.length ? sb.from('correcoes').select('id, titulo').eq('site_id', siteId).in('id', correctionIds) : Promise.resolve({ data: [] as any[] })
  ])
  const alunoMap = new Map((alunos || []).map((item: any) => [item.id, item.nome]))
  const turmaMap = new Map((turmas || []).map((item: any) => [item.id, item.nome]))
  const filhoMap = new Map((filhos || []).map((item: any) => [item.id, item.nome]))
  const corrMap = new Map((correcoes || []).map((item: any) => [item.id, item.titulo]))
  return {
    data: rows.map((row: any) => ({
      ...row,
      amount: centsToMoney(row.amount_cents),
      aluno_nome: alunoMap.get(row.aluno_id) || null,
      turma_nome: turmaMap.get(row.turma_id) || null,
      child_professor_nome: filhoMap.get(row.child_professor_id) || null,
      correcao_titulo: corrMap.get(row.correction_id) || row.metadata?.correction_title || null,
      rule_source: row.rule_snapshot_json?.source || null,
      rule_snapshot_json: undefined
    }))
  }
}

function summarizeFinancialEntries(entries: any[], payouts: any[] = []) {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const month = today.slice(0, 7)
  const year = today.slice(0, 4)
  const total = entries.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0)
  const paid = entries.filter((item) => item.status === FINANCIAL_ENTRY_STATUS.PAID).reduce((sum, item) => sum + Number(item.amount_cents || 0), 0)
  const awaiting = entries.filter((item) => item.status === FINANCIAL_ENTRY_STATUS.AWAITING_CLOSING).reduce((sum, item) => sum + Number(item.amount_cents || 0), 0)
  const inClosing = entries.filter((item) => [FINANCIAL_ENTRY_STATUS.IN_CLOSING, FINANCIAL_ENTRY_STATUS.APPROVED, FINANCIAL_ENTRY_STATUS.PARTIALLY_PAID].includes(item.status)).reduce((sum, item) => sum + Number(item.amount_cents || 0), 0)
  const todayRows = entries.filter((item) => String(item.corrected_at || '').startsWith(today))
  const monthRows = entries.filter((item) => String(item.corrected_at || '').startsWith(month))
  const yearRows = entries.filter((item) => String(item.corrected_at || '').startsWith(year))
  return {
    corrections_today: todayRows.length,
    corrections_month: monthRows.length,
    corrections_year: yearRows.length,
    amount_today: centsToMoney(todayRows.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0)),
    amount_month: centsToMoney(monthRows.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0)),
    amount_year: centsToMoney(yearRows.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0)),
    amount_total: centsToMoney(total),
    awaiting_closing: centsToMoney(awaiting),
    in_closing: centsToMoney(inClosing),
    paid: centsToMoney(paid),
    pending: centsToMoney(Math.max(0, total - paid)),
    average_per_correction: entries.length ? centsToMoney(Math.round(total / entries.length)) : 0,
    last_payment: payouts[0] || null
  }
}

async function summarizePaymentRevenue(sb: ReturnType<typeof getAdmin>, siteId: string) {
  const { data, error } = await sb.from('payments')
    .select('status, amount_cents, paid_at, updated_at, created_at')
    .eq('site_id', siteId)
    .in('status', ['RECEIVED', 'CONFIRMED'])
    .order('paid_at', { ascending: false })
    .limit(5000)
  if (error) return { error }

  const rows = data || []
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const month = today.slice(0, 7)
  const year = today.slice(0, 4)
  const when = (row: any) => String(row.paid_at || row.updated_at || row.created_at || '')
  const sum = (items: any[]) => centsToMoney(items.reduce((total, row) => total + Number(row.amount_cents || 0), 0))
  return {
    count_total: rows.length,
    amount_total: sum(rows),
    amount_today: sum(rows.filter((row: any) => when(row).startsWith(today))),
    amount_month: sum(rows.filter((row: any) => when(row).startsWith(month))),
    amount_year: sum(rows.filter((row: any) => when(row).startsWith(year)))
  }
}

function getIdempotencyKey(c: any, body: any, operation: string) {
  const explicit = String(c.req.header('Idempotency-Key') || body?.idempotency_key || '').trim()
  return explicit || `${operation}:${crypto.randomUUID()}`
}

function financialRpcError(error: any) {
  const message = String(error?.message || '').trim()
  if (!message) return dbError()
  return { error: message.replace(/^ERROR:\s*/i, '') }
}

function csvCell(value: unknown) {
  const text = String(value == null ? '' : value)
  return `"${text.replace(/"/g, '""')}"`
}

function csvResponse(filename: string, rows: unknown[][]) {
  const csv = '\ufeff' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n')
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`
    }
  })
}

async function mapProfileNames(sb: ReturnType<typeof getAdmin>, siteId: string, ids: string[]) {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (!uniqueIds.length) return new Map<string, string>()
  const { data } = await sb.from('profiles').select('id, nome, email').eq('site_id', siteId).in('id', uniqueIds)
  return new Map((data || []).map((item: any) => [item.id, item.nome || item.email || 'Professor']))
}

async function listFinancialClosings(ctx: Awaited<ReturnType<typeof financialContext>>) {
  if ('error' in ctx) return { error: ctx.error }
  let query = ctx.sb.from('teacher_payment_closings')
    .select('id, site_id, child_professor_id, parent_professor_id, period_start, period_end, status, entries_count, gross_amount_cents, adjustments_amount_cents, final_amount_cents, currency, approved_at, paid_at, notes, created_at, updated_at')
    .eq('site_id', ctx.siteId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (ctx.child) query = query.eq('child_professor_id', ctx.child.user_id)
  const { data, error } = await query
  if (error) return { error }
  const nameMap = await mapProfileNames(ctx.sb, ctx.siteId, (data || []).map((row: any) => row.child_professor_id))
  return {
    data: (data || []).map((row: any) => ({
      ...row,
      child_professor_nome: nameMap.get(row.child_professor_id) || null,
      gross_amount: centsToMoney(row.gross_amount_cents),
      adjustments_amount: centsToMoney(row.adjustments_amount_cents),
      final_amount: centsToMoney(row.final_amount_cents)
    }))
  }
}

async function listFinancialPayouts(ctx: Awaited<ReturnType<typeof financialContext>>) {
  if ('error' in ctx) return { error: ctx.error }
  let query = ctx.sb.from('teacher_payouts')
    .select('id, closing_id, child_professor_id, amount_cents, status, payment_method, paid_at, reference, notes, created_at')
    .eq('site_id', ctx.siteId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (ctx.child) query = query.eq('child_professor_id', ctx.child.user_id)
  const { data, error } = await query
  if (error) return { error }
  const nameMap = await mapProfileNames(ctx.sb, ctx.siteId, (data || []).map((row: any) => row.child_professor_id))
  return {
    data: (data || []).map((row: any) => ({
      ...row,
      child_professor_nome: nameMap.get(row.child_professor_id) || null,
      amount: centsToMoney(row.amount_cents),
      reference: row.reference ? `...${String(row.reference).slice(-6)}` : null
    }))
  }
}

app.get('/financial/summary', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  const childUserId = ctx.child?.user_id || null
  const entries = await listFinancialEntries(ctx.sb, ctx.siteId, childUserId)
  if ('error' in entries) return c.json(dbError(), 500)
  let payoutQuery = ctx.sb.from('teacher_payouts')
    .select('id, closing_id, amount_cents, status, paid_at, payment_method, reference, created_at')
    .eq('site_id', ctx.siteId)
    .order('created_at', { ascending: false })
    .limit(20)
  if (childUserId) payoutQuery = payoutQuery.eq('child_professor_id', childUserId)
  const { data: payouts } = await payoutQuery
  const summary = summarizeFinancialEntries(entries.data, payouts || [])
  const revenue = childUserId ? null : await summarizePaymentRevenue(ctx.sb, ctx.siteId)
  if (revenue && 'error' in revenue) return c.json(dbError(), 500)
  return c.json({
    sandbox: c.env.ASAAS_ENV === 'sandbox',
    role: childUserId ? 'CHILD_TEACHER' : 'PARENT_TEACHER',
    summary,
    revenue: revenue || null,
    owner_balance: childUserId ? null : {
      before_fees: centsToMoney(Math.max(0, Math.round(Number((revenue as any)?.amount_total || 0) * 100) - Math.round(Number(summary.amount_total || 0) * 100))),
      correction_costs: summary.amount_total
    }
  })
})

app.get('/financial/compensations', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  const status = c.req.query('status')?.trim().toUpperCase() || null
  const childId = ctx.child?.user_id || c.req.query('child_professor_id') || null
  if (ctx.child && childId !== ctx.child.user_id) return c.json({ error: 'Acesso negado.' }, 403)
  const entries = await listFinancialEntries(ctx.sb, ctx.siteId, childId, status)
  if ('error' in entries) return c.json(dbError(), 500)
  return c.json({ data: entries.data })
})

app.get('/financial/payables', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  if (ctx.child) return c.json({ error: 'Corretores filhos não acessam contas a pagar do professor.' }, 403)
  const entries = await listFinancialEntries(ctx.sb, ctx.siteId, c.req.query('child_professor_id') || null, c.req.query('status') || FINANCIAL_ENTRY_STATUS.AWAITING_CLOSING)
  if ('error' in entries) return c.json(dbError(), 500)
  return c.json({ data: entries.data })
})

app.get('/financial/teachers', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  if (ctx.child) return c.json({ error: 'Corretores filhos não acessam consolidação do professor.' }, 403)
  const entries = await listFinancialEntries(ctx.sb, ctx.siteId)
  if ('error' in entries) return c.json(dbError(), 500)
  const payouts = await listFinancialPayouts(ctx)
  if ('error' in payouts) return c.json(dbError(), 500)
  const children = normalizeChildTeachers(ctx.cms).map((child: any) => ({
    id: child.user_id || child.id,
    nome: child.nome || child.email || 'Corretor',
    email: child.email || null,
    ativo: child.ativo !== false,
    valor_correcao: Number(child.valor_correcao || child.valor_por_redacao || 0),
    valor_revisao: Number(child.valor_revisao || child.valor_por_revisao || 0)
  })).filter((child: any) => child.id)
  const byChild = new Map<string, any>(children.map((child: any) => [child.id, {
    ...child,
    corrections_count: 0,
    amount_total_cents: 0,
    awaiting_closing_cents: 0,
    in_closing_cents: 0,
    paid_cents: 0,
    disputed_count: 0,
    payouts_count: 0,
    payouts_total_cents: 0,
    last_payment_at: null as string | null
  }]))
  for (const entry of entries.data || []) {
    const id = entry.child_professor_id
    if (!id) continue
    if (!byChild.has(id)) {
      byChild.set(id, {
        id,
        nome: entry.child_professor_nome || 'Corretor',
        email: null,
        ativo: true,
        valor_correcao: 0,
        valor_revisao: 0,
        corrections_count: 0,
        amount_total_cents: 0,
        awaiting_closing_cents: 0,
        in_closing_cents: 0,
        paid_cents: 0,
        disputed_count: 0,
        payouts_count: 0,
        payouts_total_cents: 0,
        last_payment_at: null
      })
    }
    const row = byChild.get(id)
    const amount = Number(entry.amount_cents || 0)
    row.corrections_count += 1
    row.amount_total_cents += amount
    if (entry.status === FINANCIAL_ENTRY_STATUS.AWAITING_CLOSING) row.awaiting_closing_cents += amount
    if ([FINANCIAL_ENTRY_STATUS.IN_CLOSING, FINANCIAL_ENTRY_STATUS.APPROVED, FINANCIAL_ENTRY_STATUS.PARTIALLY_PAID].includes(entry.status)) row.in_closing_cents += amount
    if (entry.status === FINANCIAL_ENTRY_STATUS.PAID) row.paid_cents += amount
    if (entry.status === FINANCIAL_ENTRY_STATUS.DISPUTED) row.disputed_count += 1
  }
  for (const payout of payouts.data || []) {
    const id = payout.child_professor_id
    const row = byChild.get(id)
    if (!row) continue
    row.payouts_count += 1
    row.payouts_total_cents += Number(payout.amount_cents || 0)
    row.last_payment_at = row.last_payment_at || payout.paid_at || payout.created_at || null
  }
  return c.json({
    data: [...byChild.values()].map((row: any) => ({
      ...row,
      amount_total: centsToMoney(row.amount_total_cents),
      awaiting_closing: centsToMoney(row.awaiting_closing_cents),
      in_closing: centsToMoney(row.in_closing_cents),
      paid: centsToMoney(row.paid_cents),
      payouts_total: centsToMoney(row.payouts_total_cents)
    }))
  })
})

app.get('/financial/closings', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  const closings = await listFinancialClosings(ctx)
  if ('error' in closings) return c.json(dbError(), 500)
  return c.json({ data: closings.data })
})

app.post('/financial/closings', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  if (ctx.child) return c.json({ error: 'Corretores filhos não criam fechamentos.' }, 403)
  const body = await c.req.json()
  const childProfessorId = String(body.child_professor_id || '')
  const entryIds = Array.isArray(body.entry_ids) ? [...new Set(body.entry_ids.filter(Boolean).map(String))] : []
  if (!childProfessorId || !entryIds.length) return c.json({ error: 'Informe professor filho e lançamentos.' }, 400)
  const { data, error } = await ctx.sb.rpc('create_teacher_closing', {
    p_site_id: ctx.siteId,
    p_parent_professor_id: ctx.user.sub,
    p_child_professor_id: childProfessorId,
    p_entry_ids: entryIds,
    p_period_start: body.period_start || null,
    p_period_end: body.period_end || null,
    p_notes: typeof body.notes === 'string' ? body.notes.trim() : null,
    p_idempotency_key: getIdempotencyKey(c, body, 'create_teacher_closing')
  })
  if (error) return c.json(financialRpcError(error), 409)
  return c.json({
    ...data,
    id: data?.closing_id,
    gross_amount: centsToMoney(data?.gross_amount_cents),
    final_amount: centsToMoney(data?.final_amount_cents)
  }, 201)
})

app.patch('/financial/closings/:id/approve', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  if (ctx.child) return c.json({ error: 'Corretores filhos não aprovam fechamentos.' }, 403)
  const body = await c.req.json().catch(() => ({}))
  const { data, error } = await ctx.sb.rpc('approve_teacher_closing', {
    p_site_id: ctx.siteId,
    p_parent_professor_id: ctx.user.sub,
    p_closing_id: c.req.param('id'),
    p_idempotency_key: getIdempotencyKey(c, body, 'approve_teacher_closing')
  })
  if (error) return c.json(financialRpcError(error), 409)
  return c.json(data)
})

app.post('/financial/closings/:id/payouts', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  if (ctx.child) return c.json({ error: 'Corretores filhos não registram pagamentos.' }, 403)
  const body = await c.req.json()
  const amountCents = Math.round(Number(body.amount_cents || 0))
  if (!Number.isFinite(amountCents) || amountCents <= 0) return c.json({ error: 'Valor inválido.' }, 400)
  const { data, error } = await ctx.sb.rpc('register_teacher_payout', {
    p_site_id: ctx.siteId,
    p_parent_professor_id: ctx.user.sub,
    p_closing_id: c.req.param('id'),
    p_amount_cents: amountCents,
    p_payment_method: String(body.payment_method || 'MANUAL').trim(),
    p_reference: typeof body.reference === 'string' ? body.reference.trim() : null,
    p_notes: typeof body.notes === 'string' ? body.notes.trim() : null,
    p_paid_at: body.paid_at || null,
    p_idempotency_key: getIdempotencyKey(c, body, 'register_teacher_payout')
  })
  if (error) return c.json(financialRpcError(error), 409)
  await appendFinancialNotification(ctx.sb, ctx.siteId, {
    title: 'Pagamento registrado',
    message: `Pagamento de R$ ${centsToMoney(amountCents).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} registrado para um fechamento.`,
    severity: 'success',
    key: `payout:${data?.payout_id}`,
    closing_id: data?.closing_id,
    child_professor_id: null
  })
  return c.json({
    ...data,
    id: data?.payout_id,
    amount: centsToMoney(data?.amount_cents)
  }, 201)
})

app.post('/financial/closings/:id/adjustments', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  if (ctx.child) return c.json({ error: 'Corretores filhos não ajustam fechamentos.' }, 403)
  const body = await c.req.json()
  const amountCents = Math.round(Number(body.amount_cents || 0))
  if (!Number.isFinite(amountCents) || amountCents === 0) return c.json({ error: 'Valor de ajuste inválido.' }, 400)
  const { data, error } = await ctx.sb.rpc('add_teacher_closing_adjustment', {
    p_site_id: ctx.siteId,
    p_parent_professor_id: ctx.user.sub,
    p_closing_id: c.req.param('id'),
    p_amount_cents: amountCents,
    p_adjustment_type: String(body.adjustment_type || 'MANUAL').trim().toUpperCase(),
    p_reason: String(body.reason || '').trim(),
    p_idempotency_key: getIdempotencyKey(c, body, 'add_teacher_closing_adjustment')
  })
  if (error) return c.json(financialRpcError(error), 409)
  return c.json(data, 201)
})

app.post('/financial/closings/:id/cancel', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  if (ctx.child) return c.json({ error: 'Corretores filhos não cancelam fechamentos.' }, 403)
  const body = await c.req.json().catch(() => ({}))
  const { data, error } = await ctx.sb.rpc('cancel_teacher_closing', {
    p_site_id: ctx.siteId,
    p_parent_professor_id: ctx.user.sub,
    p_closing_id: c.req.param('id'),
    p_reason: String(body.reason || '').trim(),
    p_idempotency_key: getIdempotencyKey(c, body, 'cancel_teacher_closing')
  })
  if (error) return c.json(financialRpcError(error), 409)
  return c.json(data)
})

app.post('/financial/payouts/:id/reverse', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  if (ctx.child) return c.json({ error: 'Corretores filhos não estornam pagamentos.' }, 403)
  const body = await c.req.json().catch(() => ({}))
  const { data, error } = await ctx.sb.rpc('reverse_teacher_payout', {
    p_site_id: ctx.siteId,
    p_parent_professor_id: ctx.user.sub,
    p_payout_id: c.req.param('id'),
    p_reason: String(body.reason || '').trim(),
    p_idempotency_key: getIdempotencyKey(c, body, 'reverse_teacher_payout')
  })
  if (error) return c.json(financialRpcError(error), 409)
  return c.json(data)
})

app.get('/financial/payouts', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  const payouts = await listFinancialPayouts(ctx)
  if ('error' in payouts) return c.json(dbError(), 500)
  return c.json({ data: payouts.data })
})

app.get('/financial/export.csv', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  if (!getConfig(c.env).flags.financialExports) return c.json({ error: 'Exportação financeira desativada.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  const type = String(c.req.query('type') || 'compensations').trim().toLowerCase()
  const now = new Date().toISOString().slice(0, 10)

  if (type === 'payables') {
    if (ctx.child) return c.json({ error: 'Corretores filhos não exportam contas a pagar.' }, 403)
    const entries = await listFinancialEntries(ctx.sb, ctx.siteId, c.req.query('child_professor_id') || null, c.req.query('status') || FINANCIAL_ENTRY_STATUS.AWAITING_CLOSING)
    if ('error' in entries) return c.json(dbError(), 500)
    return csvResponse(`financeiro-contas-a-pagar-${now}.csv`, [
      ['Corretor', 'Turma', 'Aluno', 'Redação', 'Concluída em', 'Valor', 'Status', 'Regra'],
      ...(entries.data || []).map((row: any) => [row.child_professor_nome, row.turma_nome, row.aluno_nome, row.correcao_titulo, row.corrected_at, centsToMoney(row.amount_cents), row.status, row.rule_source])
    ])
  }

  if (type === 'closings') {
    const closings = await listFinancialClosings(ctx)
    if ('error' in closings) return c.json(dbError(), 500)
    return csvResponse(`financeiro-fechamentos-${now}.csv`, [
      ['Corretor', 'Período início', 'Período fim', 'Qtd.', 'Bruto', 'Ajustes', 'Final', 'Status', 'Aprovado em', 'Pago em', 'Criado em'],
      ...(closings.data || []).map((row: any) => [row.child_professor_nome, row.period_start, row.period_end, row.entries_count, row.gross_amount, row.adjustments_amount, row.final_amount, row.status, row.approved_at, row.paid_at, row.created_at])
    ])
  }

  if (type === 'payouts') {
    const payouts = await listFinancialPayouts(ctx)
    if ('error' in payouts) return c.json(dbError(), 500)
    return csvResponse(`financeiro-pagamentos-${now}.csv`, [
      ['Corretor', 'Fechamento', 'Valor', 'Status', 'Método', 'Referência', 'Pago em', 'Criado em'],
      ...(payouts.data || []).map((row: any) => [row.child_professor_nome, row.closing_id, row.amount, row.status, row.payment_method, row.reference, row.paid_at, row.created_at])
    ])
  }

  if (type === 'audit') {
    if (ctx.child) return c.json({ error: 'Corretores filhos não exportam auditoria financeira.' }, 403)
    const { data, error } = await ctx.sb.from('financial_audit_logs')
      .select('id, target_table, target_id, action, metadata, created_at')
      .eq('site_id', ctx.siteId)
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) return c.json(dbError(), 500)
    return csvResponse(`financeiro-auditoria-${now}.csv`, [
      ['Ação', 'Tabela', 'Registro', 'Detalhes', 'Criado em'],
      ...(data || []).map((row: any) => [row.action, row.target_table, row.target_id, JSON.stringify(row.metadata || {}), row.created_at])
    ])
  }

  const status = c.req.query('status')?.trim().toUpperCase() || null
  const childId = ctx.child?.user_id || c.req.query('child_professor_id') || null
  if (ctx.child && childId !== ctx.child.user_id) return c.json({ error: 'Acesso negado.' }, 403)
  const entries = await listFinancialEntries(ctx.sb, ctx.siteId, childId, status)
  if ('error' in entries) return c.json(dbError(), 500)
  return csvResponse(`financeiro-lancamentos-${now}.csv`, [
    ['Corretor', 'Turma', 'Aluno', 'Redação', 'Tipo', 'Atribuída em', 'Concluída em', 'Valor', 'Status', 'Regra'],
    ...(entries.data || []).map((row: any) => [row.child_professor_nome, row.turma_nome, row.aluno_nome, row.correcao_titulo, row.correction_type, row.assigned_at, row.corrected_at, centsToMoney(row.amount_cents), row.status, row.rule_source])
  ])
})

app.get('/financial/audit', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  if (ctx.child) return c.json({ error: 'Corretores filhos não acessam auditoria financeira.' }, 403)
  const { data, error } = await ctx.sb.from('financial_audit_logs')
    .select('id, target_table, target_id, action, metadata, created_at')
    .eq('site_id', ctx.siteId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) return c.json(dbError(), 500)
  return c.json({ data: data || [] })
})

app.post('/financial/compensations/:id/dispute', async (c) => {
  if (financialUnavailable(c.env)) return c.json({ error: 'Módulo financeiro desativado.' }, 503)
  const ctx = await financialContext(c)
  if ('error' in ctx) return c.json({ error: ctx.error }, ctx.status)
  if (!ctx.child) return c.json({ error: 'Somente o corretor filho pode contestar por aqui.' }, 403)
  const body = await c.req.json().catch(() => ({}))
  const reason = String(body.reason || '').trim()
  if (reason.length < 3) return c.json({ error: 'Informe o motivo da contestação.' }, 400)
  const { data, error } = await ctx.sb.from('correction_compensation_entries')
    .update({ status: FINANCIAL_ENTRY_STATUS.DISPUTED, metadata: { dispute_reason: reason }, updated_by: ctx.user.sub, updated_at: new Date().toISOString() })
    .eq('id', c.req.param('id'))
    .eq('site_id', ctx.siteId)
    .eq('child_professor_id', ctx.child.user_id)
    .select('id, status')
    .single()
  if (error || !data) return c.json({ error: 'Lançamento não encontrado.' }, 404)
  await logFinancialAudit(ctx.sb, { siteId: ctx.siteId, actorId: ctx.user.sub, targetTable: 'correction_compensation_entries', targetId: data.id, action: 'COMPENSATION_DISPUTED', metadata: { reason } })
  return c.json(data)
})

app.get('/payments', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado.' }, 400)
  const statusFilter = new URL(c.req.url).searchParams.get('status')?.trim().toUpperCase()
  const limit = Math.max(1, Math.min(100, Number(new URL(c.req.url).searchParams.get('limit') || 100)))
  let query = sb.from('payments')
    .select('id, site_id, turma_id, course_id, product_type, aluno_id, payer_email, payer_name, provider, provider_payment_id, status, amount_cents, billing_type, checkout_code, created_at, paid_at, updated_at, raw_summary')
    .eq('site_id', siteId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (statusFilter && statusFilter !== 'ALL') query = query.eq('status', statusFilter)
  const result = await query
  const dataRows = result.data
  const queryError = result.error
  if (queryError) return c.json(dbError(), 500)

  const turmaIds = Array.from(new Set((dataRows || []).map((p: any) => p.turma_id).filter(Boolean)))
  const alunoIds = Array.from(new Set((dataRows || []).map((p: any) => p.aluno_id).filter(Boolean)))
  const [{ data: turmas }, { data: alunos }, { data: site }] = await Promise.all([
    turmaIds.length ? sb.from('turmas').select('id, nome').eq('site_id', siteId).in('id', turmaIds) : Promise.resolve({ data: [] as any[] }),
    alunoIds.length ? sb.from('profiles').select('id, nome, ativo').eq('site_id', siteId).in('id', alunoIds) : Promise.resolve({ data: [] as any[] }),
    sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  ])
  const cms = parseCms(site)
  const turmaById = new Map((turmas || []).map((t: any) => [t.id, t]))
  const alunoById = new Map((alunos || []).map((a: any) => [a.id, a]))
  const courseById = new Map<string, any>((cms.video_courses || []).map((course: any) => [String(course.id || ''), course]))

  return c.json({
    sandbox: c.env.ASAAS_ENV === 'sandbox',
    data: (dataRows || []).map((p: any) => ({
      ...p,
      provider_payment_id: undefined,
      provider_payment_ref: p.provider_payment_id ? `...${String(p.provider_payment_id).slice(-6)}` : null,
      amount: Number(p.amount_cents || 0) / 100,
      turma_nome: turmaById.get(p.turma_id)?.nome || null,
      course_nome: courseById.get(String(p.course_id || ''))?.title || p.raw_summary?.course_title || null,
      produto_tipo: String(p.product_type || p.raw_summary?.product_type || 'TURMA'),
      produto_nome: String(p.product_type || p.raw_summary?.product_type || 'TURMA') === 'VIDEO_COURSE'
        ? (courseById.get(String(p.course_id || ''))?.title || p.raw_summary?.course_title || 'Curso em vídeo')
        : (turmaById.get(p.turma_id)?.nome || 'Turma'),
      aluno_nome: alunoById.get(p.aluno_id)?.nome || p.payer_name || null,
      aluno_ativo: p.aluno_id ? alunoById.get(p.aluno_id)?.ativo !== false : null
    }))
  })
})

app.get('/notifications', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado.' }, 400)
  const { data: site, error } = await sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  if (error || !site) return c.json({ error: error?.message || 'Site não encontrado.' }, 404)
  const cms = parseCms(site)
  const notifications = (cms.notifications || [])
    .slice()
    .sort((a: any, b: any) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')))
    .slice(0, 50)
  return c.json({
    unread_count: notifications.filter((item: any) => item?.read !== true).length,
    data: notifications
  })
})

app.patch('/notifications/:id/read', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const siteId = await resolveSiteId(sb, user)
  if (!siteId) return c.json({ error: 'Professor sem site vinculado.' }, 400)
  const { data: site, error } = await sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  if (error || !site) return c.json({ error: error?.message || 'Site não encontrado.' }, 404)
  const cms = parseCms(site)
  const id = c.req.param('id')
  let found = false
  cms.notifications = (cms.notifications || []).map((item: any) => {
    if (String(item?.id || '') !== id) return item
    found = true
    return { ...item, read: true, read_at: new Date().toISOString() }
  })
  if (!found) return c.json({ error: 'Notificação não encontrada.' }, 404)
  const { error: saveErr } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) })
    .eq('id', siteId)
  if (saveErr) return c.json(dbError(), 500)
  return c.json({ ok: true })
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
    .maybeSingle()

  if (error) return c.json(dbError(), 500)
  if (!data) return c.json({ error: 'Turma não encontrada neste site.' }, 404)
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
  if (turmaErr) return c.json(dbError(), 500)
  if (!turma) return c.json({ error: 'Turma não encontrada neste site.' }, 404)

  const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', siteId).maybeSingle()
  const cms = parseCms(site)
  const [{ count: alunosCount, error: alunosErr }, { count: correcoesCount, error: corrErr }] = await Promise.all([
    sb.from('turma_alunos').select('id', { count: 'exact', head: true }).eq('site_id', siteId).eq('turma_id', turmaId),
    sb.from('correcoes').select('id', { count: 'exact', head: true }).eq('site_id', siteId).eq('turma_id', turmaId)
  ])

  if (alunosErr && !missingTurmaAlunos(alunosErr)) return c.json(dbError(), 500)
  if (corrErr) return c.json(dbError(), 500)

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
    if (hideCorrecoesErr) return c.json(dbError(), 500)
  }

  if (cms.turma_settings?.[turmaId]) {
    delete cms.turma_settings[turmaId]
    await sb.from('sites').update({ allowed_origins: withCmsOrigins(site?.allowed_origins || [], cms) }).eq('id', siteId)
  }

  const { error } = await sb.from('turmas').delete().eq('id', turmaId).eq('site_id', siteId)
  if (error) return c.json(dbError(), 500)
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
  if (error) return c.json(dbError(), 500)
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
  if (error) return c.json(dbError(), 500)
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
  if (error) return c.json(dbError(), 500)
  return c.json(data)
})

app.delete('/tipos-erro/:id', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const { error } = await sb.from('tipos_erro').delete()
    .eq('id', c.req.param('id')).eq('site_id', user.site_id)
  if (error) return c.json(dbError(), 500)
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
  if (catErr) return c.json(dbError(), 500)

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
  if (error) return c.json(dbError(), 500)
  return c.json({ ok: true })
})

export { app as adminRoutes }
