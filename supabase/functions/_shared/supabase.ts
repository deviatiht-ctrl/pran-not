// Clients Supabase pour les Edge Functions (utilisateur + service_role)
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export function createAdminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function authenticateUser(req: Request) {
  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const authHeader = req.headers.get('Authorization') || '';

  if (!authHeader.startsWith('Bearer ')) {
    return { error: 'not_authenticated', status: 401 };
  }

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error } = await userClient.auth.getUser();
  if (error || !userData?.user) {
    return { error: 'invalid_token', status: 401 };
  }

  const admin = createAdminClient();
  let { data: profile } = await admin
    .from('pran_not_profiles')
    .select('id, email, full_name, faculty_id, level, language, ai_daily_quota, is_banned')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (!profile) {
    await userClient.rpc('pran_not_ensure_profile');
    const retry = await admin
      .from('pran_not_profiles')
      .select('id, email, full_name, faculty_id, level, language, ai_daily_quota, is_banned')
      .eq('id', userData.user.id)
      .maybeSingle();
    profile = retry.data;
  }

  if (profile?.is_banned) {
    return { error: 'account_banned', status: 403 };
  }

  return { user: userData.user, profile, admin, userClient };
}
