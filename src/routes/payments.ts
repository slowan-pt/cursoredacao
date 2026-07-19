import { Hono } from 'hono'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { getPaymentGateway, normalizeAsaasPaymentStatus, normalizeAsaasWebhookPayload, validateAsaasWebhookToken } from '../payments'
import { requireAuth } from '../middleware'

const app = new Hono<{ Bindings: Env }>()
const CMS_PREFIX = 'CMS:'

function defaultCms() {
  return {
    checkout_leads: {} as Record<string, any>,
    notifications: [] as any[],
    student_credits: {} as Record<string, { creditos?: number; vence_em?: string | null; updated_at?: string }>,
    enrollments: {} as Record<string, Record<string, { ativo?: boolean; origem?: string; created_at?: string; updated_at?: string }>>,
    video_courses: [] as any[]
  }
}

function parseCms(site: any) {
  const raw = (site?.allowed_origins || []).find((item: string) => String(item).startsWith(CMS_PREFIX))
  if (!raw) return defaultCms()
  try {
    const cms = JSON.parse(String(raw).slice(CMS_PREFIX.length))
    return {
      ...cms,
      checkout_leads: cms.checkout_leads && typeof cms.checkout_leads === 'object' ? cms.checkout_leads : {},
      notifications: Array.isArray(cms.notifications) ? cms.notifications : [],
      video_courses: Array.isArray(cms.video_courses) ? cms.video_courses : [],
      student_credits: cms.student_credits && typeof cms.student_credits === 'object' ? cms.student_credits : {},
      enrollments: cms.enrollments && typeof cms.enrollments === 'object' ? cms.enrollments : {}
    }
  } catch {
    return defaultCms()
  }
}

function withCmsOrigins(origins: string[] | null | undefined, cms: unknown) {
  const keep = (origins || []).filter((item) => !String(item).startsWith(CMS_PREFIX))
  return [...keep, `${CMS_PREFIX}${JSON.stringify(cms)}`]
}

function missingPaymentTables(error: any) {
  return /payments|payment_webhook_events|relation .* does not exist|schema cache/i.test(String(error?.message || ''))
}

function missingTurmaAlunos(error: any) {
  return /turma_alunos|relation .* does not exist|schema cache/i.test(String(error?.message || ''))
}

function missingVideoTables(error: any) {
  return /video_course_enrollments|relation .* does not exist|schema cache/i.test(String(error?.message || ''))
}

function isPaidStatus(status: string) {
  return status === 'CONFIRMED' || status === 'RECEIVED'
}

function tomorrowIsoDate() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return date.toISOString().slice(0, 10)
}

async function grantPaidEnrollment(sb: ReturnType<typeof getAdmin>, payment: any, origin = 'ASAAS_WEBHOOK') {
  if (!payment?.site_id || !payment?.turma_id || !payment?.aluno_id) {
    return { granted: false, reason: 'missing_enrollment_target' }
  }

  const row = {
    site_id: payment.site_id,
    turma_id: payment.turma_id,
    aluno_id: payment.aluno_id,
    ativo: true,
    origem: origin
  }
  const { error: upsertErr } = await sb.from('turma_alunos').upsert(row, { onConflict: 'turma_id,aluno_id' })
  if (upsertErr && !missingTurmaAlunos(upsertErr)) {
    return { granted: false, reason: upsertErr.message }
  }

  const { data: site, error: siteErr } = await sb.from('sites')
    .select('allowed_origins')
    .eq('id', payment.site_id)
    .maybeSingle()
  if (siteErr || !site) return { granted: false, reason: siteErr?.message || 'site_not_found' }

  const cms = parseCms(site)
  cms.enrollments = cms.enrollments || {}
  cms.enrollments[payment.turma_id] = {
    ...(cms.enrollments[payment.turma_id] || {}),
    [payment.aluno_id]: {
      ativo: true,
      origem: origin,
      created_at: cms.enrollments[payment.turma_id]?.[payment.aluno_id]?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  }

  const currentCredit = cms.student_credits?.[payment.aluno_id] || {}
  const currentAmount = Math.max(0, Number(currentCredit.creditos) || 0)
  const vence = new Date()
  vence.setFullYear(vence.getFullYear() + 1)
  cms.student_credits = {
    ...(cms.student_credits || {}),
    [payment.aluno_id]: {
      ...currentCredit,
      creditos: Math.max(currentAmount, 10),
      vence_em: currentCredit.vence_em || vence.toISOString().slice(0, 10),
      updated_at: new Date().toISOString()
    }
  }

  const { error: cmsErr } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) })
    .eq('id', payment.site_id)
  if (cmsErr) return { granted: false, reason: cmsErr.message }

  await sb.from('profiles').update({ ativo: true }).eq('id', payment.aluno_id).eq('role', 'ALUNO')
  return { granted: true }
}

