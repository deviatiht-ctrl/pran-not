/* =====================================================================
   PRAN NÒT - supabase.js
   SEUL endroit où le client Supabase est initialisé.
   Exposé globalement via window.db.
   Prérequis : <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   ===================================================================== */
import './theme.js';

// Configuration active du projet Supabase (Pran Nòt)
// La clé "anon" est publique par conception : la sécurité repose sur la RLS.
export const SUPABASE_URL = 'https://oykuhhogcdbmoybskexd.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95a3VoaG9nY2RibW95YnNrZXhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTk1OTksImV4cCI6MjA5NjQ5NTU5OX0.xbIdgA6-DCILYkDQcl_VzWgz7HmIlHYhmRp0u_a87F4';

if (!window.supabase || typeof window.supabase.createClient !== 'function') {
  throw new Error('Supabase JS v2 non chargé : ajoutez le script CDN avant les modules.');
}

if (!window.db) {
  window.db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
    realtime: { params: { eventsPerSecond: 5 } },
  });
}

export const db = window.db;
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

/** Indique si la configuration Supabase est renseignée. */
export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Détecte l'ouverture directe du fichier via file:// (ES modules bloqués par CORS). */
export const isFileProtocol = typeof window !== 'undefined' && window.location?.protocol === 'file:';

export default db;
