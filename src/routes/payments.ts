import { Hono } from 'hono'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { normalizeAsaasWebhookPayload, validateAsaasWebhookToken } from '../payments'

const app = new Hono<{ Bindings: Env }>()

function missingPaymentTables(error: any) {
  return /payments|payment_webhook_events|relation .* does not exist|schema cache/i.test(String(error?.message || ''))
}

function isPaidStatus(status: string) {
  return status === 'CONFIRMED' || status === 'RECEIVED'
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
  const paidAt = isPaidStatus(normalized.status) ? now : null
  let paymentUpdate = sb.from('payments')
    .update({
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
    })
  paymentUpdate = normalized.externalReference
    ? paymentUpdate.or(`provider_payment_id.eq.${normalized.providerPaymentId},external_reference.eq.${normalized.externalReference}`)
    : paymentUpdate.eq('provider_payment_id', normalized.providerPaymentId)
  const { error: updateErr } = await paymentUpdate

  if (updateErr) {
    if (missingPaymentTables(updateErr)) {
      return c.json({ error: 'Pagamentos ainda não estão preparados no banco.' }, 503)
    }
    return c.json({ error: 'Webhook registrado, mas pagamento não foi atualizado.' }, 202)
  }

  await sb.from('payment_webhook_events')
    .update({ processed: true, processed_at: now })
    .eq('id', inserted.id)

  return c.json({ ok: true })
})

export { app as paymentRoutes }
