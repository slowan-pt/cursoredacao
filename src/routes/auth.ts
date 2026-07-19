import { Hono } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import type { Env } from '../types'
import { getAdmin, getClient } from '../supabase'
import { createToken } from '../auth'
import { requireAuth } from '../middleware'
import { expiredSessionCookieOptions, getConfig, sessionCookieOptions } from '../config'
import { getEmailProvider, renderPasswordRecoveryEmail } from '../email'
import { checkRateLimit, rateLimitKey } from '../rateLimit'

const auth = new Hono<{ Bindings: Env }>()
const CMS_PREFIX = 'CMS:'

function dbError() {
  return { error: 'Erro ao acessar os dados.' }
}

function parseCms(site: any) {
  const raw = (site?.allowed_origins || []).find((item: string) => String(item).startsWith(CMS_PREFIX))
  const base = {
    student_credits: {} as Record<string, { creditos?: number; vence_em?: string | null; updated_at?: string }>,
    enrollments: {} as Record<string, Record<string, { ativo?: boolean; origem?: string; created_at?: string; updated_at?: string }>>,
    checkout_leads: {} as Record<string, any>,
    blocked_students: {} as Record<string, any>,
    deleted_students: {} as Record<string, any>
  }
  if (!raw) return base
  try {
    const cms = JSON.parse(String(raw).slice(CMS_PREFIX.length))
    return {
      ...cms,
      student_credits: cms.student_credits && typeof cms.student_credits === 'object' ? cms.student_credits : {},
      enrollments: cms.enrollments && typeof cms.enrollments === 'object' ? cms.enrollments : {},
      checkout_leads: cms.checkout_leads && typeof cms.checkout_leads === 'object' ? cms.checkout_leads : {},
      blocked_students: cms.blocked_students && typeof cms.blocked_students === 'object' ? cms.blocked_students : {},
      deleted_students: cms.deleted_students && typeof cms.deleted_students === 'object' ? cms.deleted_students : {}
    }
  } catch {
    return base
  }
}

function withCmsOrigins(origins: string[] | null | undefined, cms: unknown) {
  const keep = (origins || []).filter((item) => !String(item).startsWith(CMS_PREFIX))
  return [...keep, `${CMS_PREFIX}${JSON.stringify(cms)}`]
}

function missingTurmaAlunos(error: any) {
  return /turma_alunos|relation .* does not exist|schema cache/i.test(String(error?.message || ''))
}

function missingVideoTables(error: any) {
  return /video_course_enrollments|relation .* does not exist|schema cache/i.test(String(error?.message || ''))
}

function isPaidStatus(status: unknown) {
  return ['CONFIRMED', 'RECEIVED'].includes(String(status || '').toUpperCase())
}

function onlyDigits(value: unknown) {
  return String(value || '').replace(/\D/g, '')
}

function isValidCpf(value: unknown) {
  const cpf = onlyDigits(value)
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false
  const calc = (base: string, factor: number) => {
    const sum = base.split('').reduce((total, digit) => total + Number(digit) * factor--, 0)
    const rest = (sum * 10) % 11
    return rest === 10 ? 0 : rest
  }
  return calc(cpf.slice(0, 9), 10) === Number(cpf[9]) && calc(cpf.slice(0, 10), 11) === Number(cpf[10])
}

function recoveryRedirectUrl(input: { redirect_to?: string; site_slug?: string }, baseUrl: string) {
  const base = baseUrl || 'https://redacaocomestrategia.com.br'
  if (input.redirect_to) {
    const parsed = new URL(input.redirect_to, base)
    return new URL(`${parsed.pathname}${parsed.search}`, base).toString()
  }
  return input.site_slug
    ? new URL(`/redacao/${encodeURIComponent(input.site_slug)}/login`, base).toString()
    : new URL('/login', base).toString()
}

