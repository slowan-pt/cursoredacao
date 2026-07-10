import { createClient } from '@supabase/supabase-js'

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios')
}

const sb = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const { data: profiles, error } = await sb.from('profiles').select('id, nome, role, site_id')
console.log('Profiles:', JSON.stringify(profiles, null, 2))
if (error) console.error('Error:', error)

// Also check auth users
const { data: users } = await sb.auth.admin.listUsers()
console.log('\nAuth users:', users?.users?.map(u => ({ id: u.id, email: u.email, meta: u.user_metadata })))
