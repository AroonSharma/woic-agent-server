import { createClient } from '@supabase/supabase-js';

export function supabaseService() {
  // Always create fresh client to avoid caching issues
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  
  if (!url || !key) {
    console.error('[supabaseServer] Missing environment variables:', {
      url: !!url,
      key: !!key,
      urlValue: url ? `${url.slice(0, 20)}...` : 'undefined',
      keyValue: key ? `${key.slice(0, 10)}...` : 'undefined'
    });
    throw new Error('Supabase service envs not configured');
  }
  
  // Create service role client with minimal config
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    global: {
      headers: {
        'Authorization': `Bearer ${key}`,
        'apikey': key,
        'Prefer': 'return=representation'
      }
    }
  });
}