async function validateCheckoutCodeForRegistration(env: Env, siteId: string, email: string, cpf: string, turmaId?: string, checkoutCode?: string, options: { product?: string; courseId?: string } = {}) {
  const product = String(options.product || 'turma').toLowerCase()
  const courseId = String(options.courseId || '').trim()
  if (product === 'video') {
    if (!courseId) return { ok: false, error: 'Escolha um curso em vídeo e finalize o pagamento antes de criar o cadastro.' }
  } else if (!turmaId) {
    return { ok: false, error: 'Escolha uma turma e finalize o pagamento antes de criar o cadastro.' }
  }
  const code = String(checkoutCode || '').trim().toUpperCase()
  if (!code) return { ok: false, error: 'Informe o código do pagamento enviado para este e-mail.' }

  const sb = getAdmin(env)
  const { data: site, error } = await sb.from('sites').select('allowed_origins').eq('id', siteId).single()
  if (error || !site) return { ok: false, error: error?.message || 'Site não encontrado.' }
  const cms = parseCms(site)
  const leadMatchesCpf = (lead: any) => !lead?.cpf || onlyDigits(lead.cpf) === cpf
  const cmsMatch = Object.values(cms.checkout_leads || {}).some((lead: any) =>
    String(lead?.email || '').toLowerCase() === email &&
    (product === 'video' ? String(lead?.course_id || '') === courseId : String(lead?.turma_id || '') === String(turmaId)) &&
    lead?.status === 'PAGAMENTO_APROVADO_SIMULADO' &&
    String(lead?.checkout_code || lead?.code || '').trim().toUpperCase() === code &&
    leadMatchesCpf(lead)
  )
  if (cmsMatch) return { ok: true }
  const paymentQuery = sb.from('payments')
    .select('status, raw_summary')
    .eq('site_id', siteId)
    .eq('payer_email', email)
    .eq('checkout_code', code)
    .eq('product_type', product === 'video' ? 'VIDEO_COURSE' : 'TURMA')
  if (product === 'video') {
    paymentQuery.eq('course_id', courseId)
  } else {
    paymentQuery.eq('turma_id', turmaId)
  }
  const { data: paymentRows, error: payErr } = await paymentQuery
    .order('created_at', { ascending: false })
    .limit(1)
  const payment = paymentRows?.[0] || null
  if (payErr) return { ok: false, error: payErr.message }
  if (payment && product === 'video' && String((payment.raw_summary as any)?.course_id || '') !== courseId) {
    return { ok: false, error: 'Curso do pagamento não corresponde ao link informado.' }
  }
  const paymentCpf = onlyDigits((payment?.raw_summary as any)?.cpf)
  if (payment && paymentCpf && paymentCpf !== cpf) {
    return { ok: false, error: 'CPF não corresponde ao pagamento informado.' }
  }
  return payment && isPaidStatus(payment.status)
    ? { ok: true }
    : { ok: false, error: 'Código de pagamento inválido ou ainda não confirmado para este e-mail.' }
}

