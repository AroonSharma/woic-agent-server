// Phase 2: HealthStore with basic caching and circuit breaker

type Capability = 'llm' | 'stt' | 'tts';

export interface ProviderKey {
  capability: Capability;
  name: string; // e.g., 'openai', 'deepgram', 'elevenlabs'
}

interface HealthRecord {
  status: boolean;
  checkedAt: number;
  failures: number;
  openUntil: number; // circuit breaker open until timestamp (ms)
}

export class HealthStore {
  private cache = new Map<string, HealthRecord>();
  constructor(
    private ttlMs = 30_000,
    private failureThreshold = 3,
    private openMs = 60_000
  ) {}

  private keyOf(k: ProviderKey): string {
    return `${k.capability}:${k.name}`;
  }

  getCached(k: ProviderKey): HealthRecord | undefined {
    const rec = this.cache.get(this.keyOf(k));
    if (!rec) return undefined;
    const fresh = Date.now() - rec.checkedAt <= this.ttlMs;
    if (!fresh) return undefined;
    return rec;
  }

  async check(k: ProviderKey, fn: () => Promise<boolean>, timeoutMs = 2500): Promise<boolean> {
    const key = this.keyOf(k);
    const now = Date.now();
    const rec = this.cache.get(key);
    if (rec && rec.openUntil > now) {
      return false; // circuit breaker open
    }
    const cached = this.getCached(k);
    if (cached) return cached.status;

    const timed = new Promise<boolean>((resolve) => {
      const to = setTimeout(() => resolve(false), timeoutMs);
      fn().then((ok) => { clearTimeout(to); resolve(Boolean(ok)); }).catch(() => { clearTimeout(to); resolve(false); });
    });

    const ok = await timed;
    const failures = ok ? 0 : (rec?.failures ?? 0) + 1;
    const openUntil = failures >= this.failureThreshold ? now + this.openMs : 0;
    this.cache.set(key, { status: ok, checkedAt: now, failures: ok ? 0 : failures, openUntil });
    return ok;
  }
}

