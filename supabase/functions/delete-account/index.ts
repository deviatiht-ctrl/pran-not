// @ts-nocheck
/* =====================================================================
   PRAN NÒT - supabase/functions/delete-account/index.ts
   Efase tout done yon etidyan + kont auth li.
   Requires: Authorization header with valid JWT.
   ===================================================================== */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // Verify user identity via anon client
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user }, error: userError } = await userClient.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // Admin client to delete data
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const uid = user.id

    // Delete in FK-safe order (child tables first)
    const tables = [
      { table: 'pran_not_live_transfers', col: 'sender_id' },
      { table: 'pran_not_notes', col: 'user_id' },
      { table: 'pran_not_assignments', col: 'user_id' },
      { table: 'pran_not_courses', col: 'user_id' },
      { table: 'pran_not_semesters', col: 'user_id' },
      { table: 'pran_not_profiles', col: 'id' },
    ]

    for (const { table, col } of tables) {
      await adminClient.from(table).delete().eq(col, uid)
    }

    // Delete auth user (irreversible)
    const { error: delErr } = await adminClient.auth.admin.deleteUser(uid)
    if (delErr) throw delErr

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
