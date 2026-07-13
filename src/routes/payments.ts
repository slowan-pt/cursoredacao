import { Hono } from 'hono'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { getPaymentGateway, normalizeAsaasWebhookPayload, validateAsaasWebhookToken } from '../payments'
import { requireAuth } from '../middleware'

const app = new Hono<{ Bindings: Env }>()
const CMS_PREFIX = 'CMS:'

function defaultCms() {
  return {
    student_credits: {} as Record<string, { creditos?: number; vence_em?: string | null; updated_at?: string }>,
    enrollments: {} as Record<string, Record<string, { ativo?: boolean; origem?: string; created_at?: string; updated_at?: string }>>
  }
}

function parseCms(site: any) {
  const raw = (site?.allowed_origins || []).find((item: string) => String(item).startsWith(CMS_PREFIX))
  if (!raw) return defaultCms()
  try {
    const cms = JSON.parse(String(raw).slice(CMS_PREFIX.length))
    return {
      ...cms,
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

function isPaidStatus(status: string) {
  return status === 'CONFIRMED' || status === 'RECEIVED'
}

function tomorrowIsoDate() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return date.toISOString().slice(0, 10)
}

async function grantPaidEnrollment(sb: ReturnType<typeof getAdmin>, payment: any) {
  if (!payment?.site_id || !payment?.turma_id || !payment?.aluno_id) {
    return { granted: false, reason: 'missing_enrollment_target' }
  }

  const row = {
    site_id: payment.site_id,
    turma_id: payment.turma_id,
    aluno_id: payment.aluno_id,
    ativo: true,
    origem: 'ASAAS_WEBHOOK'
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
      origem: 'ASAAS_WEBHOOK',
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
    .select('id, site_id, turma_id, aluno_id, status')
    .maybeSingle()
  if (!paymentResult.data && normalized.externalReference) {
    paymentResult = await sb.from('payments')
      .update(patch)
      .eq('external_reference', normalized.externalReference)
      .select('id, site_id, turma_id, aluno_id, status')
      .maybeSingle()
  }

  if (paymentResult.error) {
    if (missingPaymentTables(paymentResult.error)) {
      return c.json({ error: 'Pagamentos ainda não estão preparados no banco.' }, 503)
    }
    return c.json({ error: 'Webhook registrado, mas pagamento não foi atualizado.' }, 202)
  }
  if (!paymentResult.data) {
    return c.json({ ok: true, processed: false, reason: 'payment_not_found' }, 202)
  }

  let grantResult: { granted: boolean; reason?: string } = { granted: false, reason: 'not_paid' }
  if (paid) {
    grantResult = await grantPaidEnrollment(sb, paymentResult.data)
    if (!grantResult.granted) {
      return c.json({ ok: true, processed: false, reason: grantResult.reason || 'enrollment_not_granted' }, 202)
    }
  }

  await sb.from('payment_webhook_events')
    .update({ processed: true, processed_at: now })
    .eq('id', inserted.id)

  return c.json({ ok: true })
})

app.post('/asaas/sandbox-homologation', requireAuth, async (c) => {
  const user = c.get('user')
  if (user.role !== 'ADMIN' && user.role !== 'SUPERADMIN') {
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
  if (user.role === 'ADMIN' && user.site_id !== site.id) return c.json({ error: 'Acesso negado para este site.' }, 403)

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
    const charge: any = await gateway.createPixCharge({
      customerId: String(customer.id),
      value: 5,
      dueDate: tomorrowIsoDate(),
      description: `Homologação ${site.slug} - ${turma.nome}`,
      externalReference
    })
    const qrCode = await gateway.getPixQrCode(String(charge.id))
    await sb.from('payments')
      .update({
        provider_payment_id: charge.id,
        provider_customer_id: customer.id,
        status: charge.status || 'PENDING',
        raw_summary: {
          sandbox: true,
          customer_id: customer.id,
          payment_id: charge.id,
          external_reference: externalReference
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

export { app as paymentRoutes }