async function applyPaidCheckoutForStudent(
  env: Env,
  siteId: string,
  userId: string,
  email: string,
  options: { checkoutCode?: string; turmaId?: string; courseId?: string; product?: string; requireCode?: boolean } = {}
) {
  const sb = getAdmin(env)
  const { data: site, error: siteErr } = await sb.from('sites').select('allowed_origins').eq('id', siteId).single()
  if (siteErr || !site) return { activated: false, error: siteErr }
  const cms = parseCms(site)
  const normalizedCode = String(options.checkoutCode || '').trim().toUpperCase()
  const product = String(options.product || 'turma').toLowerCase()
  const courseId = String(options.courseId || '').trim()
  if (product === 'video') {
    const paymentQuery = sb.from('payments')
      .select('id, course_id, checkout_code, status')
      .eq('site_id', siteId)
      .eq('payer_email', email)
      .eq('product_type', 'VIDEO_COURSE')
      .in('status', ['CONFIRMED', 'RECEIVED'])
    if (courseId) paymentQuery.eq('course_id', courseId)
    const { data: realPaidRows, error: realPaidErr } = await paymentQuery
    if (realPaidErr) return { activated: false, error: realPaidErr }
    const realPaid = (realPaidRows || []).filter((payment: any) => {
      if (!options.requireCode) return true
      return String(payment.checkout_code || '').trim().toUpperCase() === normalizedCode
    })
    if (options.requireCode && !realPaid.length) {
      return { activated: false, error: { message: 'Pagamento não encontrado para este e-mail e curso.' } }
    }
    const rows = realPaid.map((payment: any) => ({
      site_id: siteId,
      course_id: payment.course_id,
      aluno_id: userId,
      payment_id: payment.id,
      status: 'ACTIVE',
      updated_at: new Date().toISOString()
    }))
    const { error: videoErr } = rows.length
      ? await sb.from('video_course_enrollments').upsert(rows, { onConflict: 'site_id,course_id,aluno_id' })
      : { error: null }
    if (videoErr) {
      if (missingVideoTables(videoErr)) return { activated: false, error: { message: 'Tabelas de cursos em vídeo ainda não foram aplicadas.' } }
      return { activated: false, error: videoErr }
    }
    if (realPaid.length) {
      await sb.from('payments')
        .update({ aluno_id: userId, updated_at: new Date().toISOString() })
        .in('id', realPaid.map((payment: any) => payment.id))
    }
    for (const [key, lead] of Object.entries(cms.checkout_leads || {})) {
      if (
        String((lead as any)?.email || '').toLowerCase() === email &&
        String((lead as any)?.product_type || '').toUpperCase() === 'VIDEO_COURSE' &&
        realPaid.some((payment: any) => String(payment.course_id || '') === String((lead as any)?.course_id || ''))
      ) {
        cms.checkout_leads[key] = { ...(lead as any), user_id: userId, status: 'MATRICULA_ATIVADA', updated_at: new Date().toISOString() }
      }
    }
    const { error: saveErr } = await sb.from('sites')
      .update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) })
      .eq('id', siteId)
    if (saveErr) return { activated: false, error: saveErr }
    await sb.from('profiles').update({ ativo: true }).eq('id', userId).eq('role', 'ALUNO')
    return { activated: true, courseIds: realPaid.map((payment: any) => payment.course_id) }
  }
  const allPaid = Object.values(cms.checkout_leads || {})
    .filter((lead: any) => String(lead?.email || '').toLowerCase() === email && lead?.status === 'PAGAMENTO_APROVADO_SIMULADO')
    .filter((lead: any) => !options.turmaId || String(lead?.turma_id || '') === String(options.turmaId))
  const paymentQuery = sb.from('payments')
    .select('id, turma_id, checkout_code, status')
    .eq('site_id', siteId)
    .eq('payer_email', email)
    .in('status', ['CONFIRMED', 'RECEIVED'])
  if (options.turmaId) paymentQuery.eq('turma_id', options.turmaId)
  const { data: realPaidRows, error: realPaidErr } = await paymentQuery
  if (realPaidErr) return { activated: false, error: realPaidErr }
  const realPaid = (realPaidRows || []).filter((payment: any) => {
    if (!options.requireCode) return true
    return String(payment.checkout_code || '').trim().toUpperCase() === normalizedCode
  })
  const paid = options.requireCode
    ? allPaid.filter((lead: any) => String(lead?.checkout_code || lead?.code || '').trim().toUpperCase() === normalizedCode)
    : allPaid
  if (options.requireCode && (allPaid.length || realPaidRows?.length) && !paid.length && !realPaid.length) {
    return { activated: false, error: { message: 'Código de pagamento inválido para este e-mail.' } }
  }
  if (options.requireCode && !allPaid.length && !realPaid.length) {
    return { activated: false, error: { message: 'Pagamento não encontrado para este e-mail e turma.' } }
  }
  const turmaIds = Array.from(new Set([
    ...paid.map((lead: any) => String(lead.turma_id || '')).filter(Boolean),
    ...realPaid.map((payment: any) => String(payment.turma_id || '')).filter(Boolean)
  ]))
  if (!turmaIds.length) return { activated: false }

  const rows = turmaIds.map((turma_id) => ({
    site_id: siteId,
    turma_id,
    aluno_id: userId,
    ativo: true,
    origem: realPaid.some((payment: any) => String(payment.turma_id || '') === turma_id) ? 'ASAAS_CHECKOUT' : 'PAGAMENTO_SIMULADO_PUBLICO'
  }))
  const { error: upsertErr } = await sb.from('turma_alunos').upsert(rows, { onConflict: 'turma_id,aluno_id' })
  if (missingTurmaAlunos(upsertErr)) {
    turmaIds.forEach((turmaId) => {
      cms.enrollments[turmaId] = {
        ...(cms.enrollments[turmaId] || {}),
        [userId]: {
          ativo: true,
          origem: realPaid.some((payment: any) => String(payment.turma_id || '') === turmaId) ? 'ASAAS_CHECKOUT' : 'PAGAMENTO_SIMULADO_PUBLICO',
          created_at: cms.enrollments[turmaId]?.[userId]?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }
    })
  } else if (upsertErr) {
    return { activated: false, error: upsertErr }
  }
  if (realPaid.length) {
    await sb.from('payments')
      .update({ aluno_id: userId, updated_at: new Date().toISOString() })
      .in('id', realPaid.map((payment: any) => payment.id))
  }

  const currentCredit = cms.student_credits?.[userId] || {}
  const currentAmount = Math.max(0, Number(currentCredit.creditos) || 0)
  const vence = new Date()
  vence.setFullYear(vence.getFullYear() + 1)
  cms.student_credits = {
    ...(cms.student_credits || {}),
    [userId]: {
      ...currentCredit,
      creditos: currentAmount + Math.max(1, turmaIds.length * 10),
      vence_em: vence.toISOString().slice(0, 10),
      updated_at: new Date().toISOString()
    }
  }
  for (const [key, lead] of Object.entries(cms.checkout_leads || {})) {
    if (String((lead as any)?.email || '').toLowerCase() === email && turmaIds.includes(String((lead as any)?.turma_id || ''))) {
      cms.checkout_leads[key] = { ...(lead as any), user_id: userId, status: 'MATRICULA_ATIVADA', updated_at: new Date().toISOString() }
    }
  }
  const { error: saveErr } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) })
    .eq('id', siteId)
  if (saveErr) return { activated: false, error: saveErr }
  await sb.from('profiles').update({ ativo: true }).eq('id', userId).eq('role', 'ALUNO')
  return { activated: true, turmaIds }
}

