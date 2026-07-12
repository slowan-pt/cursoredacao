import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { createToken } from '../auth'
import { requireAuth, requireRole } from '../middleware'
import { getConfig, sessionCookieOptions } from '../config'
import { validateIncomingArquivo } from '../uploads'

const app = new Hono<{ Bindings: Env }>()

app.use('*', requireAuth, requireRole('ALUNO', 'ADMIN', 'SUPERADMIN'))
app.use('*', async (c, next) => {
  const user = c.get('user')
  if (user.role !== 'ALUNO') {
    await next()
    return
  }
  const sb = getAdmin(c.env)
  const { data: profile } = await sb.from('profiles').select('ativo, site_id').eq('id', user.sub).maybeSingle()
  if (!profile || profile.ativo === false) return c.json({ error: 'Acesso bloqueado. Fale com o professor responsável pelo site.' }, 403)
  if (profile.site_id) {
    const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', profile.site_id).maybeSingle()
    const cms = parseCms(site)
    if (cms.blocked_students?.[user.sub] || cms.deleted_students?.[user.sub]) {
      return c.json({ error: 'Acesso bloqueado. Fale com o professor responsável pelo site.' }, 403)
    }
  }
  await next()
})

const CMS_PREFIX = 'CMS:'

function defaultCms() {
  return {
    turma_settings: {} as Record<string, { matriculas_abertas?: boolean; envios_abertos?: boolean }>,
    themes: [] as any[],
    student_credits: {} as Record<string, { creditos?: number; vence_em?: string | null; updated_at?: string }>,
    enrollments: {} as Record<string, Record<string, { ativo?: boolean; origem?: string; created_at?: string; updated_at?: string }>>,
    blocked_students: {} as Record<string, any>,
    deleted_students: {} as Record<string, any>
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
      turma_settings: cms.turma_settings && typeof cms.turma_settings === 'object' ? cms.turma_settings : {},
      themes: Array.isArray(cms.themes) ? cms.themes : [],
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

function creditExpired(venceEm?: string | null) {
  if (!venceEm) return false
  const end = new Date(`${venceEm}T23:59:59`)
  return Number.isFinite(end.getTime()) && end.getTime() < Date.now()
}

function missingTurmaAlunos(error: any) {
  return /turma_alunos|relation .* does not exist|schema cache/i.test(String(error?.message || ''))
}

function cmsEnrollmentActive(cms: ReturnType<typeof parseCms>, turmaId: string, alunoId: string) {
  return cms.enrollments?.[turmaId]?.[alunoId]?.ativo !== false && !!cms.enrollments?.[turmaId]?.[alunoId]
}

async function saveCms(env: Env, siteId: string, cms: ReturnType<typeof parseCms>) {
  const sb = getAdmin(env)
  const { data: site, error: siteErr } = await sb.from('sites').select('allowed_origins').eq('id', siteId).single()
  if (siteErr) return { error: siteErr }
  const { error } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) })
    .eq('id', siteId)
  return { error }
}

app.get('/stats', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)

  const [enviadas, corrigidas, profileRes] = await Promise.all([
    sb.from('correcoes').select('id', { count: 'exact', head: true }).eq('aluno_id', user.sub).neq('status', 'EXCLUIDA_PELO_PROFESSOR'),
    sb.from('correcoes').select('id', { count: 'exact', head: true })
      .eq('aluno_id', user.sub).eq('status', 'FINALIZADA'),
    sb.from('profiles').select('site_id').eq('id', user.sub).maybeSingle()
  ])

  const { data: notas } = await sb.from('correcoes')
    .select('nota').eq('aluno_id', user.sub).eq('status', 'FINALIZADA').not('nota', 'is', null)

  const media = notas && notas.length > 0
    ? (notas.reduce((s, r) => s + (r.nota ?? 0), 0) / notas.length).toFixed(1)
    : null

  let creditosInfo = { creditos: 0, vence_em: null as string | null, expirado: false }
  if (profileRes.data?.site_id) {
    const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', profileRes.data.site_id).maybeSingle()
    const raw = parseCms(site).student_credits?.[user.sub] || {}
    creditosInfo = {
      creditos: Math.max(0, Number(raw.creditos) || 0),
      vence_em: raw.vence_em || null,
      expirado: creditExpired(raw.vence_em)
    }
  }

  return c.json({ enviadas: enviadas.count ?? 0, corrigidas: corrigidas.count ?? 0, media, aprovado: user.ativo !== false, creditos_info: creditosInfo })
})

