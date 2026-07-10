import { Hono } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import type { Env } from '../types'
import { getAdmin, getClient } from '../supabase'
import { createToken } from '../auth'
import { requireAuth } from '../middleware'
import { expiredSessionCookieOptions, getConfig, sessionCookieOptions } from '../config'

const auth = new Hono<{ Bindings: Env }>()
const CMS_PREFIX = 'CMS:'

function parseCms(site: any) {
  const raw = (site?.allowed_origins || []).find((item: string) => String(item).startsWith(CMS_PREFIX))
  const base = {
    student_credits: {} as Record<string, { creditos?: number; vence_em?: string | null; updated_at?: string }>,
    enrollments: {} as Record<string, Record<string, { ativo?: boolean; origem?: string; created_at?: string; updated_at?: string }>>,
    checkout_leads: {} as Record<string, any>
  }
  if (!raw) return base
  try {
    const cms = JSON.parse(String(raw).slice(CMS_PREFIX.length))
    return {
      ...cms,
      student_credits: cms.student_credits && typeof cms.student_credits === 'object' ? cms.student_credits : {},
      enrollments: cms.enrollments && typeof cms.enrollments === 'object' ? cms.enrollments : {},
      checkout_leads: cms.checkout_leads && typeof cms.checkout_leads === 'object' ? cms.checkout_leads : {}
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

async function applyPaidCheckoutForStudent(env: Env, siteId: string, userId: string, email: string) {
  const sb = getAdmin(env)
  const { data: site, error: siteErr } = await sb.from('sites').select('allowed_origins').eq('id', siteId).single()
  if (siteErr || !site) return { activated: false, error: siteErr }
  const cms = parseCms(site)
  const paid = Object.values(cms.checkout_leads || {})
    .filter((lead: any) => String(lead?.email || '').toLowerCase() === email && lead?.status === 'PAGAMENTO_APROVADO_SIMULADO')
  const turmaIds = Array.from(new Set(paid.map((lead: any) => String(lead.turma_id || '')).filter(Boolean)))
  if (!turmaIds.length) return { activated: false }

  const rows = turmaIds.map((turma_id) => ({
    site_id: siteId,
    turma_id,
    aluno_id: userId,
    ativo: true,
    origem: 'PAGAMENTO_SIMULADO_PUBLICO'
  }))
  const { error: upsertErr } = await sb.from('turma_alunos').upsert(rows, { onConflict: 'turma_id,aluno_id' })
  if (missingTurmaAlunos(upsertErr)) {
    turmaIds.forEach((turmaId) => {
      cms.enrollments[turmaId] = {
        ...(cms.enrollments[turmaId] || {}),
        [userId]: {
          ativo: true,
          origem: 'PAGAMENTO_SIMULADO_PUBLICO',
          created_at: cms.enrollments[turmaId]?.[userId]?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }
    })
  } else if (upsertErr) {
    return { activated: false, error: upsertErr }
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
    const paid = await applyPaidCheckoutForStudent(c.env, requestedSiteId, data.user.id, String(data.user.email || '').toLowerCase())
    if (paid.error) return c.json({ error: paid.error.message }, 500)
    if (paid.activated) profile.ativo = true
  }

  const token = await createToken(
    {
      sub: data.user.id,
      email: data.user.email!,
      role: profile.role,
      site_id: profile.site_id,
      nome: profile.nome,
      ativo: profile.ativo !== false
    },
    getConfig(c.env).sessionSecret
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
  let body: { email: string; password: string; nome: string; site_slug?: string; site_id?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Corpo inválido' }, 400)
  }

  const email = body.email?.trim().toLowerCase()
  const password = body.password
  const nome = body.nome?.trim()
  if (!email || !password || !nome) return c.json({ error: 'Nome, email e senha são obrigatórios' }, 400)

  const sb = getAdmin(c.env)
  let siteId = body.site_id || null
  if (!siteId && body.site_slug) {
    const { data: site } = await sb.from('sites').select('id').eq('slug', body.site_slug).eq('ativo', true).single()
    siteId = site?.id ?? null
  }
  if (!siteId) return c.json({ error: 'Site não encontrado' }, 404)

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    user_metadata: { nome, role: 'ALUNO' },
    email_confirm: true
  })
  if (error) return c.json({ error: error.message }, 400)

  const paid = await applyPaidCheckoutForStudent(c.env, siteId, data.user.id, email)
  if (paid.error) return c.json({ error: paid.error.message }, 500)

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

  let resolvedSiteSlug = requestedSiteSlug || null
  if (!resolvedSiteSlug && profile.site_id) {
    const { data: site } = await sb.from('sites').select('slug').eq('id', profile.site_id).maybeSingle()
    resolvedSiteSlug = site?.slug || null
  }

  const token = await createToken(
    {
      sub: authData.user.id,
      email: authData.user.email,
      role: profile.role,
      site_id: profile.site_id,
      nome: profile.nome,
      ativo: profile.ativo !== false
    },
    getConfig(c.env).sessionSecret
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
  if (!getConfig(c.env).flags.emails) {
    return c.json({ error: 'Recuperação de senha por e-mail temporariamente indisponível.' }, 503)
  }

  let body: { email: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Corpo inválido' }, 400)
  }

  const email = body.email?.trim()
  if (!email) return c.json({ error: 'Informe seu email' }, 400)

  const anonClient = getClient(c.env)
  const { error } = await anonClient.auth.resetPasswordForEmail(email, {
    redirectTo: new URL('/login.html', c.req.url).toString()
  })

  if (error) return c.json({ error: 'Não foi possível enviar o email de recuperação' }, 400)

  return c.json({ ok: true })
})

auth.post('/logout', (c) => {
  deleteCookie(c, 'auth_token', expiredSessionCookieOptions(c.env))
  return c.json({ ok: true })
})

auth.get('/me', requireAuth, (c) => {
  const user = c.get('user')
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
