import { createClient } from '@supabase/supabase-js';

// Simple direct client - Auth UI needs synchronous access
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://vwatgqifhdxhesrupgrq.supabase.co';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ3YXRncWlmaGR4aGVzcnVwZ3JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3OTE5MzAsImV4cCI6MjA3MTM2NzkzMH0.SSnT450zYyZ3qo_QCJ84vfYjFBhbPRrLsbS2Bg371sA';

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function getAccessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || null;
  } catch {
    return null;
  }
}