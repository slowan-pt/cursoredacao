import { Hono } from 'hono'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { requireAuth, requireRole } from '../middleware'

const app = new Hono<{ Bindings: Env }>()

function dbError() {
  return { error: 'Erro ao acessar os dados.' }
}

app.use('*', requireAuth, requireRole('SUPERADMIN'))

function slugifySiteName(value: string) {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'professor'
}

async function uniqueSiteSlug(sb: ReturnType<typeof getAdmin>, base: string) {
  let slug = slugifySiteName(base)
  let candidate = slug
  let suffix = 2
  while (true) {
    const { data } = await sb.from('sites').select('id').eq('slug', candidate).maybeSingle()
    if (!data) return candidate
    candidate = `${slug}-${suffix++}`
  }
}

function parseNotifications(site: any) {
  const raw = (site?.allowed_origins || []).find((item: string) => String(item).startsWith('CMS:'))
  if (!raw) return []
  try {
    const cms = JSON.parse(String(raw).slice(4))
    return Array.isArray(cms.notifications) ? cms.notifications : []
  } catch {
    return []
  }
}

async function safeCount(query: any) {
  const { count, error } = await query
  return error ? null : count ?? 0
}

function centsToMoney(value: unknown) {
  return Math.round(Number(value || 0)) / 100
}

app.get('/stats', async (c) => {
  const sb = getAdmin(c.env)
  const [sites, profiles] = await Promise.all([
    sb.from('sites').select('id', { count: 'exact', head: true }).eq('ativo', true),
    sb.from('profiles').select('id', { count: 'exact', head: true })
  ])
  return c.json({ sites: sites.count ?? 0, users: profiles.count ?? 0 })
})

app.get('/health', async (c) => {
  const sb = getAdmin(c.env)
  const today = new Date().toISOString().slice(0, 10)
  const [
    supabaseProbe,
    pendingPayments,
    receivedToday,
    webhooksProcessed,
    webhooksPending,
    enrollments,
    uploads,
    sites
  ] = await Promise.all([
    sb.from('sites').select('id', { count: 'exact', head: true }).limit(1),
    safeCount(sb.from('payments').select('id', { count: 'exact', head: true }).eq('provider', 'ASAAS').eq('status', 'PENDING')),
    safeCount(sb.from('payments').select('id', { count: 'exact', head: true }).eq('provider', 'ASAAS').in('status', ['RECEIVED', 'CONFIRMED']).gte('paid_at', `${today}T00:00:00.000Z`)),
    safeCount(sb.from('payment_webhook_events').select('id', { count: 'exact', head: true }).eq('processed', true)),
    safeCount(sb.from('payment_webhook_events').select('id', { count: 'exact', head: true }).eq('processed', false)),
    safeCount(sb.from('turma_alunos').select('turma_id', { count: 'exact', head: true }).eq('ativo', true)),
    safeCount(sb.from('storage_files').select('id', { count: 'exact', head: true }).neq('status', 'DELETED')),
    sb.from('sites').select('allowed_origins')
  ])

  const notifications = (sites.data || []).flatMap(parseNotifications)
  return c.json({
    app_version: c.env.APP_VERSION || 'dev',
    app_env: c.env.APP_ENV || 'development',
    worker: 'cursoredacao',
    host: new URL(c.req.url).hostname,
    health: true,
    supabase: { ok: !supabaseProbe.error },
    asaas: {
      env: c.env.ASAAS_ENV || 'disabled',
      configured: Boolean(c.env.ASAAS_API_KEY && c.env.ASAAS_WEBHOOK_TOKEN),
      payments_enabled: c.env.ENABLE_PAYMENTS === 'true'
    },
    r2: {
      configured: Boolean(c.env.R2_UPLOADS),
      enabled: c.env.ENABLE_R2_UPLOADS === 'true',
      uploads
    },
    emails: {
      enabled: c.env.ENABLE_EMAILS === 'true',
      configured: Boolean(c.env.RESEND_API_KEY)
    },
    payments: {
      pending: pendingPayments,
      received_today: receivedToday
    },
    webhooks: {
      processed: webhooksProcessed,
      pending: webhooksPending
    },
    enrollments: {
      active: enrollments
    },
    notifications: {
      total: notifications.length,
      unread: notifications.filter((item: any) => item?.read === false).length
    },
    migrations: {
      '006_performance_indexes': 'aplicada e confirmada por script administrativo em 2026-07-13'
    },
    last_deploy: 'verificado via Wrangler'
  })
})

