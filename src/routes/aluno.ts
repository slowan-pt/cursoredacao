import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { createToken } from '../auth'
import { requireAuth, requireRole } from '../middleware'
import { getConfig, sessionCookieOptions } from '../config'
import { dataUrlFromBytes, validateIncomingArquivo } from '../uploads'
import { getPrivateStorage, keyFromStoredObjectRef, storedObjectRef } from '../storage'

const app = new Hono<{ Bindings: Env }>()

function dbError() {
  return { error: 'Erro ao acessar os dados.' }
}

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
    video_courses: [] as any[],
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
      video_courses: Array.isArray(cms.video_courses) ? cms.video_courses : [],
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

function redacaoPeriodoDias(settings: any) {
  const periodicidade = String(settings?.limite_redacoes_periodicidade || 'SEMANA')
  if (periodicidade === 'DIA') return 1
  if (periodicidade === 'CUSTOM_DIAS') return Math.max(1, Math.floor(Number(settings?.limite_redacoes_periodo_dias) || 7))
  return 7
}

function redacaoPeriodoLabel(days: number) {
  if (days === 1) return 'por dia'
  if (days === 7) return 'por semana'
  return `a cada ${days} dias`
}

function periodoInicioIso(days: number) {
  const start = new Date()
  start.setDate(start.getDate() - Math.max(1, days))
  return start.toISOString()
}

function missingTurmaAlunos(error: any) {
  return /turma_alunos|relation .* does not exist|schema cache/i.test(String(error?.message || ''))
}

function missingStorageFiles(error: any) {
  return /storage_files|relation .* does not exist|schema cache/i.test(String(error?.message || ''))
}

function missingVideoTables(error: any) {
  return /video_course_enrollments|video_lesson_progress|video_lesson_notes|relation .* does not exist|schema cache/i.test(String(error?.message || ''))
}

function videoCoursesEnabled(env: Env) {
  return String(env.ENABLE_VIDEO_COURSES ?? 'true').toLowerCase() !== 'false'
}

function publicVideoCourses(cms: ReturnType<typeof parseCms>) {
  return (cms.video_courses || [])
    .filter((course: any) => course?.id && !['RASCUNHO', 'OCULTO'].includes(String(course.status || 'PUBLICADO').toUpperCase()))
    .sort((a: any, b: any) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
}

function sanitizeVideoCourse(course: any, enrollment: any = null, progress: any = null) {
  return {
    id: String(course.id || ''),
    title: String(course.title || 'Curso em vídeo'),
    summary: String(course.summary || course.description || ''),
    description: String(course.description || ''),
    cover_url: String(course.cover_url || ''),
    price: Number(course.price || 0),
    duration_hours: Number(course.duration_hours || 0),
    lessons_count: Number(course.lessons_count || 0),
    status: String(course.status || 'PUBLICADO'),
    pinned: Boolean(course.pinned),
    enrolled: Boolean(enrollment),
    enrollment_status: enrollment?.status || null,
    progress: progress ? {
      lesson_id: progress.lesson_id || 'principal',
      current_time_seconds: Number(progress.current_time_seconds || 0),
      duration_seconds: Number(progress.duration_seconds || 0),
      percent_watched: Number(progress.percent_watched || 0),
      completed: Boolean(progress.completed)
    } : null
  }
}

async function streamPlayback(course: any, env: Env, enrolled: boolean) {
  if (!enrolled) {
    return { available: false, reason: 'Matricule-se neste curso para liberar as aulas.' }
  }
  if (String(env.ENABLE_CLOUDFLARE_STREAM || 'false').toLowerCase() !== 'true') {
    return { available: false, reason: 'Player protegido ainda não está ativo para este ambiente.' }
  }
  if (!course?.stream_uid) {
    return { available: false, reason: 'Este curso ainda não possui vídeo configurado.' }
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_STREAM_TOKEN || !env.CLOUDFLARE_STREAM_CUSTOMER_CODE) {
    return { available: false, reason: 'Cloudflare Stream ainda precisa ser configurado neste ambiente.' }
  }
  const ttl = Math.max(60, Math.min(3600, Number(env.CLOUDFLARE_STREAM_TOKEN_TTL_SECONDS || 900)))
  const tokenRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/stream/${encodeURIComponent(String(course.stream_uid))}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_STREAM_TOKEN}`,
      'content-type': 'application/json;charset=UTF-8'
    },
    body: JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + ttl,
      downloadable: false
    })
  })
  if (!tokenRes.ok) {
    return { available: false, reason: 'Não foi possível gerar o acesso temporário ao vídeo.' }
  }
  const tokenPayload: any = await tokenRes.json().catch(() => ({}))
  const token = tokenPayload?.result?.token
  if (!token) {
    return { available: false, reason: 'Token temporário do vídeo não foi retornado pelo Stream.' }
  }
  return {
    available: true,
    provider: 'cloudflare_stream',
    expires_in_seconds: ttl,
    iframe_url: `https://customer-${encodeURIComponent(env.CLOUDFLARE_STREAM_CUSTOMER_CODE)}.cloudflarestream.com/${encodeURIComponent(token)}/iframe`
  }
}

function exactArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
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

async function storeCorrectionFile(
  env: Env,
  sb: ReturnType<typeof getAdmin>,
  input: {
    siteId: string
    turmaId: string
    alunoId: string
    correcaoId: string
    upload: { mime?: string; bytes?: Uint8Array }
    originalName?: string
  }
) {
  if (!input.upload.bytes || !input.upload.mime) return null
  const stored = await getPrivateStorage(env).put({
    siteId: input.siteId,
    turmaId: input.turmaId,
    alunoId: input.alunoId,
    correcaoId: input.correcaoId,
    mime: input.upload.mime,
    bytes: exactArrayBuffer(input.upload.bytes),
    originalName: input.originalName
  })
  const { error } = await sb.from('storage_files').insert({
    site_id: input.siteId,
    turma_id: input.turmaId,
    aluno_id: input.alunoId,
    correcao_id: input.correcaoId,
    object_key: stored.key,
    original_name: input.originalName || null,
    mime_type: stored.mime,
    size_bytes: stored.size,
    storage_provider: 'R2'
  })
  if (error) {
    await getPrivateStorage(env).delete(stored.key)
    if (missingStorageFiles(error)) {
      throw new Error('Rode a migration 004 no Supabase para ativar uploads privados.')
    }
    throw new Error(error.message)
  }
  return stored
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
  if (error) return c.json(dbError(), 500)
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
  return c.json(await hydrateArquivoUrl(c.env, data))
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
    if (matErr) return c.json(dbError(), 500)
    if (!matricula) return c.json({ error: 'Você precisa estar matriculado nesta turma para enviar redações.' }, 403)
  }

  const settings = cms.turma_settings?.[turma_id]
  if (settings?.envios_abertos === false) {
    return c.json({ error: 'O envio de redações está fechado para esta turma.' }, 403)
  }
  const limiteRedacoes = Math.max(1, Math.floor(Number(settings?.limite_redacoes_por_periodo ?? settings?.limite_redacoes_por_aluno) || 1))
  const periodoDias = redacaoPeriodoDias(settings)
  const { count: redacoesEnviadas, error: countErr } = await sb.from('correcoes')
    .select('id', { count: 'exact', head: true })
    .eq('site_id', profile.site_id)
    .eq('turma_id', turma_id)
    .eq('aluno_id', user.sub)
    .neq('status', 'EXCLUIDA_PELO_PROFESSOR')
    .gte('created_at', periodoInicioIso(periodoDias))
  if (countErr) return c.json(dbError(), 500)
  if ((redacoesEnviadas ?? 0) >= limiteRedacoes) {
    return c.json({ error: `Você já atingiu o limite de ${limiteRedacoes} redação(ões) ${redacaoPeriodoLabel(periodoDias)} nesta turma.` }, 403)
  }
  const credit = cms.student_credits?.[user.sub] || {}
  const creditosAtuais = Math.max(0, Number(credit.creditos) || 0)
  if (creditExpired(credit.vence_em)) {
    return c.json({ error: 'Seus créditos venceram. Fale com o professor para renovar o acesso.' }, 403)
  }
  if (creditosAtuais <= 0) {
    return c.json({ error: 'Você não possui créditos disponíveis para enviar redações.' }, 403)
  }

  const shouldStorePrivately = getConfig(c.env).flags.r2Uploads && !!upload.bytes && !!upload.mime
  const { data, error } = await sb.from('correcoes').insert({
    titulo,
    turma_id,
    aluno_id: user.sub,
    site_id: profile.site_id,
    arquivo_url: shouldStorePrivately ? '' : (arquivo_url || ''),
    tipo_arq: tipo_arq || upload.tipoArq || 'PDF',
    status: 'AGUARDANDO'
  }).select().single()

  if (error) return c.json(dbError(), 500)

  if (shouldStorePrivately) {
    let storedKey: string | null = null
    try {
      const stored = await storeCorrectionFile(c.env, sb, {
        siteId: profile.site_id,
        turmaId: turma_id,
        alunoId: user.sub,
        correcaoId: data.id,
        upload,
        originalName: typeof titulo === 'string' ? titulo : undefined
      })
      if (stored) {
        storedKey = stored.key
        const { data: updated, error: updateErr } = await sb.from('correcoes')
          .update({ arquivo_url: storedObjectRef(stored.key), updated_at: new Date().toISOString() })
          .eq('id', data.id)
          .select()
          .single()
        if (updateErr) throw new Error(updateErr.message)
        Object.assign(data, updated)
      }
    } catch (err: any) {
      if (storedKey) await getPrivateStorage(c.env).delete(storedKey)
      await sb.from('correcoes').delete().eq('id', data.id)
      return c.json({ error: err?.message || 'Não foi possível armazenar o arquivo enviado.' }, 500)
    }
  }

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
    .select('id, aluno_id, site_id, turma_id, arquivo_url, status')
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
      if (matErr) return c.json(dbError(), 500)
      if (!matricula) return c.json({ error: 'Você precisa estar matriculado nesta turma para usar este envio.' }, 403)
    }
    if (cms.turma_settings?.[body.turma_id]?.envios_abertos === false) {
      return c.json({ error: 'O envio de redações está fechado para esta turma.' }, 403)
    }
    patch.turma_id = body.turma_id
  }
  let newStoredKey: string | null = null
  if (typeof body.arquivo_url === 'string' && body.arquivo_url) {
    const upload = validateIncomingArquivo(c.env, body.arquivo_url)
    if (!upload.ok) return c.json({ error: upload.error }, 400)
    const targetTurmaId = String(patch.turma_id || atual.turma_id || '')
    if (getConfig(c.env).flags.r2Uploads && upload.bytes && upload.mime) {
      try {
        const stored = await storeCorrectionFile(c.env, sb, {
          siteId: atual.site_id,
          turmaId: targetTurmaId,
          alunoId: user.sub,
          correcaoId: atual.id,
          upload,
          originalName: typeof patch.titulo === 'string' ? patch.titulo : undefined
        })
        if (stored) {
          newStoredKey = stored.key
          patch.arquivo_url = storedObjectRef(stored.key)
        }
      } catch (err: any) {
        return c.json({ error: err?.message || 'Não foi possível armazenar o arquivo enviado.' }, 500)
      }
    } else {
      patch.arquivo_url = body.arquivo_url
    }
    patch.tipo_arq = body.tipo_arq || upload.tipoArq
  }

  if (!Object.keys(patch).length) return c.json({ error: 'Nada para atualizar.' }, 400)

  const { data, error } = await sb.from('correcoes')
    .update(patch)
    .eq('id', atual.id)
    .select()
    .single()

  if (error) {
    if (newStoredKey) await getPrivateStorage(c.env).delete(newStoredKey)
    return c.json(dbError(), 500)
  }
  const oldStoredKey = keyFromStoredObjectRef(atual.arquivo_url)
  if (newStoredKey && oldStoredKey && oldStoredKey !== newStoredKey) {
    await getPrivateStorage(c.env).delete(oldStoredKey)
    await sb.from('storage_files')
      .update({ status: 'DELETED', deleted_at: new Date().toISOString() })
      .eq('object_key', oldStoredKey)
  }
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
    if (matErr) return c.json(dbError(), 500)
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
  if (error) return c.json(dbError(), 500)
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
  if (error) return c.json(dbError(), 500)
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
    if (matErr) return c.json(dbError(), 500)
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
  if (turmaErr) return c.json(dbError(), 500)
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
    return c.json(dbError(), 500)
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
  if (save.error) return c.json(dbError(), 500)

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

