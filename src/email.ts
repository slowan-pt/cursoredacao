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
  signupUrl?: string
  paymentUrl?: string
}

export type CorrectionReadyEmailInput = {
  to: string
  studentName: string
  courseName: string
  activityTitle: string
  resultUrl: string
}

export type PaymentStatusEmailInput = {
  to: string
  studentName: string
  courseName: string
  amount: string
  statusUrl: string
}

export type TeacherPaymentEmailInput = {
  to: string
  teacherName: string
  studentName: string
  courseName: string
  amount: string
  dashboardUrl: string
}

export type PasswordRecoveryEmailInput = {
  to: string
  name: string
  recoveryUrl: string
  siteName?: string
  teacherName?: string
}

export type EmailResult = {
  sent: boolean
  provider: 'disabled' | 'mock' | 'resend' | 'brevo'
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

export class MockEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<EmailResult> {
    if (!message.to || !message.subject || !message.html) {
      return { sent: false, provider: 'mock', reason: 'invalid_message' }
    }
    return { sent: true, provider: 'mock', id: `mock_${crypto.randomUUID()}` }
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

function parseEmailFrom(value: string) {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() }
  return { email: value.trim() }
}

class BrevoEmailProvider implements EmailProvider {
  constructor(private readonly env: Env) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    if (!this.env.BREVO_API_KEY) {
      return { sent: false, provider: 'brevo', reason: 'missing_api_key' }
    }
    const from = parseEmailFrom(this.env.EMAIL_FROM || 'Redação com Estratégia <no-reply@redacaocomestrategia.com.br>')
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': this.env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        sender: from,
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text
      })
    })
    const data = await response.json().catch(() => null) as { messageId?: string } | null
    if (!response.ok) {
      return { sent: false, provider: 'brevo', reason: `brevo_${response.status}` }
    }
    return { sent: true, provider: 'brevo', id: data?.messageId }
  }
}

export function getEmailProvider(env: Env): EmailProvider {
  const config = getConfig(env)
  if (!config.flags.emails) return new DisabledEmailProvider()
  if (String(env.EMAIL_PROVIDER || '').trim().toLowerCase() === 'brevo') return new BrevoEmailProvider(env)
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
    `Recebemos sua solicitação de matrícula da turma "${input.courseName}".`,
    `Código único: ${input.checkoutCode}`,
    `Transação: ${input.transactionId}`,
    '',
    'Guarde esse código. Ele vincula sua matrícula caso você crie o cadastro depois.',
    '',
    input.signupUrl ? `Link para criar cadastro: ${input.signupUrl}` : '',
    input.paymentUrl ? `Link do pagamento: ${input.paymentUrl}` : ''
  ].join('\n')

  return {
    to: input.to,
    subject: `Crie seu cadastro — ${input.courseName}`,
    text: body,
    html: renderBasicEmail('Matrícula recebida', body, { label: 'Criar cadastro', url: input.signupUrl || input.loginUrl })
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

export function renderPaymentApprovedEmail(input: PaymentStatusEmailInput): EmailMessage {
  const body = [
    `Olá, ${input.studentName}.`,
    '',
    `Seu pagamento da turma "${input.courseName}" foi aprovado.`,
    `Valor: ${input.amount}`,
    '',
    'Sua matrícula já pode ser acessada pela plataforma.'
  ].join('\n')

  return {
    to: input.to,
    subject: `Pagamento aprovado — ${input.courseName}`,
    text: body,
    html: renderBasicEmail('Pagamento aprovado', body, { label: 'Acessar minha turma', url: input.statusUrl })
  }
}

export function renderPaymentOverdueEmail(input: PaymentStatusEmailInput): EmailMessage {
  const body = [
    `Olá, ${input.studentName}.`,
    '',
    `O pagamento da turma "${input.courseName}" consta como vencido.`,
    `Valor: ${input.amount}`,
    '',
    'Se você já pagou, aguarde a compensação ou fale com o professor responsável.'
  ].join('\n')

  return {
    to: input.to,
    subject: `Pagamento vencido — ${input.courseName}`,
    text: body,
    html: renderBasicEmail('Pagamento vencido', body, { label: 'Ver situação', url: input.statusUrl })
  }
}

export function renderPaymentRefundedEmail(input: PaymentStatusEmailInput): EmailMessage {
  const body = [
    `Olá, ${input.studentName}.`,
    '',
    `Registramos alteração de reembolso/estorno no pagamento da turma "${input.courseName}".`,
    `Valor original: ${input.amount}`,
    '',
    'A situação do acesso será analisada conforme a política definida pelo professor/plataforma.'
  ].join('\n')

  return {
    to: input.to,
    subject: `Atualização do pagamento — ${input.courseName}`,
    text: body,
    html: renderBasicEmail('Atualização do pagamento', body, { label: 'Ver situação', url: input.statusUrl })
  }
}

export function renderTeacherNewPaidStudentEmail(input: TeacherPaymentEmailInput): EmailMessage {
  const body = [
    `Olá, ${input.teacherName}.`,
    '',
    `${input.studentName} pagou a turma "${input.courseName}".`,
    `Valor: ${input.amount}`,
    '',
    'A matrícula foi liberada automaticamente quando o webhook confirmou o pagamento.'
  ].join('\n')

  return {
    to: input.to,
    subject: `Novo aluno pago — ${input.courseName}`,
    text: body,
    html: renderBasicEmail('Novo aluno pago', body, { label: 'Abrir painel', url: input.dashboardUrl })
  }
}

export function renderPasswordRecoveryEmail(input: PasswordRecoveryEmailInput): EmailMessage {
  const siteName = input.siteName || 'Redação com Estratégia'
  const teacherLine = input.teacherName ? `Site/professor: ${input.teacherName}` : `Site: ${siteName}`
  const body = [
    `Olá, ${input.name}.`,
    '',
    `Recebemos uma solicitação de recuperação de senha no ${siteName}.`,
    teacherLine,
    '',
    'Use o botão abaixo para criar uma nova senha com segurança.',
    '',
    'Se você não solicitou essa recuperação, ignore este e-mail.'
  ].join('\n')

  return {
    to: input.to,
    subject: `Recuperação de senha — ${siteName}`,
    text: `${body}\n\n${input.recoveryUrl}`,
    html: renderBasicEmail(`Recuperação de senha — ${siteName}`, body, { label: 'Redefinir senha', url: input.recoveryUrl })
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