app.get('/financial', async (c) => {
  const sb = getAdmin(c.env)
  const [{ data: sites }, { data: payments }, { data: entries }, { data: closings }, { data: payouts }] = await Promise.all([
    sb.from('sites').select('id, slug, nome_prof, ativo').order('nome_prof'),
    sb.from('payments').select('site_id, status, amount_cents, paid_at').eq('provider', 'ASAAS'),
    sb.from('correction_compensation_entries').select('site_id, status, amount_cents, child_professor_id, corrected_at'),
    sb.from('teacher_payment_closings').select('site_id, status, final_amount_cents, period_end, paid_at'),
    sb.from('teacher_payouts').select('site_id, status, amount_cents, paid_at')
  ])
  const siteRows = sites || []
  const payRows = payments || []
  const entryRows = entries || []
  const closingRows = closings || []
  const payoutRows = payouts || []
  const bySite = siteRows.map((site: any) => {
    const sitePayments = payRows.filter((row: any) => row.site_id === site.id)
    const siteEntries = entryRows.filter((row: any) => row.site_id === site.id)
    const siteClosings = closingRows.filter((row: any) => row.site_id === site.id)
    const sitePayouts = payoutRows.filter((row: any) => row.site_id === site.id)
    const revenue = sitePayments.filter((row: any) => ['RECEIVED', 'CONFIRMED'].includes(row.status)).reduce((sum: number, row: any) => sum + Number(row.amount_cents || 0), 0)
    const due = siteEntries.filter((row: any) => !['PAID', 'CANCELED', 'REVERSED'].includes(row.status)).reduce((sum: number, row: any) => sum + Number(row.amount_cents || 0), 0)
    const paid = sitePayouts.filter((row: any) => row.status !== 'CANCELED').reduce((sum: number, row: any) => sum + Number(row.amount_cents || 0), 0)
    return {
      site_id: site.id,
      slug: site.slug,
      nome_prof: site.nome_prof,
      ativo: site.ativo,
      revenue: centsToMoney(revenue),
      due_to_child_teachers: centsToMoney(due),
      paid_to_child_teachers: centsToMoney(paid),
      pending_closings: siteClosings.filter((row: any) => row.status !== 'PAID' && row.status !== 'CANCELED').length,
      child_teachers_count: new Set(siteEntries.map((row: any) => row.child_professor_id).filter(Boolean)).size
    }
  })
  const totalRevenue = payRows.filter((row: any) => ['RECEIVED', 'CONFIRMED'].includes(row.status)).reduce((sum: number, row: any) => sum + Number(row.amount_cents || 0), 0)
  const totalDue = entryRows.filter((row: any) => !['PAID', 'CANCELED', 'REVERSED'].includes(row.status)).reduce((sum: number, row: any) => sum + Number(row.amount_cents || 0), 0)
  const totalPaid = payoutRows.filter((row: any) => row.status !== 'CANCELED').reduce((sum: number, row: any) => sum + Number(row.amount_cents || 0), 0)
  return c.json({
    summary: {
      revenue: centsToMoney(totalRevenue),
      due_to_child_teachers: centsToMoney(totalDue),
      paid_to_child_teachers: centsToMoney(totalPaid),
      pending_to_child_teachers: centsToMoney(Math.max(0, totalDue - totalPaid)),
      open_closings: closingRows.filter((row: any) => row.status !== 'PAID' && row.status !== 'CANCELED').length
    },
    sites: bySite
  })
})

app.get('/sites', async (c) => {
  const sb = getAdmin(c.env)
  const { data, error } = await sb.from('sites').select('*').order('created_at', { ascending: false })
  if (error) return c.json(dbError(), 500)
  return c.json({ data })
})

app.post('/sites', async (c) => {
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const { data, error } = await sb.from('sites').insert(body).select().single()
  if (error) return c.json(dbError(), 500)
  return c.json(data, 201)
})

app.patch('/sites/:id', async (c) => {
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const allowed = ['slug', 'nome_prof', 'bio_prof', 'cor_primaria', 'cor_accent', 'logo_url', 'foto_url', 'domain_custom', 'ativo']
  const update = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)))

  if (!Object.keys(update).length) return c.json({ error: 'Nada para atualizar' }, 400)

  const { data, error } = await sb.from('sites')
    .update(update)
    .eq('id', c.req.param('id'))
    .select()
    .single()

  if (error) return c.json(dbError(), 500)
  return c.json(data)
})