app.get('/video-courses', async (c) => {
  if (!videoCoursesEnabled(c.env)) return c.json({ data: [], disabled: true })
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const { data: profile } = await sb.from('profiles').select('site_id').eq('id', user.sub).single()
  if (!profile?.site_id) return c.json({ data: [] })

  const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', profile.site_id).maybeSingle()
  const cms = parseCms(site)
  const courses = publicVideoCourses(cms)
  if (!courses.length) return c.json({ data: [] })

  const courseIds = courses.map((course: any) => String(course.id))
  const [{ data: enrollments, error: enrollmentErr }, { data: progress, error: progressErr }] = await Promise.all([
    sb.from('video_course_enrollments')
      .select('course_id, status, access_expires_at')
      .eq('site_id', profile.site_id)
      .eq('aluno_id', user.sub)
      .in('course_id', courseIds),
    sb.from('video_lesson_progress')
      .select('course_id, lesson_id, current_time_seconds, duration_seconds, percent_watched, completed')
      .eq('site_id', profile.site_id)
      .eq('aluno_id', user.sub)
      .in('course_id', courseIds)
  ])

  const enrollmentMap = new Map<string, any>()
  if (!enrollmentErr) {
    ;(enrollments || []).forEach((enrollment: any) => {
      const expired = enrollment.access_expires_at && new Date(enrollment.access_expires_at).getTime() < Date.now()
      if (enrollment.status === 'ACTIVE' && !expired) enrollmentMap.set(String(enrollment.course_id), enrollment)
    })
  } else if (!missingVideoTables(enrollmentErr)) {
    return c.json(dbError(), 500)
  }

  const progressMap = new Map<string, any>()
  if (!progressErr) {
    ;(progress || []).forEach((item: any) => progressMap.set(String(item.course_id), item))
  } else if (!missingVideoTables(progressErr)) {
    return c.json(dbError(), 500)
  }

  return c.json({
    data: courses.map((course: any) => sanitizeVideoCourse(course, enrollmentMap.get(String(course.id)), progressMap.get(String(course.id)))),
    storage_ready: !missingVideoTables(enrollmentErr) && !missingVideoTables(progressErr)
  })
})