app.get('/correcoes', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const { data, error } = await sb.from('correcoes')
    .select('id, titulo, status, nota, nota_max, created_at, finalizada_em')
    .eq('aluno_id', user.sub)
    .neq('status', 'EXCLUIDA_PELO_PROFESSOR')
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data })
})

app.get('/correcoes/:id', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const { data, error } = await sb.from('correcoes')
    .select('*, anotacoes(*)')
    .eq('id', c.req.param('id'))
    .eq('aluno_id', user.sub)
    .neq('status', 'EXCLUIDA_PELO_PROFESSOR')
    .single()
  if (error || !data) return c.json({ error: 'Correção não encontrada para este aluno.' }, 404)
  return c.json(data)
})

app.post('/correcoes', async (c) => {
  const user = c.get('user')
  if (user.role === 'ALUNO' && user.ativo === false) {
    return c.json({ error: 'Seu acesso ainda precisa ser aprovado pelo professor antes de enviar redações.' }, 403)
  }

  const { titulo, turma_id, arquivo_url, tipo_arq } = await c.req.json()
  if (!turma_id) {
    return c.json({ error: 'Escolha uma turma antes de enviar a redação.' }, 400)
  }
  const upload = validateIncomingArquivo(c.env, arquivo_url)
  if (!upload.ok) return c.json({ error: upload.error }, 400)

  const sb = getAdmin(c.env)

  const { data: profile } = await sb.from('profiles').select('site_id').eq('id', user.sub).single()
  if (!profile?.site_id) return c.json({ error: 'Aluno sem site vinculado.' }, 400)

  const [{ data: turma, error: turmaErr }, { data: matricula, error: matErr }, { data: site }] = await Promise.all([
    sb.from('turmas')
    .select('id')
    .eq('id', turma_id)
    .eq('site_id', profile.site_id)
    .eq('status', 'ABERTA')
    .single()
    ,
    sb.from('turma_alunos')
      .select('id, ativo')
      .eq('site_id', profile.site_id)
      .eq('turma_id', turma_id)
      .eq('aluno_id', user.sub)
      .eq('ativo', true)
      .maybeSingle(),
    sb.from('sites').select('allowed_origins').eq('id', profile.site_id).maybeSingle()
  ])

  if (turmaErr || !turma) {
    return c.json({ error: 'Turma inválida ou indisponível para este aluno.' }, 400)
  }
  const cms = parseCms(site)
  if (missingTurmaAlunos(matErr)) {
    if (!cmsEnrollmentActive(cms, turma_id, user.sub)) {
      return c.json({ error: 'Você precisa estar matriculado nesta turma para enviar redações.' }, 403)
    }
  } else {
    if (matErr) return c.json({ error: matErr.message }, 500)
    if (!matricula) return c.json({ error: 'Você precisa estar matriculado nesta turma para enviar redações.' }, 403)
  }

  const settings = cms.turma_settings?.[turma_id]
  if (settings?.envios_abertos === false) {
    return c.json({ error: 'O envio de redações está fechado para esta turma.' }, 403)
  }
  const credit = cms.student_credits?.[user.sub] || {}
  const creditosAtuais = Math.max(0, Number(credit.creditos) || 0)
  if (creditExpired(credit.vence_em)) {
    return c.json({ error: 'Seus créditos venceram. Fale com o professor para renovar o acesso.' }, 403)
  }
  if (creditosAtuais <= 0) {
    return c.json({ error: 'Você não possui créditos disponíveis para enviar redações.' }, 403)
  }

  const { data, error } = await sb.from('correcoes').insert({
    titulo,
    turma_id,
    aluno_id: user.sub,
    site_id: profile.site_id,
    arquivo_url: arquivo_url || '',
    tipo_arq: tipo_arq || upload.tipoArq || 'PDF',
    status: 'AGUARDANDO'
  }).select().single()

  if (error) return c.json({ error: error.message }, 500)
  cms.student_credits = {
    ...(cms.student_credits || {}),
    [user.sub]: {
      ...credit,
      creditos: Math.max(0, creditosAtuais - 1),
      vence_em: credit.vence_em || null,
      updated_at: new Date().toISOString()
    }
  }
  await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site?.allowed_origins, cms) })
    .eq('id', profile.site_id)
  return c.json(data, 201)
})

