import fs from 'fs'

const migration = fs.readFileSync('migrations/007_financial_module.sql', 'utf8') + '\n' + fs.readFileSync('migrations/008_financial_statuses.sql', 'utf8') + '\n' + fs.readFileSync('migrations/009_financial_transactions.sql', 'utf8')
const admin = fs.readFileSync('src/routes/admin.ts', 'utf8')
const professor = fs.readFileSync('public/professor/index.html', 'utf8')

const requiredTables = [
  'financial_settings',
  'correction_compensation_rules',
  'correction_compensation_entries',
  'teacher_payment_closings',
  'teacher_payouts',
  'financial_adjustments',
  'financial_audit_logs',
  'financial_idempotency_keys'
]

const requiredStatuses = [
  'AWAITING_CLOSING',
  'IN_CLOSING',
  'APPROVED',
  'PARTIALLY_PAID',
  'PAID',
  'DISPUTED'
]

const requiredRoutes = [
  "app.get('/financial/summary'",
  "app.get('/financial/compensations'",
  "app.get('/financial/payables'",
  "app.post('/financial/closings'",
  "app.post('/financial/closings/:id/payouts'",
  "app.post('/financial/closings/:id/adjustments'",
  "app.post('/financial/closings/:id/cancel'",
  "app.post('/financial/payouts/:id/reverse'"
]

const requiredRpcs = [
  'create_teacher_closing',
  'approve_teacher_closing',
  'add_teacher_closing_adjustment',
  'register_teacher_payout',
  'cancel_teacher_closing',
  'reverse_teacher_payout'
]

for (const table of requiredTables) {
  if (!migration.includes(table)) throw new Error(`Tabela financeira ausente na migration: ${table}`)
}

for (const status of requiredStatuses) {
  if (!migration.includes(status) || !admin.includes(status)) throw new Error(`Status financeiro sem cobertura: ${status}`)
}

for (const route of requiredRoutes) {
  if (!admin.includes(route)) throw new Error(`Rota financeira ausente: ${route}`)
}

for (const rpc of requiredRpcs) {
  if (!migration.includes(`FUNCTION public.${rpc}`)) throw new Error(`RPC financeira ausente na migration: ${rpc}`)
  if (!admin.includes(`.rpc('${rpc}'`)) throw new Error(`Backend nao usa RPC financeira: ${rpc}`)
}

if (!admin.includes('ensureCorrectionCompensationEntry')) throw new Error('Gatilho financeiro de correção ausente.')
if (!admin.includes('UNIQUE (correction_id)') && !migration.includes('UNIQUE (correction_id)')) throw new Error('Idempotência por correction_id ausente.')
if (!professor.includes('Meus Ganhos') || !professor.includes('Correções a pagar') || !professor.includes('Módulo financeiro em homologação')) throw new Error('Interface financeira mínima ausente.')

console.log('Módulo financeiro validado estruturalmente.')
