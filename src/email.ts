import { getConfig } from './config'
import type { Env } from './types'

export type EmailMessage = {
  to: string
  subject: string
  html: string
  text?: string
}

export type CheckoutReceiptEmailInput = {
  to: string
  studentName: string
  courseName: string
  checkoutCode: string
  transactionId: string
  loginUrl: string
}

export type CorrectionReadyEmailInput = {
  to: string
  studentName: string
  courseName: string
  activityTitle: string
  resultUrl: string
}

export type EmailResult = {
  sent: boolean
  provider: 'disabled' | 'resend'
  id?: string
  reason?: string
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailResult>
}

class DisabledEmailProvider implements EmailProvider {
  async send(): Promise<EmailResult> {
    return { sent: false, provider: 'disabled', reason: 'emails_disabled' }
  }
}

class ResendEmailProvider implements EmailProvider {
  constructor(private readonly env: Env) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    if (!this.env.RESEND_API_KEY) {
      return { sent: false, provider: 'resend', reason: 'missing_api_key' }
    }
    const from = this.env.EMAIL_FROM || 'Redação com Estratégia <no-reply@redacaocomestrategia.com.br>'
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.env.RESEND_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text
      })
    })
    const data = await response.json().catch(() => null) as { id?: string } | null
    if (!response.ok) {
      return { sent: false, provider: 'resend', reason: `resend_${response.status}` }
    }
    return { sent: true, provider: 'resend', id: data?.id }
  }
}

export function getEmailProvider(env: Env): EmailProvider {
  const config = getConfig(env)
  if (!config.flags.emails) return new DisabledEmailProvider()
  return new ResendEmailProvider(env)
}

export function renderBasicEmail(title: string, body: string, action?: { label: string; url: string }) {
  const escapedTitle = escapeHtml(title)
  const escapedBody = escapeHtml(body).replace(/\n/g, '<br>')
  const actionHtml = action
    ? `<p><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 16px;border-radius:8px;background:#1A3A2A;color:#fff;text-decoration:none;font-weight:700">${escapeHtml(action.label)}</a></p>`
    : ''
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;line-height:1.5"><h1>${escapedTitle}</h1><p>${escapedBody}</p>${actionHtml}</body></html>`
}

export function renderCheckoutReceiptEmail(input: CheckoutReceiptEmailInput): EmailMessage {
  const body = [
    `Olá, ${input.studentName}.`,
    '',
    `Recebemos a simulação de pagamento da turma "${input.courseName}".`,
    `Código único: ${input.checkoutCode}`,
    `Transação: ${input.transactionId}`,
    '',
    'Guarde esse código. Ele vincula sua matrícula caso você crie o cadastro depois.'
  ].join('\n')

  return {
    to: input.to,
    subject: `Matrícula recebida — ${input.courseName}`,
    text: body,
    html: renderBasicEmail('Matrícula recebida', body, { label: 'Acessar plataforma', url: input.loginUrl })
  }
}

export function renderCorrectionReadyEmail(input: CorrectionReadyEmailInput): EmailMessage {
  const body = [
    `Olá, ${input.studentName}.`,
    '',
    `Sua redação "${input.activityTitle}" da turma "${input.courseName}" já foi corrigida.`,
    '',
    'Acesse a plataforma para visualizar os comentários e baixar a correção.'
  ].join('\n')

  return {
    to: input.to,
    subject: `Correção disponível — ${input.activityTitle}`,
    text: body,
    html: renderBasicEmail('Correção disponível', body, { label: 'Ver correção', url: input.resultUrl })
  }
}

function escapeHtml(value: string) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char] || char))
}