app.get('/video-courses/:id', async (c) => {
  if (!videoCoursesEnabled(c.env)) return c.json({ error: 'Cursos em vídeo temporariamente indisponíveis.' }, 503)
  const courseId = c.req.param('id')
  const user = c.get('user')
  const sb = getAdmin(c.env)
  const { data: profile } = await sb.from('profiles').select('site_id').eq('id', user.sub).single()
  if (!profile?.site_id) return c.json({ error: 'Aluno sem site vinculado.' }, 400)

  const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', profile.site_id).maybeSingle()
  const cms = parseCms(site)
  const course = publicVideoCourses(cms).find((item: any) => String(item.id) === String(courseId))
  if (!course) return c.json({ error: 'Curso não encontrado neste site.' }, 404)

  const { data: enrollment, error: enrollmentErr } = await sb.from('video_course_enrollments')
    .select('course_id, status, access_expires_at')
    .eq('site_id', profile.site_id)
    .eq('aluno_id', user.sub)
    .eq('course_id', courseId)
    .maybeSingle()
  if (enrollmentErr && !missingVideoTables(enrollmentErr)) return c.json(dbError(), 500)

  const expired = enrollment?.access_expires_at && new Date(enrollment.access_expires_at).getTime() < Date.now()
  const enrolled = Boolean(enrollment && enrollment.status === 'ACTIVE' && !expired)
  if (!enrolled) {
    return c.json({
      course: sanitizeVideoCourse(course),
      stream: await streamPlayback(course, c.env, false),
      notes: [],
      locked: true
    }, 403)
  }

  const [{ data: progress, error: progressErr }, { data: notes, error: notesErr }] = await Promise.all([
    sb.from('video_lesson_progress')
      .select('lesson_id, current_time_seconds, duration_seconds, percent_watched, completed')
      .eq('site_id', profile.site_id)
      .eq('aluno_id', user.sub)
      .eq('course_id', courseId)
      .eq('lesson_id', 'principal')
      .maybeSingle(),
    sb.from('video_lesson_notes')
      .select('id, lesson_id, timestamp_seconds, note, created_at')
      .eq('site_id', profile.site_id)
      .eq('aluno_id', user.sub)
      .eq('course_id', courseId)
      .eq('lesson_id', 'principal')
      .order('created_at', { ascending: false })
  ])
  if (progressErr && !missingVideoTables(progressErr)) return c.json(dbError(), 500)
  if (notesErr && !missingVideoTables(notesErr)) return c.json(dbError(), 500)

  return c.json({
    course: sanitizeVideoCourse(course, enrollment, progress),
    stream: await streamPlayback(course, c.env, true),
    notes: notesErr ? [] : notes || []
  })
})

