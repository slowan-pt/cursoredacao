import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import type { Env } from './types'
import { authRoutes } from './routes/auth'
import { superadminRoutes } from './routes/superadmin'
import { adminRoutes } from './routes/admin'
import { alunoRoutes } from './routes/aluno'
import { siteRoutes } from './routes/site'

const app = new Hono<{ Bindings: Env }>()

app.use('*', secureHeaders({
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff'
}))

app.route('/api/auth', authRoutes)
app.route('/api/superadmin', superadminRoutes)
app.route('/api/admin', adminRoutes)
app.route('/api/aluno', alunoRoutes)
app.route('/', siteRoutes)

app.notFound((c) => c.json({ error: 'Rota não encontrada' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Erro interno do servidor' }, 500)
})

export default app