auth.post('/login', async (c) => {
  if (!checkRateLimit(rateLimitKey(c, 'login'), 10, 60_000)) {
    return c.json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }, 429)
  }
  let body: { email: string; password: string; site_slug?: string; site_id?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Corpo inválido' }, 400)
  }

  const { email, password } = body
  if (!email || !password) return c.json({ error: 'Email e senha obrigatórios' }, 400)

  // anon key para autenticar o usuário (padrão Supabase)
  const anonClient = getClient(c.env)
  const { data, error } = await anonClient.auth.signInWithPassword({ email, password })
  if (error) return c.json({ error: 'Email ou senha inválidos' }, 401)

  // service role para buscar o perfil (bypassa RLS)
  const adminClient = getAdmin(c.env)
  const { data: profile, error: pErr } = await adminClient
    .from('profiles')
    .select('role, site_id, nome, ativo')
    .eq('id', data.user.id)
    .single()

  if (pErr || !profile) return c.json({ error: 'Perfil não encontrado' }, 401)

  let requestedSiteId = body.site_id || null
  let requestedSiteSlug = body.site_slug || ''
  if (!requestedSiteId && requestedSiteSlug) {
    const { data: site } = await adminClient
      .from('sites')
      .select('id, slug')
      .eq('slug', requestedSiteSlug)
      .eq('ativo', true)
      .maybeSingle()
    requestedSiteId = site?.id ?? null
  }

  if (requestedSiteSlug && !requestedSiteId) return c.json({ error: 'Site não encontrado ou inativo' }, 404)
  if (requestedSiteId && profile.role !== 'SUPERADMIN' && profile.site_id !== requestedSiteId) {
    return c.json({ error: 'Este usuário não tem acesso a este site.' }, 403)
  }
  if (requestedSiteId && profile.role === 'ALUNO') {
    const { data: site } = await adminClient.from('sites').select('allowed_origins').eq('id', requestedSiteId).maybeSingle()
    const cms = parseCms(site)
    if (profile.ativo === false || cms.blocked_students?.[data.user.id] || cms.deleted_students?.[data.user.id]) {
      return c.json({ error: 'Acesso bloqueado. Fale com o professor responsável pelo site.' }, 403)
    }
    const paid = await applyPaidCheckoutForStudent(c.env, requestedSiteId, data.user.id, String(data.user.email || '').toLowerCase())
    if (paid.error) return c.json(dbError(), 500)
    if (paid.activated) profile.ativo = true
  }

  const config = getConfig(c.env)
  const token = await createToken(
    {
      sub: data.user.id,
      email: data.user.email!,
      role: profile.role,
      site_id: profile.site_id,
      nome: profile.nome,
      ativo: profile.ativo !== false
    },
    config.sessionSecret,
    config.sessionTtlSeconds
  )

  setCookie(c, 'auth_token', token, sessionCookieOptions(c.env))

  return c.json({
    ok: true,
    role: profile.role,
    nome: profile.nome,
    ativo: profile.ativo !== false,
    site_id: profile.site_id,
    site_slug: requestedSiteSlug || null
  })
})