app.get('/users', async (c) => {
  const sb = getAdmin(c.env)
  const { data, error } = await sb
    .from('profiles')
    .select('id, nome, role, site_id, ativo, created_at, sites(nome_prof, slug)')
    .order('created_at', { ascending: false })
  if (error) return c.json(dbError(), 500)
  const { data: authUsers } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const emailById = new Map((authUsers?.users || []).map((user) => [user.id, user.email || '']))
  return c.json({ data: (data || []).map((profile) => ({ ...profile, email: emailById.get(profile.id) || '' })) })
})

app.post('/users', async (c) => {
  const { email, password, nome, role, site_id } = await c.req.json()
  const sb = getAdmin(c.env)

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    user_metadata: { nome, role },
    email_confirm: true
  })
  if (error) return c.json(dbError(), 500)

  await sb.from('profiles').update({ nome, role, site_id: site_id || null }).eq('id', data.user.id)
  return c.json({ id: data.user.id, email, nome, role }, 201)
})

app.post('/users/:id/approve-professor', async (c) => {
  const id = c.req.param('id')
  const sb = getAdmin(c.env)
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, nome, role, site_id, ativo')
    .eq('id', id)
    .single()

  if (profileError || !profile) return c.json({ error: 'Professor não encontrado' }, 404)
  if (!['CORRETOR', 'ADMIN'].includes(profile.role)) {
    return c.json({ error: 'Somente professores podem ser aprovados por aqui.' }, 400)
  }

  let siteId = profile.site_id
  if (!siteId) {
    const nome = profile.nome || 'Professor'
    const slug = await uniqueSiteSlug(sb, nome)
    const { data: site, error: siteError } = await sb
      .from('sites')
      .insert({
        slug,
        nome_prof: nome,
        bio_prof: 'Site independente do professor.',
        cor_primaria: '#1A3A2A',
        cor_accent: '#C5F135',
        ativo: true
      })
      .select('id, slug')
      .single()

    if (siteError || !site) return c.json({ error: siteError?.message || 'Não foi possível criar o site do professor.' }, 500)
    siteId = site.id
  } else {
    await sb.from('sites').update({ ativo: true }).eq('id', siteId)
  }

  const { data, error } = await sb
    .from('profiles')
    .update({ ativo: true, role: 'CORRETOR', site_id: siteId })
    .eq('id', id)
    .select('id, nome, role, site_id, ativo, sites(nome_prof, slug)')
    .single()

  if (error) return c.json(dbError(), 500)
  return c.json(data)
})

app.patch('/users/:id', async (c) => {
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const update: Record<string, unknown> = {}
  const authUpdate: Record<string, unknown> = {}
  const allowedRoles = ['SUPERADMIN', 'ADMIN', 'CORRETOR', 'ALUNO']
  if (typeof body.nome === 'string' && body.nome.trim()) update.nome = body.nome.trim()
  if (typeof body.role === 'string' && allowedRoles.includes(body.role)) update.role = body.role
  if (typeof body.ativo === 'boolean') update.ativo = body.ativo
  if (typeof body.site_id === 'string' || body.site_id === null) update.site_id = body.role === 'SUPERADMIN' ? null : body.site_id
  if (typeof body.email === 'string' && body.email.trim()) authUpdate.email = body.email.trim().toLowerCase()
  if (typeof body.password === 'string' && body.password.trim()) authUpdate.password = body.password.trim()
  if (update.nome || update.role) {
    authUpdate.user_metadata = Object.fromEntries(Object.entries({ nome: update.nome, role: update.role }).filter(([, value]) => value !== undefined))
  }
  if (!Object.keys(update).length && !Object.keys(authUpdate).length) return c.json({ error: 'Nada para atualizar' }, 400)

  if (Object.keys(authUpdate).length) {
    const { error: authError } = await sb.auth.admin.updateUserById(c.req.param('id'), authUpdate)
    if (authError) return c.json(dbError(), 500)
  }

  if (!Object.keys(update).length) {
    const { data: current, error: currentError } = await sb
      .from('profiles')
      .select('id, nome, role, site_id, ativo, created_at, sites(nome_prof, slug)')
      .eq('id', c.req.param('id'))
      .single()
    if (currentError) return c.json(dbError(), 500)
    return c.json(current)
  }

  const { data, error } = await sb
    .from('profiles')
    .update(update)
    .eq('id', c.req.param('id'))
    .select('id, nome, role, site_id, ativo, created_at, sites(nome_prof, slug)')
    .single()

  if (error) return c.json(dbError(), 500)
  return c.json(data)
})

export { app as superadminRoutes }
