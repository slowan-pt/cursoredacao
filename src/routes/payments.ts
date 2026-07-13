import { Hono } from 'hono'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { normalizeAsaasWebhookPayload, validateAsaasWebhookToken } from '../payments'

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

export { app as paymentRoutes }