auth.post('/register', async (c) => {
  if (!checkRateLimit(rateLimitKey(c, 'register'), 5, 60_000)) {
    return c.json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }, 429)
  }
  let body: { email: string; password: string; nome: string; cpf?: string; site_slug?: string; site_id?: string; turma_id?: string; course_id?: string; course?: string; product?: string; checkout_code?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Corpo inválido' }, 400)
  }

  const email = body.email?.trim().toLowerCase()
  const password = body.password
  const nome = body.nome?.trim()
  const cpf = onlyDigits(body.cpf)
  if (!email || !password || !nome) return c.json({ error: 'Nome, email e senha são obrigatórios' }, 400)
  if (String(password).length < 6) return c.json({ error: 'A senha deve ter pelo menos 6 caracteres.' }, 400)
  if (!isValidCpf(cpf)) return c.json({ error: 'Informe um CPF válido para concluir o cadastro.' }, 400)

  const sb = getAdmin(c.env)
  let siteId = body.site_id || null
  if (!siteId && body.site_slug) {
    const { data: site } = await sb.from('sites').select('id').eq('slug', body.site_slug).eq('ativo', true).single()
    siteId = site?.id ?? null
  }
  if (!siteId) return c.json({ error: 'Site não encontrado' }, 404)

  const product = String(body.product || 'turma').toLowerCase()
  const courseId = body.course_id || body.course || undefined
  const checkoutValidation = await validateCheckoutCodeForRegistration(c.env, siteId, email, cpf, body.turma_id, body.checkout_code, {
    product,
    courseId
  })
  if (!checkoutValidation.ok) return c.json({ error: checkoutValidation.error }, 400)

  const existingUsers = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const cpfOwner = existingUsers.data.users.find((item) => onlyDigits((item.user_metadata as any)?.cpf) === cpf)
  if (cpfOwner?.id) {
    return c.json({ error: 'Este CPF já está vinculado a um cadastro. Faça login ou use outro CPF.' }, 409)
  }

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    user_metadata: { nome, role: 'ALUNO', cpf },
    email_confirm: true
  })
  if (error) return c.json({ error: 'Não foi possível criar o cadastro com estes dados.' }, 400)

  const paid = await applyPaidCheckoutForStudent(c.env, siteId, data.user.id, email, {
    checkoutCode: body.checkout_code,
    turmaId: body.turma_id,
    product,
    courseId,
    requireCode: Boolean(body.turma_id || courseId)
  })
  if (paid.error) return c.json(dbError(), 500)

  await sb.from('profiles').update({
    nome,
    role: 'ALUNO',
    site_id: siteId,
    ativo: paid.activated
  }).eq('id', data.user.id)

  return c.json({ ok: true, status: paid.activated ? 'ATIVO_POR_PAGAMENTO' : 'PENDENTE' }, 201)
})