app.patch('/correcoes/:id', async (c) => {
  const user = c.get('user')
  if (user.role === 'ALUNO' && user.ativo === false) {
    return c.json({ error: 'Seu acesso ainda precisa ser aprovado pelo professor.' }, 403)
  }

  const body = await c.req.json()
  const sb = getAdmin(c.env)

  const { data: atual, error: atualErr } = await sb.from('correcoes')
    .select('id, aluno_id, site_id, status')
    .eq('id', c.req.param('id'))
    .eq('aluno_id', user.sub)
    .single()

  if (atualErr || !atual) return c.json({ error: 'Envio não encontrado para este aluno.' }, 404)
  if (atual.status !== 'AGUARDANDO') {
    return c.json({ error: 'Só é possível editar redações que ainda estão aguardando correção.' }, 400)
  }

  const patch: Record<string, unknown> = {}
  if (typeof body.titulo === 'string' && body.titulo.trim()) patch.titulo = body.titulo.trim()
  if (typeof body.turma_id === 'string' && body.turma_id.trim()) {
    const [{ data: turma, error: turmaErr }, { data: matricula, error: matErr }, { data: site }] = await Promise.all([
      sb.from('turmas')
      .select('id')
      .eq('id', body.turma_id)
      .eq('site_id', atual.site_id)
      .eq('status', 'ABERTA')
      .single()
      ,
      sb.from('turma_alunos')
        .select('id, ativo')
        .eq('site_id', atual.site_id)
        .eq('turma_id', body.turma_id)
        .eq('aluno_id', user.sub)
        .eq('ativo', true)
        .maybeSingle(),
      sb.from('sites').select('allowed_origins').eq('id', atual.site_id).maybeSingle()
    ])
    if (turmaErr || !turma) return c.json({ error: 'Turma inválida ou indisponível para este aluno.' }, 400)
    const cms = parseCms(site)
    if (missingTurmaAlunos(matErr)) {
      if (!cmsEnrollmentActive(cms, body.turma_id, user.sub)) {
        return c.json({ error: 'Você precisa estar matriculado nesta turma para usar este envio.' }, 403)
      }
    } else {
      if (matErr) return c.json({ error: matErr.message }, 500)
      if (!matricula) return c.json({ error: 'Você precisa estar matriculado nesta turma para usar este envio.' }, 403)
    }
    if (cms.turma_settings?.[body.turma_id]?.envios_abertos === false) {
      return c.json({ error: 'O envio de redações está fechado para esta turma.' }, 403)
    }
    patch.turma_id = body.turma_id
  }
  if (typeof body.arquivo_url === 'string' && body.arquivo_url) {
    const upload = validateIncomingArquivo(c.env, body.arquivo_url)
    if (!upload.ok) return c.json({ error: upload.error }, 400)
    patch.arquivo_url = body.arquivo_url
    patch.tipo_arq = body.tipo_arq || upload.tipoArq
  }

  if (!Object.keys(patch).length) return c.json({ error: 'Nada para atualizar.' }, 400)

  const { data, error } = await sb.from('correcoes')
    .update(patch)
    .eq('id', atual.id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

app.get('/turmas', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const { data: profile } = await sb.from('profiles').select('site_id').eq('id', user.sub).single()
  if (!profile?.site_id) return c.json({ data: [] })

  const { data: matriculas, error: matErr } = await sb.from('turma_alunos')
    .select('turma_id')
    .eq('site_id', profile.site_id)
    .eq('aluno_id', user.sub)
    .eq('ativo', true)
  let ids: string[] = []
  let cmsFromSite: ReturnType<typeof parseCms> | null = null
  if (missingTurmaAlunos(matErr)) {
    const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', profile.site_id).maybeSingle()
    cmsFromSite = parseCms(site)
    ids = Object.entries(cmsFromSite.enrollments || {})
      .filter(([, alunosById]: [string, any]) => alunosById?.[user.sub]?.ativo !== false && !!alunosById?.[user.sub])
      .map(([turmaId]) => turmaId)
  } else {
    if (matErr) return c.json({ error: matErr.message }, 500)
    ids = Array.from(new Set((matriculas ?? []).map((m) => m.turma_id).filter(Boolean)))
  }
  if (!ids.length) return c.json({ data: [] })

  const [{ data, error }, { data: site }] = await Promise.all([
    sb.from('turmas')
      .select('id, nome, concurso, descricao, status, preco')
      .eq('site_id', profile.site_id)
      .eq('status', 'ABERTA')
      .in('id', ids),
    sb.from('sites').select('allowed_origins').eq('id', profile.site_id).maybeSingle()
  ])
  if (error) return c.json({ error: error.message }, 500)
  const cms = cmsFromSite || parseCms(site)
  return c.json({
    data: (data ?? []).map((t) => ({
      ...t,
      envios_abertos: cms.turma_settings?.[t.id]?.envios_abertos !== false,
      temas: (cms.themes || [])
        .filter((tema: any) => tema.status === 'DISPONIVEL' && Array.isArray(tema.turmas) && tema.turmas.includes(t.id))
        .map((tema: any) => ({
          id: tema.id,
          titulo: tema.titulo,
          comando: tema.comando,
          tags: tema.tags,
          modo_id: tema.modo_id
        }))
    }))
  })
})

app.get('/turmas-disponiveis', async (c) => {
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const { data: profile } = await sb.from('profiles').select('site_id').eq('id', user.sub).single()
  if (!profile?.site_id) return c.json({ data: [] })

  const [{ data: turmas, error }, { data: site }] = await Promise.all([
    sb.from('turmas')
      .select('id, nome, concurso, descricao, status, preco')
      .eq('site_id', profile.site_id)
      .eq('status', 'ABERTA')
      .order('created_at', { ascending: false }),
    sb.from('sites').select('allowed_origins').eq('id', profile.site_id).maybeSingle()
  ])
  if (error) return c.json({ error: error.message }, 500)
  const cms = parseCms(site)

  let enrolledIds = new Set<string>()
  const { data: matriculas, error: matErr } = await sb.from('turma_alunos')
    .select('turma_id')
    .eq('site_id', profile.site_id)
    .eq('aluno_id', user.sub)
    .eq('ativo', true)
  if (missingTurmaAlunos(matErr)) {
    enrolledIds = new Set(Object.entries(cms.enrollments || {})
      .filter(([, alunosById]: [string, any]) => alunosById?.[user.sub]?.ativo !== false && !!alunosById?.[user.sub])
      .map(([turmaId]) => turmaId))
  } else {
    if (matErr) return c.json({ error: matErr.message }, 500)
    enrolledIds = new Set((matriculas ?? []).map((m) => m.turma_id).filter(Boolean))
  }

  return c.json({
    data: (turmas ?? []).map((t) => ({
      ...t,
      matriculas_abertas: cms.turma_settings?.[t.id]?.matriculas_abertas !== false,
      envios_abertos: cms.turma_settings?.[t.id]?.envios_abertos !== false,
      matriculado: enrolledIds.has(t.id)
    }))
  })
})

app.post('/matriculas/pagar', async (c) => {
  if (!getConfig(c.env).flags.payments) {
    return c.json({ error: 'Pagamentos temporariamente indisponíveis.' }, 503)
  }

  const user = c.get('user')
  if (user.role === 'ALUNO' && user.ativo === false) {
    // Pagamento simulado libera o aluno automaticamente para as turmas pagas.
  }
  const body = await c.req.json()
  const turmaIds: string[] = Array.isArray(body.turma_ids) ? Array.from(new Set(body.turma_ids.map(String).filter(Boolean))) : []
  if (!turmaIds.length) return c.json({ error: 'Selecione ao menos uma turma.' }, 400)

  const sb = getAdmin(c.env)
  const { data: profile } = await sb.from('profiles').select('site_id').eq('id', user.sub).single()
  if (!profile?.site_id) return c.json({ error: 'Aluno sem site vinculado.' }, 400)

  const [{ data: turmas, error: turmaErr }, { data: site }] = await Promise.all([
    sb.from('turmas')
      .select('id, nome, preco, status')
      .eq('site_id', profile.site_id)
      .eq('status', 'ABERTA')
      .in('id', turmaIds),
    sb.from('sites').select('allowed_origins').eq('id', profile.site_id).maybeSingle()
  ])
  if (turmaErr) return c.json({ error: turmaErr.message }, 500)
  if ((turmas ?? []).length !== turmaIds.length) return c.json({ error: 'Uma ou mais turmas não estão disponíveis.' }, 400)

  const cms = parseCms(site)
  const closed = (turmas ?? []).filter((t) => cms.turma_settings?.[t.id]?.matriculas_abertas === false)
  if (closed.length) return c.json({ error: `Matrículas fechadas para: ${closed.map((t) => t.nome).join(', ')}` }, 403)

  const rows = turmaIds.map((turma_id) => ({
    site_id: profile.site_id,
    turma_id,
    aluno_id: user.sub,
    ativo: true,
    origem: 'PAGAMENTO_SIMULADO'
  }))
  const { error: upsertErr } = await sb.from('turma_alunos')
    .upsert(rows, { onConflict: 'turma_id,aluno_id' })

  if (missingTurmaAlunos(upsertErr)) {
    cms.enrollments = cms.enrollments || {}
    turmaIds.forEach((turmaId) => {
      cms.enrollments[turmaId] = {
        ...(cms.enrollments[turmaId] || {}),
        [user.sub]: {
          ativo: true,
          origem: 'PAGAMENTO_SIMULADO',
          created_at: cms.enrollments[turmaId]?.[user.sub]?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }
    })
  } else if (upsertErr) {
    return c.json({ error: upsertErr.message }, 500)
  }

  const total = (turmas ?? []).reduce((sum, t) => sum + Number(t.preco || 0), 0)
  const currentCredit = cms.student_credits?.[user.sub] || {}
  const currentAmount = Math.max(0, Number(currentCredit.creditos) || 0)
  const creditosAdicionados = Math.max(1, turmaIds.length * 10)
  const vence = new Date()
  vence.setFullYear(vence.getFullYear() + 1)
  cms.student_credits = {
    ...(cms.student_credits || {}),
    [user.sub]: {
      ...currentCredit,
      creditos: currentAmount + creditosAdicionados,
      vence_em: vence.toISOString().slice(0, 10),
      updated_at: new Date().toISOString()
    }
  }

  const save = await saveCms(c.env, profile.site_id, cms)
  if (save.error) return c.json({ error: save.error.message }, 500)

  await sb.from('profiles').update({ ativo: true }).eq('id', user.sub).eq('role', 'ALUNO')
  const config = getConfig(c.env)
  const token = await createToken(
    {
      sub: user.sub,
      email: user.email,
      role: user.role,
      site_id: profile.site_id,
      nome: user.nome,
      ativo: true
    },
    config.sessionSecret,
    config.sessionTtlSeconds
  )
  setCookie(c, 'auth_token', token, sessionCookieOptions(c.env))

  return c.json({
    ok: true,
    status: 'PAGAMENTO_APROVADO_SIMULADO',
    turmas: turmas ?? [],
    total,
    creditos_adicionados: creditosAdicionados
  })
})

export { app as alunoRoutes }