async function grantPaidVideoCourseEnrollment(sb: ReturnType<typeof getAdmin>, payment: any) {
  const courseId = String(payment?.course_id || payment?.raw_summary?.course_id || '').trim()
  if (!payment?.site_id || !courseId || !payment?.aluno_id) {
    return { granted: false, reason: 'missing_video_enrollment_target' }
  }
  const row = {
    site_id: payment.site_id,
    course_id: courseId,
    aluno_id: payment.aluno_id,
    payment_id: payment.id,
    status: 'ACTIVE',
    updated_at: new Date().toISOString()
  }
  const { error } = await sb.from('video_course_enrollments')
    .upsert(row, { onConflict: 'site_id,course_id,aluno_id' })
  if (error) {
    if (missingVideoTables(error)) return { granted: false, reason: 'video_tables_missing' }
    return { granted: false, reason: error.message }
  }
  await sb.from('profiles').update({ ativo: true }).eq('id', payment.aluno_id).eq('role', 'ALUNO')
  return { granted: true }
}

async function markCheckoutPaidAndNotify(sb: ReturnType<typeof getAdmin>, payment: any, origin = 'ASAAS_WEBHOOK') {
  if (!payment?.site_id) return { ok: false, reason: 'missing_site' }
  const { data: site, error: siteErr } = await sb.from('sites')
    .select('allowed_origins')
    .eq('id', payment.site_id)
    .maybeSingle()
  if (siteErr || !site) return { ok: false, reason: siteErr?.message || 'site_not_found' }
  const cms = parseCms(site)
  const now = new Date().toISOString()
  const productType = String(payment.product_type || payment.raw_summary?.product_type || 'TURMA')
  const courseId = String(payment.course_id || payment.raw_summary?.course_id || '')
  const leadKey = productType === 'VIDEO_COURSE'
    ? `${String(payment.payer_email || '').toLowerCase()}:video:${courseId}`
    : `${String(payment.payer_email || '').toLowerCase()}:${payment.turma_id}`
  const lead = cms.checkout_leads?.[leadKey] || {}
  if (payment.payer_email && (payment.turma_id || courseId)) {
    cms.checkout_leads = {
      ...(cms.checkout_leads || {}),
      [leadKey]: {
        ...lead,
        email: payment.payer_email,
        nome: payment.payer_name || lead.nome || '',
        turma_id: payment.turma_id,
        course_id: courseId || lead.course_id || null,
        product_type: productType,
        site_id: payment.site_id,
        status: 'PAGAMENTO_CONFIRMADO_ASAAS',
        checkout_code: payment.checkout_code || lead.checkout_code || lead.code || '',
        code: payment.checkout_code || lead.code || lead.checkout_code || '',
        payment_id: payment.id,
        provider_payment_id: payment.provider_payment_id,
        payment_provider: 'ASAAS',
        total: Number(payment.amount_cents || 0) / 100,
        paid_at: payment.paid_at || now,
        updated_at: now
      }
    }
  }
  const { data: turma } = payment.turma_id
    ? await sb.from('turmas').select('nome').eq('id', payment.turma_id).maybeSingle()
    : { data: null }
  const course = courseId ? (cms.video_courses || []).find((item: any) => String(item.id || '') === courseId) : null
  const productName = productType === 'VIDEO_COURSE' ? (course?.title || 'um curso em vídeo') : (turma?.nome || 'uma turma')
  const key = `payment:${payment.provider_payment_id || payment.id}`
  const notifications = Array.isArray(cms.notifications) ? cms.notifications.filter((n: any) => n?.key !== key) : []
  notifications.unshift({
    id: crypto.randomUUID(),
    key,
    type: 'PAYMENT_RECEIVED',
    title: productType === 'VIDEO_COURSE' ? 'Aluno pagou um curso em vídeo' : 'Aluno pagou uma turma',
    message: `${payment.payer_name || payment.payer_email || 'Aluno'} pagou ${productName}.`,
    aluno_email: payment.payer_email,
    aluno_nome: payment.payer_name,
    turma_id: payment.turma_id,
    turma_nome: turma?.nome || null,
    course_id: courseId || null,
    course_title: course?.title || null,
    product_type: productType,
    amount_cents: payment.amount_cents,
    provider_payment_id: payment.provider_payment_id,
    origin,
    read: false,
    created_at: now
  })
  cms.notifications = notifications.slice(0, 100)
  const { error } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) })
    .eq('id', payment.site_id)
  return error ? { ok: false, reason: error.message } : { ok: true }
}

