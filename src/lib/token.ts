// @ts-nocheck
export type TokenResponse = {
  token: string;
  wsUrl?: string | null;
};

export async function fetchToken(params: {
  roomName: string;
  userIdentity: string;
  userName?: string;
  ttlSeconds?: number;
}): Promise<TokenResponse> {
  const res = await fetch(`/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token fetch failed: ${res.status} ${text}`);
  }
  return (await res.json()) as TokenResponse;
}