auth.post('/oauth-session', async (c) => {
  if (!getConfig(c.env).flags.oauth) {
    return c.json({ error: 'OAuth temporariamente indisponível.' }, 503)
  }

  let body: { access_token: string; site_slug?: string; site_id?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Corpo inválido' }, 400)
  }

  if (!body.access_token) return c.json({ error: 'Token SSO obrigatório' }, 400)

  const anonClient = getClient(c.env)
  const { data: authData, error: userErr } = await anonClient.auth.getUser(body.access_token)
  if (userErr || !authData.user?.email) return c.json({ error: 'SSO inválido' }, 401)

  const sb = getAdmin(c.env)
  let siteId = body.site_id || null
  let requestedSiteSlug = body.site_slug || ''
  if (!siteId && body.site_slug) {
    const { data: site } = await sb.from('sites').select('id, slug').eq('slug', body.site_slug).eq('ativo', true).single()
    siteId = site?.id ?? null
    requestedSiteSlug = site?.slug || requestedSiteSlug
  }

  const { data: existing } = await sb.from('profiles')
    .select('role, site_id, nome, ativo')
    .eq('id', authData.user.id)
    .maybeSingle()

  const nome = existing?.nome || authData.user.user_metadata?.full_name || authData.user.user_metadata?.name || authData.user.email.split('@')[0]

  if (!existing) {
    if (!siteId) {
      await sb.from('profiles').insert({
        id: authData.user.id,
        nome,
        role: 'CORRETOR',
        site_id: null,
        ativo: false
      })
    } else {
      await sb.from('profiles').insert({
        id: authData.user.id,
        nome,
        role: 'ALUNO',
        site_id: siteId,
        ativo: false
      })
    }
  } else if (existing.role === 'ALUNO' && !siteId) {
    return c.json({ error: 'Aluno deve acessar pelo site do professor.' }, 403)
  } else if (existing.role !== 'SUPERADMIN' && siteId && existing.site_id && existing.site_id !== siteId) {
    return c.json({ error: 'Este usuário não tem acesso a este site.' }, 403)
  } else if (!existing.site_id && siteId && existing.role === 'ALUNO') {
    await sb.from('profiles').update({ site_id: siteId, ativo: false }).eq('id', authData.user.id)
  }

  const { data: profile, error: pErr } = await sb.from('profiles')
    .select('role, site_id, nome, ativo')
    .eq('id', authData.user.id)
    .single()
  if (pErr || !profile) return c.json({ error: 'Perfil não encontrado' }, 401)

  if (profile.role === 'ALUNO' && profile.site_id) {
    const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', profile.site_id).maybeSingle()
    const cms = parseCms(site)
    if (profile.ativo === false || cms.blocked_students?.[authData.user.id] || cms.deleted_students?.[authData.user.id]) {
      return c.json({ error: 'Acesso bloqueado. Fale com o professor responsável pelo site.' }, 403)
    }
  }

  let resolvedSiteSlug = requestedSiteSlug || null
  if (!resolvedSiteSlug && profile.site_id) {
    const { data: site } = await sb.from('sites').select('slug').eq('id', profile.site_id).maybeSingle()
    resolvedSiteSlug = site?.slug || null
  }

  const config = getConfig(c.env)
  const token = await createToken(
    {
      sub: authData.user.id,
      email: authData.user.email,
      role: profile.role,
      site_id: profile.site_id,
      nome: profile.nome,
      ativo: profile.ativo !== false
    },
    config.sessionSecret,
    config.sessionTtlSeconds
  )

  setCookie(c, 'auth_token', token, sessionCookieOptions(c.env))

  return c.json({
    ok: true,
    role: profile.role,
    nome: profile.nome,
    ativo: profile.ativo !== false,
    site_id: profile.site_id,
    site_slug: resolvedSiteSlug
  })
})

