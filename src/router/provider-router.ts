// Phase 2 scaffold: Deterministic provider router (skeleton only)

import type { LLMProvider } from '../providers/llm/base';
import type { STTProvider } from '../providers/stt/base';
import type { TTSProvider } from '../providers/tts/base';
import { ProviderFactory } from '../providers/factory';
import { HealthStore } from './health-store';

export type Tier = 'free' | 'pro' | 'enterprise';
export type Complexity = 'simple' | 'complex';

export interface RoutingRules {
  tierDefaults?: { llm?: string; stt?: string; tts?: string };
  budgets?: { perRequestUSD?: number; perMonthUSD?: number };
}

export interface HealthStatus {
  llm: Record<string, boolean>;
  stt: Record<string, boolean>;
  tts: Record<string, boolean>;
}

export interface RouteContext {
  tier: Tier;
  complexity: Complexity;
  budgetUSD?: number;
}

export interface SelectedProviders {
  llm: LLMProvider;
  stt: STTProvider;
  tts: TTSProvider;
  reasons: string[];
}

export class ProviderRouter {
  constructor(private rules: RoutingRules, private health: HealthStatus, private healthStore = new HealthStore()) {}

  // Skeleton deterministic selection; real logic to be added in Phase 2
  async select(ctx: RouteContext): Promise<SelectedProviders> {
    const reasons: string[] = [];
    // Simple price sheet (illustrative; refine in Phase 4)
    const PRICES = {
      llm: { openai: { perToken: 0.00000015 } }, // $0.15 / 1M tokens
      stt: { deepgram: { perMinUSD: 0.0125 } },  // placeholder
      tts: { elevenlabs: { perCharUSD: 0.00001 } } // placeholder
    } as const;

    // Updated provider candidates
    const llmCandidates: Array<{ key: 'gemini' | 'anthropic' | 'openai'; create: () => LLMProvider }> = [
      { key: 'gemini', create: () => ProviderFactory.createLLM('gemini') },
      { key: 'anthropic', create: () => ProviderFactory.createLLM('anthropic') },
      { key: 'openai', create: () => ProviderFactory.createLLM('openai') },
    ];
    // STT: Deepgram only (real-time streaming)
    const sttCandidates: Array<{ key: 'deepgram'; create: () => STTProvider }> = [
      { key: 'deepgram', create: () => ProviderFactory.createSTT('deepgram') },
    ];
    // TTS: ElevenLabs primary, OpenAI fallback
    const ttsCandidates: Array<{ key: 'elevenlabs' | 'openai'; create: () => TTSProvider }> = [
      { key: 'elevenlabs', create: () => ProviderFactory.createTTS('elevenlabs') },
      { key: 'openai', create: () => ProviderFactory.createTTS('openai') },
    ];

    // Routing heuristics (deterministic skeleton): tier/complexity/budget hooks
    reasons.push(`ctx.tier=${ctx.tier}`, `ctx.complexity=${ctx.complexity}`, `ctx.budgetUSD=${ctx.budgetUSD ?? 'na'}`);

    // LLM selection (budget-aware placeholder)
    let llm = llmCandidates[2].create();
    let llmName = llmCandidates[2].key;
    console.log("LLM Canddate", llm)
    const llmHealthy = await this.healthStore.check({ capability: 'llm', name: llmName }, () => llm.healthCheck());
    if (ctx.budgetUSD !== undefined && ctx.budgetUSD < 0.001) {
      reasons.push(`llm.budget=low(${ctx.budgetUSD})`);
    } else {
      reasons.push(`llm.budget=ok(${ctx.budgetUSD ?? 'na'})`);
    }
    if (!llmHealthy) {
      reasons.push(`llm.${llmName}=unhealthy`);
      // Fallback chain (single for now)
      reasons.push('llm.fallback=none');
    } else {
      reasons.push(`llm.${llmName}=healthy`);
    }

    // STT selection
    let stt = sttCandidates[0].create();
    let sttName = sttCandidates[0].key;
    const sttHealthy = await (stt.healthCheck ? this.healthStore.check({ capability: 'stt', name: sttName }, () => stt.healthCheck!()) : Promise.resolve(true));
    // p50 utterance ~3s speech => ~0.0006 USD at 0.0125/min (illustrative)
    if (ctx.budgetUSD !== undefined && ctx.budgetUSD < 0.0006) {
      reasons.push(`stt.budget=low(${ctx.budgetUSD})`);
    } else {
      reasons.push(`stt.budget=ok(${ctx.budgetUSD ?? 'na'})`);
    }
    if (!sttHealthy) {
      reasons.push(`stt.${sttName}=unhealthy`);
      // Try the next candidate if available (simple fallback)
      if (sttCandidates.length > 1) {
        const alt = sttCandidates[1];
        try {
          const altInst = alt.create();
          const ok = await (altInst.healthCheck ? this.healthStore.check({ capability: 'stt', name: alt.key }, () => altInst.healthCheck!()) : Promise.resolve(true));
          if (ok) {
            stt = altInst;
            sttName = alt.key;
            reasons.push(`stt.fallback=${alt.key}`, `stt.${alt.key}=healthy`);
          } else {
            reasons.push(`stt.fallback=${alt.key}`, `stt.${alt.key}=unhealthy`);
          }
        } catch {
          reasons.push(`stt.fallback=${alt.key}`, 'stt.fallback_error');
        }
      } else {
        reasons.push('stt.fallback=none');
      }
    } else {
      reasons.push(`stt.${sttName}=healthy`);
    }

    // TTS selection
    let tts = ttsCandidates[0].create();
    let ttsName = ttsCandidates[0].key;
    const ttsHealthy = await this.healthStore.check({ capability: 'tts', name: ttsName }, () => tts.healthCheck());
    // Assume 200 chars => ~0.002 USD (illustrative)
    if (ctx.budgetUSD !== undefined && ctx.budgetUSD < 0.002) {
      reasons.push(`tts.budget=low(${ctx.budgetUSD})`);
    } else {
      reasons.push(`tts.budget=ok(${ctx.budgetUSD ?? 'na'})`);
    }
    if (!ttsHealthy) {
      reasons.push(`tts.${ttsName}=unhealthy`);
      if (ttsCandidates.length > 1) {
        const alt = ttsCandidates[1];
        try {
          const altInst = alt.create();
          const ok = await this.healthStore.check({ capability: 'tts', name: alt.key }, () => altInst.healthCheck());
          if (ok) {
            tts = altInst;
            ttsName = alt.key;
            reasons.push(`tts.fallback=${alt.key}`, `tts.${alt.key}=healthy`);
          } else {
            reasons.push(`tts.fallback=${alt.key}`, `tts.${alt.key}=unhealthy`);
          }
        } catch {
          reasons.push(`tts.fallback=${alt.key}`, 'tts.fallback_error');
        }
      } else {
        reasons.push('tts.fallback=none');
      }
    } else {
      reasons.push(`tts.${ttsName}=healthy`);
    }

    return { llm, stt, tts, reasons };
  }
}