async function applyProviderPaymentStatus(sb: ReturnType<typeof getAdmin>, payment: any, providerPayment: any, origin = 'ASAAS_SYNC') {
  const now = new Date().toISOString()
  const status = normalizeAsaasPaymentStatus(String(providerPayment?.status || payment.status || 'PENDING'))
  const paid = isPaidStatus(status)
  const patch = {
    status,
    billing_type: providerPayment?.billingType || payment.billing_type || null,
    raw_summary: {
      ...(payment.raw_summary || {}),
      synced_from_provider: true,
      provider_payment_id: providerPayment?.id || payment.provider_payment_id,
      provider_status: status
    },
    paid_at: paid ? (payment.paid_at || now) : payment.paid_at,
    updated_at: now
  }
  const { data: updated, error } = await sb.from('payments')
    .update(patch)
    .eq('id', payment.id)
    .select('id, site_id, turma_id, course_id, product_type, aluno_id, payer_email, payer_name, provider_payment_id, amount_cents, billing_type, checkout_code, paid_at, status, raw_summary')
    .single()
  if (error || !updated) return { synced: false, granted: false, status, reason: error?.message || 'payment_update_failed' }
  if (!paid) return { synced: true, granted: false, status, reason: 'not_paid' }
  await markCheckoutPaidAndNotify(sb, updated, origin)
  const grant = String(updated.product_type || updated.raw_summary?.product_type || 'TURMA') === 'VIDEO_COURSE'
    ? await grantPaidVideoCourseEnrollment(sb, updated)
    : await grantPaidEnrollment(sb, updated, origin)
  return { synced: true, granted: grant.granted, status, reason: grant.reason || null }
}