auth.post('/forgot-password', async (c) => {
  if (!checkRateLimit(rateLimitKey(c, 'forgot'), 3, 60_000)) {
    return c.json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }, 429)
  }
  let body: { email: string; site_slug?: string; redirect_to?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Corpo inválido' }, 400)
  }

  const email = body.email?.trim()
  if (!email) return c.json({ error: 'Informe seu email' }, 400)

  const config = getConfig(c.env)
  const redirectUrl = recoveryRedirectUrl(body, config.appUrl || new URL(c.req.url).origin)

  if (config.flags.emails) {
    const sb = getAdmin(c.env)
    const { data, error } = await sb.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: redirectUrl }
    })
    const actionLink = data?.properties?.action_link
    if (error || !actionLink) {
      return c.json({ ok: true, delivery: 'not_disclosed' })
    }

    let name = 'tudo bem'
    let siteName = 'Redação com Estratégia'
    let teacherName = ''
    let profileSiteId: string | null = null
    if (data.user?.id) {
      const { data: profile } = await sb.from('profiles').select('nome, site_id').eq('id', data.user.id).maybeSingle()
      name = profile?.nome || data.user.email || name
      profileSiteId = profile?.site_id || null
    }
    if (body.site_slug || profileSiteId) {
      const query = sb.from('sites').select('id, nome_prof').limit(1)
      const { data: site } = body.site_slug
        ? await query.eq('slug', body.site_slug).maybeSingle()
        : await query.eq('id', profileSiteId).maybeSingle()
      if (site?.nome_prof) {
        siteName = site.nome_prof
        teacherName = site.nome_prof
      }
    }

    const provider = getEmailProvider(c.env)
    const sent = await provider.send(renderPasswordRecoveryEmail({
      to: email,
      name,
      recoveryUrl: actionLink,
      siteName,
      teacherName
    }))
    if (!sent.sent) {
      console.warn('password_recovery_email_failed', { provider: sent.provider, reason: sent.reason || 'unknown' })
      return c.json({ error: 'Envio de recuperação indisponível no momento. Tente novamente mais tarde ou fale com o suporte.' }, 503)
    }

    return c.json({ ok: true, delivery: sent.provider })
  }

  const anonClient = getClient(c.env)
  await anonClient.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl })

  return c.json({ ok: true, delivery: 'supabase' })
})

auth.post('/reset-password', async (c) => {
  let body: { access_token: string; refresh_token: string; password: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Corpo inválido' }, 400)
  }
  const password = String(body.password || '')
  if (!body.access_token || !body.refresh_token) return c.json({ error: 'Link de recuperação inválido ou expirado.' }, 400)
  if (password.length < 6) return c.json({ error: 'A senha deve ter pelo menos 6 caracteres.' }, 400)

  const anonClient = getClient(c.env)
  const { error: sessionError } = await anonClient.auth.setSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token
  })
  if (sessionError) return c.json({ error: 'Link de recuperação inválido ou expirado.' }, 400)

  const { error } = await anonClient.auth.updateUser({ password })
  if (error) return c.json({ error: 'Não foi possível redefinir a senha.' }, 400)
  return c.json({ ok: true })
})

auth.post('/logout', (c) => {
  deleteCookie(c, 'auth_token', expiredSessionCookieOptions(c.env))
  return c.json({ ok: true })
})

auth.get('/me', requireAuth, async (c) => {
  const user = c.get('user')
  if (user.role === 'ALUNO') {
    const sb = getAdmin(c.env)
    const { data: profile } = await sb.from('profiles').select('ativo, site_id').eq('id', user.sub).maybeSingle()
    if (!profile || profile.ativo === false) {
      deleteCookie(c, 'auth_token', expiredSessionCookieOptions(c.env))
      return c.json({ error: 'Acesso bloqueado. Fale com o professor responsável pelo site.' }, 403)
    }
    if (profile.site_id) {
      const { data: site } = await sb.from('sites').select('allowed_origins').eq('id', profile.site_id).maybeSingle()
      const cms = parseCms(site)
      if (cms.blocked_students?.[user.sub] || cms.deleted_students?.[user.sub]) {
        deleteCookie(c, 'auth_token', expiredSessionCookieOptions(c.env))
        return c.json({ error: 'Acesso bloqueado. Fale com o professor responsável pelo site.' }, 403)
      }
    }
  }
  return c.json({
    id: user.sub,
    email: user.email,
    role: user.role,
    site_id: user.site_id,
    nome: user.nome,
    ativo: user.ativo
  })
})

export { auth as authRoutes }
