// @ts-nocheck
import { jwtVerify } from 'jose';

export type AuthContext = {
  userId: string | null;
  email?: string;
};

// For HS256 tokens, we need the JWT secret from Supabase project settings
const JWT_SECRET = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!);

export async function verifyBearer(req: Request): Promise<AuthContext> {
  try {
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return { userId: null };
    
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return { 
      userId: payload.sub as string | null,
      email: payload.email as string
    };
  } catch (error) {
    console.error('[auth] JWT verification failed:', error);
    return { userId: null };
  }
}

// Backward compatibility
export async function getAuthContextFromRequest(req: Request): Promise<AuthContext> {
  return verifyBearer(req);
}