async function runSandboxReconciliation(c: any) {
  const user = c.get('user')
  if (!['ADMIN', 'CORRETOR', 'SUPERADMIN'].includes(user.role)) {
    return c.json({ error: 'Acesso negado.' }, 403)
  }
  if (c.env.ASAAS_ENV !== 'sandbox') {
    return c.json({ error: 'Reconciliação automática permitida apenas em sandbox.' }, 403)
  }

  const body = await c.req.json().catch(() => ({}))
  const dryRun = body.dry_run !== false
  const limit = Math.max(1, Math.min(50, Math.floor(Number(body.limit) || 10)))
  const siteSlug = body.site_slug ? String(body.site_slug) : ''
  const sb = getAdmin(c.env)

  let siteId = user.site_id || ''
  if (siteSlug) {
    const { data: site, error: siteErr } = await sb.from('sites')
      .select('id, slug')
      .eq('slug', siteSlug)
      .maybeSingle()
    if (siteErr || !site) return c.json({ error: 'Site não encontrado.' }, 404)
    if (user.role !== 'SUPERADMIN' && user.site_id !== site.id) return c.json({ error: 'Acesso negado para este site.' }, 403)
    siteId = site.id
  }

  let query = sb.from('payments')
    .select('id, site_id, turma_id, course_id, product_type, aluno_id, payer_email, payer_name, provider_payment_id, amount_cents, billing_type, checkout_code, paid_at, status, raw_summary, updated_at')
    .eq('provider', 'ASAAS')
    .eq('status', 'PENDING')
    .not('provider_payment_id', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(limit)
  if (user.role !== 'SUPERADMIN' || siteId) query = query.eq('site_id', siteId)

  const { data: payments, error } = await query
  if (error) return c.json({ error: 'Não foi possível listar pagamentos pendentes.' }, 500)

  const gateway = getPaymentGateway(c.env)
  const results: any[] = []
  for (const payment of payments || []) {
    const item: any = {
      id: payment.id,
      provider_payment_id: payment.provider_payment_id,
      previous_status: payment.status,
      dry_run: dryRun
    }
    try {
      const providerPayment = await gateway.getPayment(payment.provider_payment_id)
      const normalizedStatus = normalizeAsaasPaymentStatus(String(providerPayment?.status || 'PENDING'))
      item.provider_status = normalizedStatus
      if (!dryRun) {
        const applied = await applyProviderPaymentStatus(sb, payment, providerPayment, 'ASAAS_RECONCILIATION')
        item.updated = applied.synced
        item.enrollment_granted = applied.granted
        item.reason = applied.reason
      } else {
        item.updated = false
        item.enrollment_granted = false
        item.reason = isPaidStatus(normalizedStatus) ? 'would_grant_enrollment' : 'not_paid'
      }
    } catch (err: any) {
      item.updated = false
      item.enrollment_granted = false
      item.error = err?.message || 'asaas_reconciliation_failed'
    }
    results.push(item)
  }

  return c.json({
    ok: true,
    sandbox: true,
    dry_run: dryRun,
    limit,
    checked: results.length,
    paid_found: results.filter((item) => isPaidStatus(item.provider_status)).length,
    updated: results.filter((item) => item.updated).length,
    enrollment_granted: results.filter((item) => item.enrollment_granted).length,
    results
  })
}

app.post('/asaas/webhook', async (c) => {
  if (!validateAsaasWebhookToken(c.env, c.req.raw)) {
    return c.json({ error: 'Webhook não autorizado.' }, 401)
  }

  let normalized
  try {
    normalized = normalizeAsaasWebhookPayload(await c.req.json())
  } catch {
    return c.json({ error: 'Payload de webhook inválido.' }, 400)
  }

  const sb = getAdmin(c.env)
  const { data: inserted, error: insertErr } = await sb.from('payment_webhook_events')
    .insert({
      provider: normalized.provider,
      provider_event_id: normalized.providerEventId,
      provider_payment_id: normalized.providerPaymentId,
      event_type: normalized.event,
      payload: normalized.raw
    })
    .select('id')
    .single()

  if (insertErr) {
    if (String(insertErr.code) === '23505') {
      return c.json({ ok: true, duplicate: true })
    }
    if (missingPaymentTables(insertErr)) {
      return c.json({ error: 'Pagamentos ainda não estão preparados no banco.' }, 503)
    }
    return c.json({ error: 'Não foi possível registrar o webhook.' }, 500)
  }

  const now = new Date().toISOString()
  const paid = isPaidStatus(normalized.status)
  const paidAt = paid ? now : null
  const patch = {
      provider_payment_id: normalized.providerPaymentId,
      status: normalized.status,
      billing_type: normalized.raw.payment?.billingType || null,
      raw_summary: {
        event: normalized.event,
        provider_event_id: normalized.providerEventId,
        provider_payment_id: normalized.providerPaymentId
      },
      paid_at: paidAt,
      updated_at: now
    }
  let paymentResult = await sb.from('payments')
    .update(patch)
    .eq('provider_payment_id', normalized.providerPaymentId)
    .select('id, site_id, turma_id, course_id, product_type, aluno_id, payer_email, payer_name, provider_payment_id, amount_cents, billing_type, checkout_code, paid_at, status, raw_summary')
    .maybeSingle()
  if (!paymentResult.data && normalized.externalReference) {
    paymentResult = await sb.from('payments')
      .update(patch)
      .eq('external_reference', normalized.externalReference)
      .select('id, site_id, turma_id, course_id, product_type, aluno_id, payer_email, payer_name, provider_payment_id, amount_cents, billing_type, checkout_code, paid_at, status, raw_summary')
      .maybeSingle()
  }

  if (paymentResult.error) {
    if (missingPaymentTables(paymentResult.error)) {
      return c.json({ error: 'Pagamentos ainda não estão preparados no banco.' }, 503)
    }
    return c.json({ ok: true, processed: false, reason: 'payment_update_failed' })
  }
  if (!paymentResult.data) {
    return c.json({ ok: true, processed: false, reason: 'payment_not_found' })
  }

  let grantResult: { granted: boolean; reason?: string } = { granted: false, reason: 'not_paid' }
  if (paid) {
    await markCheckoutPaidAndNotify(sb, paymentResult.data)
    if (!paymentResult.data.aluno_id) {
      await sb.from('payment_webhook_events')
        .update({ processed: true, processed_at: now })
        .eq('id', inserted.id)
      return c.json({ ok: true, processed: true, enrollment_pending: true, reason: 'student_signup_pending' })
    }
    grantResult = String(paymentResult.data.product_type || paymentResult.data.raw_summary?.product_type || 'TURMA') === 'VIDEO_COURSE'
      ? await grantPaidVideoCourseEnrollment(sb, paymentResult.data)
      : await grantPaidEnrollment(sb, paymentResult.data)
    if (!grantResult.granted) {
      return c.json({ ok: true, processed: false, reason: grantResult.reason || 'enrollment_not_granted' })
    }
  }

  await sb.from('payment_webhook_events')
    .update({ processed: true, processed_at: now })
    .eq('id', inserted.id)

  return c.json({ ok: true })
})

app.post('/asaas/sandbox-reconciliation', requireAuth, runSandboxReconciliation)
app.post('/asaas/reconciliation', requireAuth, runSandboxReconciliation)

app.post('/asaas/sandbox-homologation', requireAuth, async (c) => {
  const user = c.get('user')
  if (!['ADMIN', 'CORRETOR', 'SUPERADMIN'].includes(user.role)) {
    return c.json({ error: 'Acesso negado.' }, 403)
  }
  if (c.env.ASAAS_ENV !== 'sandbox') {
    return c.json({ error: 'Homologação automática permitida apenas em sandbox.' }, 403)
  }
  if (!c.env.ASAAS_API_KEY) {
    return c.json({ error: 'ASAAS_API_KEY ausente.' }, 503)
  }

  const body = await c.req.json().catch(() => ({}))
  const sb = getAdmin(c.env)
  const siteSlug = String(body.site_slug || 'puppin-teste')
  const alunoEmail = String(body.aluno_email || 'aluno.puppin@gmail.com').toLowerCase()

  const { data: site, error: siteErr } = await sb.from('sites')
    .select('id, slug')
    .eq('slug', siteSlug)
    .maybeSingle()
  if (siteErr || !site) return c.json({ error: 'Site de homologação não encontrado.' }, 404)
  if (user.role !== 'SUPERADMIN' && user.site_id !== site.id) return c.json({ error: 'Acesso negado para este site.' }, 403)

  const [{ data: aluno }, { data: turma }] = await Promise.all([
    sb.from('profiles')
      .select('id, nome, role, site_id')
      .eq('site_id', site.id)
      .eq('role', 'ALUNO')
      .eq('ativo', true)
      .in('id', [
        ...(await sb.auth.admin.listUsers()).data.users
          .filter((item) => String(item.email || '').toLowerCase() === alunoEmail)
          .map((item) => item.id)
      ])
      .maybeSingle(),
    sb.from('turmas')
      .select('id, nome')
      .eq('site_id', site.id)
      .eq('status', 'ABERTA')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  ])
  if (!aluno) return c.json({ error: 'Aluno de homologação não encontrado ou não ativo.' }, 404)
  if (!turma) return c.json({ error: 'Turma aberta de homologação não encontrada.' }, 404)

  const externalReference = `ASAAS-HML-${crypto.randomUUID()}`
  const amountCents = 500
  const { data: payment, error: paymentErr } = await sb.from('payments')
    .insert({
      site_id: site.id,
      turma_id: turma.id,
      aluno_id: aluno.id,
      payer_email: alunoEmail,
      payer_name: aluno.nome || 'Aluno Homologação',
      provider: 'ASAAS',
      external_reference: externalReference,
      status: 'PENDING',
      amount_cents: amountCents,
      billing_type: 'PIX'
    })
    .select('id, external_reference')
    .single()
  if (paymentErr) return c.json({ error: 'Não foi possível criar o pagamento local.' }, 500)

  const gateway = getPaymentGateway(c.env)
  try {
    const customer = await gateway.createCustomer({
      name: aluno.nome || 'Aluno Homologação',
      email: alunoEmail,
      cpfCnpj: String(body.cpf_cnpj || '11144477735'),
      externalReference: `ALUNO:${aluno.id}`,
      notificationDisabled: true
    })
    const pixKey = await gateway.ensurePixKey()
    const charge: any = await gateway.createPixCharge({
      customerId: String(customer.id),
      value: 5,
      dueDate: tomorrowIsoDate(),
      description: `Homologação ${site.slug} - ${turma.nome}`,
      externalReference
    })
    const qrCode = await gateway.getPixQrCode(String(charge.id))
    const simulatePayment = body.simulate_payment !== false
    let simulatedPixPayment: any = null
    let simulationError: string | null = null
    if (simulatePayment && qrCode?.payload) {
      try {
        simulatedPixPayment = await gateway.payPixQrCode({
          payload: String(qrCode.payload),
          value: 5,
          description: `Pagamento sandbox ${externalReference}`
        })
      } catch (err: any) {
        simulationError = err?.message || 'asaas_pix_payment_simulation_failed'
      }
    }
    await sb.from('payments')
      .update({
        provider_payment_id: charge.id,
        provider_customer_id: customer.id,
        status: charge.status || 'PENDING',
        raw_summary: {
          sandbox: true,
          customer_id: customer.id,
          payment_id: charge.id,
          external_reference: externalReference,
          pix_key_ready: true,
          pix_key_created: pixKey.created,
          pix_key_status: pixKey.status || null,
          simulated_pix_payment: Boolean(simulatedPixPayment),
          simulated_pix_payment_id: simulatedPixPayment?.id || null,
          simulation_error: simulationError
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', payment.id)

    return c.json({
      ok: true,
      payment_id: payment.id,
      provider_payment_id: charge.id,
      external_reference: externalReference,
      status: charge.status || 'PENDING',
      value: 5,
      manual_action_required: Boolean(simulationError),
      simulation_error: simulationError,
      pix: {
        encodedImage: qrCode.encodedImage || null,
        payload: qrCode.payload || null,
        expirationDate: qrCode.expirationDate || null
      }
    })
  } catch (err: any) {
    await sb.from('payments')
      .update({
        status: 'FAILED',
        raw_summary: { sandbox: true, error: err?.message || 'asaas_error' },
        updated_at: new Date().toISOString()
      })
      .eq('id', payment.id)
    return c.json({ error: 'Falha na comunicação com Asaas Sandbox.' }, 502)
  }
})

app.post('/asaas/sandbox-homologation/:id/sync', requireAuth, async (c) => {
  const user = c.get('user')
  if (!['ADMIN', 'CORRETOR', 'SUPERADMIN'].includes(user.role)) {
    return c.json({ error: 'Acesso negado.' }, 403)
  }
  if (c.env.ASAAS_ENV !== 'sandbox') {
    return c.json({ error: 'Sincronização de homologação permitida apenas em sandbox.' }, 403)
  }

  const sb = getAdmin(c.env)
  const { data: payment, error: paymentErr } = await sb.from('payments')
    .select('id, site_id, turma_id, course_id, product_type, aluno_id, status, paid_at, billing_type, provider_payment_id, raw_summary')
    .eq('id', c.req.param('id'))
    .eq('provider', 'ASAAS')
    .single()
  if (paymentErr || !payment) return c.json({ error: 'Pagamento não encontrado.' }, 404)
  if (user.role !== 'SUPERADMIN' && user.site_id !== payment.site_id) {
    return c.json({ error: 'Acesso negado para este pagamento.' }, 403)
  }
  if (!payment.provider_payment_id) return c.json({ error: 'Pagamento sem ID no Asaas.' }, 400)

  const gateway = getPaymentGateway(c.env)
  const providerPayment = await gateway.getPayment(payment.provider_payment_id)
  const result = await applyProviderPaymentStatus(sb, payment, providerPayment)
  return c.json({ ok: result.synced, status: result.status, enrollment_granted: result.granted, reason: result.reason })
})

export { app as paymentRoutes }
