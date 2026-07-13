import { getConfig } from './config'
import type { Env } from './types'

export type PaymentStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'RECEIVED'
  | 'OVERDUE'
  | 'CANCELED'
  | 'REFUNDED'
  | 'CHARGEBACK'
  | 'FAILED'

export type CreatePixChargeInput = {
  customerId: string
  value: number
  dueDate: string
  description: string
  externalReference: string
}

export type CreateCustomerInput = {
  name: string
  email?: string
  cpfCnpj?: string
  externalReference?: string
  notificationDisabled?: boolean
}

export type AsaasWebhookPayload = {
  id?: string
  event?: string
  payment?: {
    id?: string
    status?: string
    externalReference?: string
    value?: number
    netValue?: number
    billingType?: string
    customer?: string
  }
}

function describeAsaasError(status: number, data: any) {
  const errors = Array.isArray(data?.errors)
    ? data.errors
      .map((item: any) => [item?.code, item?.description].filter(Boolean).join(': '))
      .filter(Boolean)
    : []
  const message = errors.length ? ` ${errors.slice(0, 3).join(' | ')}` : ''
  return `Asaas retornou erro ${status}.${message}`
}

export type NormalizedPaymentWebhook = {
  provider: 'ASAAS'
  providerEventId: string
  providerPaymentId: string
  event: string
  status: PaymentStatus
  externalReference: string | null
  raw: AsaasWebhookPayload
  idempotencyKey: string
}

export type PaymentGateway = {
  createCustomer(input: CreateCustomerInput): Promise<any>
  createPixCharge(input: CreatePixChargeInput): Promise<unknown>
  getPixQrCode(paymentId: string): Promise<any>
  ensurePixKey(): Promise<{ created: boolean; status?: string }>
  payPixQrCode(input: { payload: string; value: number; description?: string }): Promise<any>
}

const ASAAS_BASE_URLS = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3'
}

function asaasEnv(env: Env) {
  return env.ASAAS_ENV === 'production' ? 'production' : 'sandbox'
}

function requireAsaasApiKey(env: Env) {
  if (!env.ASAAS_API_KEY) throw new Error('ASAAS_API_KEY ausente.')
  return env.ASAAS_API_KEY
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 12000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

export function normalizeAsaasPaymentStatus(status: string): PaymentStatus {
  const value = String(status || '').toUpperCase()
  if (['CONFIRMED'].includes(value)) return 'CONFIRMED'
  if (['RECEIVED', 'RECEIVED_IN_CASH'].includes(value)) return 'RECEIVED'
  if (['OVERDUE'].includes(value)) return 'OVERDUE'
  if (['DELETED', 'CANCELED'].includes(value)) return 'CANCELED'
  if (['REFUNDED', 'PARTIALLY_REFUNDED'].includes(value)) return 'REFUNDED'
  if (['CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL'].includes(value)) return 'CHARGEBACK'
  if (['PENDING'].includes(value)) return 'PENDING'
  return 'FAILED'
}

export function validateAsaasWebhookToken(env: Env, request: Request) {
  const expected = env.ASAAS_WEBHOOK_TOKEN
  if (!expected) return false
  const received = request.headers.get('asaas-access-token')
  return Boolean(received && received === expected)
}

export function buildPaymentWebhookIdempotencyKey(provider: string, providerEventId: string) {
  const normalizedProvider = String(provider || '').trim().toUpperCase()
  const normalizedEventId = String(providerEventId || '').trim()
  if (!normalizedProvider || !normalizedEventId) throw new Error('Evento de pagamento sem chave de idempotência.')
  return `${normalizedProvider}:${normalizedEventId}`
}

export function normalizeAsaasWebhookPayload(payload: unknown): NormalizedPaymentWebhook {
  const data = (payload || {}) as AsaasWebhookPayload
  const event = String(data.event || '').trim()
  const providerPaymentId = String(data.payment?.id || '').trim()
  const providerEventId = String(data.id || `${event}:${providerPaymentId}`).trim()
  if (!event) throw new Error('Webhook Asaas sem evento.')
  if (!providerPaymentId) throw new Error('Webhook Asaas sem pagamento.')

  return {
    provider: 'ASAAS',
    providerEventId,
    providerPaymentId,
    event,
    status: normalizeAsaasPaymentStatus(String(data.payment?.status || '')),
    externalReference: data.payment?.externalReference || null,
    raw: data,
    idempotencyKey: buildPaymentWebhookIdempotencyKey('ASAAS', providerEventId)
  }
}

class DisabledPaymentGateway implements PaymentGateway {
  async createCustomer(): Promise<unknown> {
    throw new Error('Pagamentos temporariamente indisponíveis.')
  }

  async createPixCharge(): Promise<unknown> {
    throw new Error('Pagamentos temporariamente indisponíveis.')
  }

  async getPixQrCode(): Promise<unknown> {
    throw new Error('Pagamentos temporariamente indisponíveis.')
  }

  async ensurePixKey(): Promise<{ created: boolean }> {
    throw new Error('Pagamentos temporariamente indisponíveis.')
  }

  async payPixQrCode(): Promise<unknown> {
    throw new Error('Pagamentos temporariamente indisponíveis.')
  }
}

class AsaasGateway implements PaymentGateway {
  constructor(private readonly env: Env) {}

  private async request(path: string, init: RequestInit) {
    const baseUrl = ASAAS_BASE_URLS[asaasEnv(this.env)]
    const response = await fetchWithTimeout(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'redacao-com-estrategia/1.0',
        access_token: requireAsaasApiKey(this.env),
        ...(init.headers || {})
      }
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(describeAsaasError(response.status, data))
    }
    return data
  }

  async createPixCharge(input: CreatePixChargeInput) {
    return this.request('/payments', {
      method: 'POST',
      body: JSON.stringify({
        customer: input.customerId,
        billingType: 'PIX',
        value: input.value,
        dueDate: input.dueDate,
        description: input.description,
        externalReference: input.externalReference
      })
    })
  }

  async createCustomer(input: CreateCustomerInput) {
    return this.request('/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        email: input.email,
        cpfCnpj: input.cpfCnpj,
        externalReference: input.externalReference,
        notificationDisabled: input.notificationDisabled ?? true
      })
    })
  }

  async getPixQrCode(paymentId: string) {
    return this.request(`/payments/${encodeURIComponent(paymentId)}/pixQrCode`, {
      method: 'GET'
    })
  }

  async ensurePixKey() {
    const active: any = await this.request('/pix/addressKeys?status=ACTIVE&limit=100&offset=0', {
      method: 'GET'
    })
    if (Array.isArray(active?.data) && active.data.length > 0) {
      return { created: false, status: 'ACTIVE' }
    }
    const created: any = await this.request('/pix/addressKeys', {
      method: 'POST',
      body: JSON.stringify({ type: 'EVP' })
    })
    return { created: true, status: created?.status }
  }

  async payPixQrCode(input: { payload: string; value: number; description?: string }) {
    return this.request('/pix/qrCodes/pay', {
      method: 'POST',
      body: JSON.stringify({
        qrCode: { payload: input.payload },
        value: input.value,
        description: input.description
      })
    })
  }
}

export function getPaymentGateway(env: Env): PaymentGateway {
  const config = getConfig(env)
  if (!config.flags.payments) return new DisabledPaymentGateway()
  return new AsaasGateway(env)
}
