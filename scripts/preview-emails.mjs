import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src', 'email.ts')
const outDir = path.join(root, 'tmp', 'email-previews')
const modulePath = path.join(outDir, 'email-preview-module.mjs')

fs.mkdirSync(outDir, { recursive: true })

const source = fs.readFileSync(sourcePath, 'utf8')
  .replace("import { getConfig } from './config'\n", "const getConfig = (env) => ({ flags: { emails: env.ENABLE_EMAILS === 'true' } })\n")
  .replace("import type { Env } from './types'\n", '')

const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true
  }
}).outputText

fs.writeFileSync(modulePath, transpiled)

const email = await import(pathToFileURL(modulePath).href)
const samples = [
  email.renderCheckoutReceiptEmail({
    to: 'aluno@example.com',
    studentName: 'Aluno Exemplo',
    courseName: 'Turma de Redação',
    checkoutCode: 'ABC123',
    transactionId: 'pay_sandbox',
    loginUrl: 'https://redacaocomestrategia.com.br/login.html'
  }),
  email.renderCorrectionReadyEmail({
    to: 'aluno@example.com',
    studentName: 'Aluno Exemplo',
    courseName: 'Turma de Redação',
    activityTitle: 'Tema de homologação',
    resultUrl: 'https://redacaocomestrategia.com.br/aluno/'
  }),
  email.renderPaymentApprovedEmail({
    to: 'aluno@example.com',
    studentName: 'Aluno Exemplo',
    courseName: 'Turma de Redação',
    amount: 'R$ 5,00',
    statusUrl: 'https://redacaocomestrategia.com.br/aluno/'
  }),
  email.renderPaymentOverdueEmail({
    to: 'aluno@example.com',
    studentName: 'Aluno Exemplo',
    courseName: 'Turma de Redação',
    amount: 'R$ 5,00',
    statusUrl: 'https://redacaocomestrategia.com.br/aluno/'
  }),
  email.renderPaymentRefundedEmail({
    to: 'aluno@example.com',
    studentName: 'Aluno Exemplo',
    courseName: 'Turma de Redação',
    amount: 'R$ 5,00',
    statusUrl: 'https://redacaocomestrategia.com.br/aluno/'
  }),
  email.renderTeacherNewPaidStudentEmail({
    to: 'professor@example.com',
    teacherName: 'Professor Exemplo',
    studentName: 'Aluno Exemplo',
    courseName: 'Turma de Redação',
    amount: 'R$ 5,00',
    dashboardUrl: 'https://redacaocomestrategia.com.br/professor/'
  }),
  email.renderPasswordRecoveryEmail({
    to: 'aluno@example.com',
    name: 'Aluno Exemplo',
    recoveryUrl: 'https://redacaocomestrategia.com.br/redefinir-senha.html'
  })
]

const provider = new email.MockEmailProvider()
for (const [index, message] of samples.entries()) {
  const name = `${String(index + 1).padStart(2, '0')}-${message.subject.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.html`
  fs.writeFileSync(path.join(outDir, name), message.html)
  const result = await provider.send(message)
  if (!result.sent) throw new Error(`MockEmailProvider falhou para ${message.subject}`)
}

console.log(`Previews gerados em ${outDir}`)
console.log(`Templates validados: ${samples.length}`)