app.post('/video-courses/:id/progress', async (c) => {
  if (!videoCoursesEnabled(c.env)) return c.json({ error: 'Cursos em vídeo temporariamente indisponíveis.' }, 503)
  const courseId = c.req.param('id')
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const current = Math.max(0, Math.floor(Number(body.current_time_seconds) || 0))
  const duration = Math.max(0, Math.floor(Number(body.duration_seconds) || 0))
  const percent = duration > 0 ? Math.min(100, Math.round((current / duration) * 10000) / 100) : 0
  const sb = getAdmin(c.env)
  const { data: profile } = await sb.from('profiles').select('site_id').eq('id', user.sub).single()
  if (!profile?.site_id) return c.json({ error: 'Aluno sem site vinculado.' }, 400)

  const { data: enrollment, error: enrollmentErr } = await sb.from('video_course_enrollments')
    .select('status, access_expires_at')
    .eq('site_id', profile.site_id)
    .eq('aluno_id', user.sub)
    .eq('course_id', courseId)
    .maybeSingle()
  if (enrollmentErr) {
    if (missingVideoTables(enrollmentErr)) return c.json({ error: 'Progresso indisponível até a migration de cursos ser aplicada.' }, 503)
    return c.json(dbError(), 500)
  }
  const expired = enrollment?.access_expires_at && new Date(enrollment.access_expires_at).getTime() < Date.now()
  if (!enrollment || enrollment.status !== 'ACTIVE' || expired) return c.json({ error: 'Curso bloqueado para este aluno.' }, 403)

  const { error } = await sb.from('video_lesson_progress').upsert({
    site_id: profile.site_id,
    course_id: courseId,
    lesson_id: 'principal',
    aluno_id: user.sub,
    current_time_seconds: current,
    duration_seconds: duration,
    percent_watched: percent,
    completed: percent >= 90,
    updated_at: new Date().toISOString()
  }, { onConflict: 'site_id,course_id,lesson_id,aluno_id' })
  if (error) return c.json(dbError(), 500)
  return c.json({ ok: true, percent_watched: percent })
})

app.post('/video-courses/:id/notes', async (c) => {
  if (!videoCoursesEnabled(c.env)) return c.json({ error: 'Cursos em vídeo temporariamente indisponíveis.' }, 503)
  const courseId = c.req.param('id')
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({}))
  const note = String(body.note || '').trim()
  if (!note) return c.json({ error: 'Escreva uma anotação.' }, 400)
  if (note.length > 2000) return c.json({ error: 'A anotação deve ter até 2000 caracteres.' }, 400)
  const timestamp = Math.max(0, Math.floor(Number(body.timestamp_seconds) || 0))
  const sb = getAdmin(c.env)
  const { data: profile } = await sb.from('profiles').select('site_id').eq('id', user.sub).single()
  if (!profile?.site_id) return c.json({ error: 'Aluno sem site vinculado.' }, 400)

  const { data: enrollment, error: enrollmentErr } = await sb.from('video_course_enrollments')
    .select('status, access_expires_at')
    .eq('site_id', profile.site_id)
    .eq('aluno_id', user.sub)
    .eq('course_id', courseId)
    .maybeSingle()
  if (enrollmentErr) {
    if (missingVideoTables(enrollmentErr)) return c.json({ error: 'Anotações indisponíveis até a migration de cursos ser aplicada.' }, 503)
    return c.json(dbError(), 500)
  }
  const expired = enrollment?.access_expires_at && new Date(enrollment.access_expires_at).getTime() < Date.now()
  if (!enrollment || enrollment.status !== 'ACTIVE' || expired) return c.json({ error: 'Curso bloqueado para este aluno.' }, 403)

  const { error } = await sb.from('video_lesson_notes').insert({
    site_id: profile.site_id,
    course_id: courseId,
    lesson_id: 'principal',
    aluno_id: user.sub,
    timestamp_seconds: timestamp,
    note
  })
  if (error) return c.json(dbError(), 500)
  return c.json({ ok: true })
})

export { app as alunoRoutes }
