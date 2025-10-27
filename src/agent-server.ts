// Load environment variables FIRST, before any other imports
import { config } from 'dotenv';
import * as path from 'path';

// Load .env files for local development - Railway uses environment variables
config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
config({ path: path.resolve(__dirname, '..', '.env') });

import { WebSocket, WebSocketServer } from 'ws';
import * as http from 'http';
import * as dns from 'dns';
import { conversationMemory, ConversationMessage } from './conversation-memory';
import { DeepgramManager } from './deepgram-manager';
import { IntentAnalyzer, IntentResult } from './intent-analyzer';
import { connectionPool } from './connection-pool';
import type { 
  ChatMessage, 
  KBChunk, 
  GroundedAnswerResult,
  AgentData
} from './types';
import type { SessionStart } from '@vapi/types';
import { 
  agentConfig, 
  PORT, 
  LOG_LEVEL, 
  TEST_HOOKS,
  STT_SILENCE_TIMEOUT_MS,
  TTS_MIN_DURATION_MS,
  TTS_BARGE_THRESHOLD_WORDS,
  TTS_PROTECTED_PHRASES,
  TTS_SENTENCE_BOUNDARY_PROTECTION,
  TTS_CLAUSE_PROTECTION_MS,
  TTS_CRITICAL_INFO_PROTECTION,
  getElevenLabsConfig,
  MAX_FRAME_BYTES,
  MAX_JSON_BYTES,
  MAX_AUDIO_FRAMES_PER_SEC,
  ENABLE_MULTI_PROVIDER,
  ENABLE_PROVIDER_ROUTER,
} from './agent-config';
import { ProviderFactory } from './providers/factory';
import { ProviderRouter } from './router/provider-router';
import { z } from 'zod';
import { 
  EnvelopeSchema,
  SessionStartSchema,
  AudioEndSchema,
  BargeCancelSchema,
  TestUtteranceSchema,
  STTPartialSchema,
  STTFinalSchema,
  LLMPartialSchema,
  LLMFinalSchema,
  TTSEndSchema,
  MetricsUpdateSchema,
  ErrorSchema,
  AudioChunkHeaderSchema,
  TTSChunkHeaderSchema,
  encodeBinaryFrame,
  decodeBinaryFrame,
  nowTs,
} from '@vapi/types';
import { streamElevenLabsTTS } from './elevenlabs';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
// External Actions Integration
import { OpenAIManager, DEFAULT_FUNCTION_SCHEMAS } from './openai-manager';
import { ActionManager } from './action-manager';
import { EmailAction } from './actions/email-action';
import { NotesAction } from './actions/notes-action';
import { SlackAction } from './actions/slack-action';
import { ActionContext, ActionType } from './types/actions';
import { SentenceDetector } from './utils/sentence-detector';
import { TurnDetector, TURN_DETECTION_PRESETS } from './turn-detector';
import { WebRTCVAD, createVAD } from './webrtc-vad';
// axios import removed (unused)

// Enforce session JWT presence in production
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.error('[config] SESSION_JWT_SECRET is required in production');
  process.exit(1);
}

// Initialize External Actions System
let openaiManager: OpenAIManager | null = null;
let actionManager: ActionManager | null = null;

if (agentConfig.openai) {
  console.log('[agent-server] Initializing External Actions...');
  
  // Create OpenAI Manager with function calling support
  openaiManager = new OpenAIManager({
    apiKey: agentConfig.apiKeys.openaiApiKey,
    defaultModel: 'gpt-4o-mini',
    temperature: 0,
    maxTokens: 500
  });

  // Create Action Manager
  actionManager = new ActionManager({
    enableAuditLogging: true,
    enableRateLimiting: true,
    enablePermissionChecking: false, // Simplified for now
    defaultTimeout: 30000,
    logLevel: 'info'
  });

  // Register all actions
  actionManager.registerActions([
    new EmailAction(),
    new NotesAction(),
    new SlackAction()
  ]);

  // Register function schemas with OpenAI
  openaiManager.registerFunctions(DEFAULT_FUNCTION_SCHEMAS);

  console.log('[agent-server] External Actions initialized:', actionManager.getExecutionStats());
} else {
  console.warn('[agent-server] OpenAI not configured - External Actions disabled');
}

function log(...args: unknown[]) {
  if (LOG_LEVEL !== 'debug') return;
  // eslint-disable-next-line no-console
  console.debug('[agent]', ...args);
}

function sendJson(ws: WebSocket, msg: Record<string, unknown>) {
  ws.send(JSON.stringify(msg));
}

function sendError(ws: WebSocket, sessionId: string, turnId: string, code: string, message: string, details?: unknown) {
  sendJson(ws, { type: 'error', ts: nowTs(), sessionId, turnId, data: { code, message, recoverable: true, details } });
}

type SessionState = {
  sessionId: string;
  turnId: string;
  systemPrompt: string;
  voiceId: string | null;
  vadEnabled: boolean;
  pttMode: boolean;
  firstMessageMode?: 'assistant_speaks_first' | 'user_speaks_first' | 'wait_for_user';
  language?: 'en' | 'hi';
  // Use the validated endpointing type from Zod schema
  endpointing?: SessionStart['data']['endpointing'];
  // Optional: agent backing this session (used for KB lookups)
  agentId?: string;
  // future: deepgram/openai/elevenlabs connections, abort controllers, queues
};

// Diagnostics: last observed provider choices (updated on selection and session start)
const lastProviders: { llm?: string; stt?: string; tts?: string } = {};

// Create HTTP server that handles both WebSocket upgrades and health checks
const server = http.createServer(async (req, res) => {
  if (!req.url) { res.statusCode = 400; return res.end('Bad Request'); }
  
  if (req.url === '/healthz') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ 
      status: 'healthy',
      timestamp: new Date().toISOString()
    }));
  }
  
  if (req.url === '/debug/connectivity') {
    res.setHeader('Content-Type', 'application/json');
    const results: any = {};
    
    // Test DNS resolution
    try {
      const dns = await import('dns').then(m => m.promises);
      await dns.resolve4('api.deepgram.com');
      results.deepgramDNS = 'OK';
    } catch (e: any) {
      results.deepgramDNS = `FAILED: ${e.message}`;
    }
    
    try {
      const dns = await import('dns').then(m => m.promises);
      await dns.resolve4('api.openai.com');
      results.openaiDNS = 'OK';
    } catch (e: any) {
      results.openaiDNS = `FAILED: ${e.message}`;
    }
    
    // Test HTTPS connectivity
    try {
      const https = await import('https');
      await new Promise((resolve, reject) => {
        https.get('https://api.deepgram.com', (res) => {
          resolve(res.statusCode);
        }).on('error', reject);
      });
      results.deepgramHTTPS = 'OK';
    } catch (e: any) {
      results.deepgramHTTPS = `FAILED: ${e.message}`;
    }
    
    try {
      const https = await import('https');
      await new Promise((resolve, reject) => {
        https.get('https://api.openai.com', (res) => {
          resolve(res.statusCode);
        }).on('error', reject);
      });
      results.openaiHTTPS = 'OK';
    } catch (e: any) {
      results.openaiHTTPS = `FAILED: ${e.message}`;
    }
    
    results.timestamp = new Date().toISOString();
    return res.end(JSON.stringify(results, null, 2));
  }
  
  if (req.url === '/flag-status') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      multiProviderEnabled: ENABLE_MULTI_PROVIDER,
      rolloutPercentage: Number(process.env.MULTI_PROVIDER_ROLLOUT_PERCENTAGE || 0)
    }));
  }

  if (req.url?.startsWith('/router/preview')) {
    res.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(req.url, 'http://localhost');
      const tier = (url.searchParams.get('tier') || 'pro') as any;
      const complexity = (url.searchParams.get('complexity') || 'simple') as any;
      const budgetUSD = url.searchParams.get('budgetUSD') ? Number(url.searchParams.get('budgetUSD')) : undefined;
      // Only works when multi-provider is enabled; router flag optional
      if (!ENABLE_MULTI_PROVIDER) {
        return res.end(JSON.stringify({ error: 'ENABLE_MULTI_PROVIDER=false' }));
      }
      const router = new ProviderRouter({}, { llm: {}, stt: {}, tts: {} });
      router.select({ tier, complexity, budgetUSD }).then((sel) => {
        res.end(JSON.stringify({ reasons: sel.reasons }, null, 2));
      }).catch((e) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String((e as any)?.message || e) }));
      });
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String((e as any)?.message || e) }));
    }
    return;
  }

  if (req.url === '/metrics') {
    // Simple CORS for browser access from Next.js dev (localhost:3000)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      activeCalls: activeSessionIds.size,
      retainedConversations: conversationMemory.getStats().totalMessages > 0 ? 1 : 0,
      totalMessages: conversationMemory.getStats().totalMessages,
      totalTurns,
      lastLlmFirstTokenMs,
      lastTtsFirstAudioMs,
      lastTurnElapsedMs,
      lastDeepgramReadyMs,
      lastDeepgramQueueAtReady,
      lastSttFinalLatencyMs,
      avgs: {
        deepgramReadyMs: avg(dgReadyMsHistory),
        sttFinalLatencyMs: avg(sttFinalLatencyHistory),
        llmFirstTokenMs: avg(llmFirstTokenHistory),
        ttsFirstAudioMs: avg(ttsFirstAudioHistory),
        e2eMs: avg(e2eHistory),
      },
      ts: Date.now(),
      // Last observed providers (for quick diagnostics; per-connection may differ)
      providers: lastProviders
    }));
  }
  
  res.statusCode = 404; 
  res.end('Not Found');
});

const wss = new WebSocketServer({ server, path: '/agent' });
// Track active sessionIds for live call count
const activeSessionIds = new Set<string>();
// Global turn metrics (simple, in-memory)
let totalTurns = 0;
let lastLlmFirstTokenMs = -1;
let lastTtsFirstAudioMs = -1;
let lastTurnElapsedMs = -1;
let lastDeepgramReadyMs = -1;
let lastDeepgramQueueAtReady = -1;
let lastSttFinalLatencyMs = -1;
// Rolling histories for observability (cap 50 samples)
const dgReadyMsHistory: number[] = [];
const sttFinalLatencyHistory: number[] = [];
const llmFirstTokenHistory: number[] = [];
const ttsFirstAudioHistory: number[] = [];
const e2eHistory: number[] = [];
function pushSample(arr: number[], value: number, cap = 50) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) return;
  arr.push(Math.round(value));
  if (arr.length > cap) arr.shift();
}
function avg(arr: number[]): number { return arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : -1; }
// Latency classification thresholds and helper
const THRESH = {
  deepgramReady: { warn: 700, crit: 1200 },
  sttFinal: { warn: 900, crit: 1400 },
  llmFirst: { warn: 700, crit: 1200 },
  ttsFirst: { warn: 600, crit: 1000 },
  e2e: { warn: 2000, crit: 3000 },
};
function classifyLatency() {
  const reasons: string[] = [];
  let level = 'ok' as 'ok'|'warn'|'critical';
  const check = (val: number, key: keyof typeof THRESH, reason: string) => {
    if (val < 0) return;
    const { warn, crit } = THRESH[key];
    if (val > crit) { reasons.push(reason); level = 'critical'; }
    else if (val > warn && level !== 'critical') { reasons.push(reason); level = 'warn'; }
  };
  check(lastDeepgramReadyMs, 'deepgramReady', 'deepgram_slow');
  check(lastSttFinalLatencyMs, 'sttFinal', 'stt_slow');
  check(lastLlmFirstTokenMs, 'llmFirst', 'llm_slow');
  check(lastTtsFirstAudioMs, 'ttsFirst', 'tts_slow');
  check(lastTurnElapsedMs, 'e2e', 'e2e_slow');
  return { latencyStatus: level, reasons };
}
// Allowed origins for WebSocket connections (comma-separated)
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || 'http://localhost:3010,http://localhost:3000,http://localhost:5173,http://localhost:5175,http://localhost:5176')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

wss.on('connection', async (ws, req) => {
  let connectionId: string | null = null;
  
  try {
    const origin = (req?.headers?.origin as string) || '';
    const isLocalOrigin = /^http:\/\/localhost:\d+$/i.test(origin);
    const isAllowed = allowedOrigins.includes(origin) || (process.env.NODE_ENV !== 'production' && isLocalOrigin);
    if (origin && !isAllowed) {
      console.log('[agent] Closing WS: disallowed origin', origin, 'allowed:', allowedOrigins);
      try { ws.close(1008, 'origin not allowed'); } catch (e: unknown) {
        console.error('[agent] Failed to close WS for disallowed origin:', e instanceof Error ? e.message : String(e));
      }
      return;
    }
    
    // Optional: require bearer token if configured
    const expectedToken = process.env.AGENT_WS_TOKEN;
    if (expectedToken) {
      const auth = String(req?.headers?.authorization || '');
      const headerToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      let queryToken = '';
      try {
        const parsed = new URL(req.url || '', 'http://localhost');
        queryToken = parsed.searchParams.get('token') || parsed.searchParams.get('access_token') || '';
      } catch (e: unknown) {
        console.error('[agent] Failed to parse URL for token extraction:', e instanceof Error ? e.message : String(e));
      }
      const provided = headerToken || queryToken;
      if (provided !== expectedToken) {
        console.log('[agent] Closing WS: invalid/missing token');
        try { ws.close(1008, 'auth required'); } catch (e: unknown) {
          console.error('[agent] Failed to close WS for auth required:', e instanceof Error ? e.message : String(e));
        }
        return;
      }
    }

    // Add connection to pool with metadata
    const metadata = {
      origin,
      userAgent: req?.headers?.['user-agent'] || 'unknown',
      ip: req?.socket?.remoteAddress || 'unknown',
      connectedAt: Date.now()
    };
    
    connectionId = connectionPool.addConnection(ws, metadata);
    if (!connectionId) {
      console.log('[agent] Connection rejected by pool (rate limit or capacity)');
      try { ws.close(1013, 'server overloaded'); } catch (e: unknown) {
        console.error('[agent] Failed to close WS for pool rejection:', e instanceof Error ? e.message : String(e));
      }
      return;
    }

    console.log(`[agent] Connection added to pool: ${connectionId}`);
    
  } catch (e: unknown) {
    console.error('[agent] WebSocket connection setup failed:', e instanceof Error ? e.message : String(e));
    if (connectionId) {
      connectionPool.removeConnection(connectionId);
    }
    try { ws.close(1011, 'setup failed'); } catch (e: unknown) {
        console.error('[ws] Failed to close WebSocket:', e instanceof Error ? e.message : String(e));
      } // This one can stay empty as it's cleanup
    return;
  }
  let session: SessionState | null = null;
  let alive = true;
  let openaiAbort: AbortController | null = null;
  let ttsAbort: AbortController | null = null;
  
  // Initialize Turn Detection System (Performance Optimized)
  const ENABLE_ADVANCED_TURN_DETECTION = String(process.env.ENABLE_ADVANCED_TURN_DETECTION || 'false') === 'true';
  const turnDetector = ENABLE_ADVANCED_TURN_DETECTION ? new TurnDetector(TURN_DETECTION_PRESETS.responsive) : null; // Use responsive for speed
  const vad = createVAD('normal'); // Use normal preset to reduce false positives
  const deepgramManager = new DeepgramManager();
  const intentAnalyzer = new IntentAnalyzer();
  // Phase 1 wiring: instantiate providers behind feature flag (no behavior change by default)
  const useMulti = ENABLE_MULTI_PROVIDER === true;
  // STT: Deepgram only (real-time streaming)
  let sttProvider = useMulti ? ProviderFactory.createSTT('deepgram') : null;
  // LLM: Google Gemini as primary
  let llmProvider = useMulti ? ProviderFactory.createLLM('openai') : null;
  // TTS: ElevenLabs as primary, OpenAI as fallback
  let ttsProvider = useMulti ? ProviderFactory.createTTS('elevenlabs') : null;
  if (useMulti && ENABLE_PROVIDER_ROUTER) {
    try {
      const router = new ProviderRouter({ }, { llm: {}, stt: {}, tts: {} });
      const selection = await router.select({ tier: 'pro', complexity: 'simple' });
      sttProvider = selection.stt;
      llmProvider = selection.llm;
      ttsProvider = selection.tts;
      console.log('[router] Selected providers:', selection.reasons.join(', '));
      try {
        // Capture last observed providers for diagnostics
        // @ts-ignore
        lastProviders.llm = (llmProvider as any)?.type || (llmProvider as any)?.name || 'unknown';
        // @ts-ignore
        lastProviders.stt = (sttProvider as any)?.type || (sttProvider as any)?.name || 'unknown';
        // @ts-ignore
        lastProviders.tts = (ttsProvider as any)?.type || (ttsProvider as any)?.name || 'unknown';
      } catch {}
    } catch (e) {
      console.log('[router] Router selection failed, falling back to defaults:', e instanceof Error ? e.message : String(e));
    }
  }
  if (useMulti) {
    console.log('[providers] ENABLE_MULTI_PROVIDER=true');
    console.log('[providers] 🤖 ACTIVE LLM:', llmProvider ? `${(llmProvider as any).type} - ${llmProvider.name}` : 'none');
    console.log('[providers] 🎙️  ACTIVE STT:', sttProvider ? `${(sttProvider as any).type} - ${sttProvider.name}` : 'none');
    console.log('[providers] 🔊 ACTIVE TTS:', ttsProvider ? `${(ttsProvider as any).type} - ${ttsProvider.name}` : 'none');
    try {
      // Capture last observed providers for diagnostics
      // @ts-ignore
      lastProviders.llm = (llmProvider as any)?.type || (llmProvider as any)?.name || 'unknown';
      // @ts-ignore
      lastProviders.stt = (sttProvider as any)?.type || (sttProvider as any)?.name || 'unknown';
      // @ts-ignore
      lastProviders.tts = (ttsProvider as any)?.type || (ttsProvider as any)?.name || 'unknown';
    } catch {}
  } else {
    console.log('[providers] ENABLE_MULTI_PROVIDER=false (using legacy OpenAI LLM)');
    console.log('[providers] 🤖 LEGACY LLM: OpenAI (via agentConfig.openai)');
  }
  // Simple per-connection token bucket for audio rate limiting
  // Initialize with one second of budget to avoid dropping initial audio frames
  let framesBudget = MAX_AUDIO_FRAMES_PER_SEC;
  const refillInterval = setInterval(() => {
    framesBudget = Math.min(framesBudget + MAX_AUDIO_FRAMES_PER_SEC, MAX_AUDIO_FRAMES_PER_SEC);
  }, 1000);
  let ttsEnded = false;
  // Barge-in protection tracking
  let ttsStartTime: number = 0;
  let currentTtsText: string = '';
  let isTtsActive = false;
  // Per-connection turn metrics (updated each turn)
  let connTurnStartTs: number = 0;
  let connLlmFirstTokenMs: number = -1;
  let connTtsFirstAudioMs: number = -1;
  // Track audio arrival for STT latency measurement
  let lastAudioReceivedTs: number = -1;
  let sttLatencyLastMs: number = -1;
  // Prevent multiple partial-driven LLM starts per turn
  let startedFromPartial: boolean = false;
  // Phase 3: Simple in-memory response cache for common questions (5 min TTL)
  const CACHE_TTL_MS = Number(process.env.RESPONSE_CACHE_TTL_MS || 300000);
  // Shared cache across connections
  // @ts-ignore
  if (!(global as any).__woic_resp_cache) { (global as any).__woic_resp_cache = new Map<string, { text: string; ts: number }>(); }
  // @ts-ignore
  const responseCache: Map<string, { text: string; ts: number }> = (global as any).__woic_resp_cache;
  // Greeting/dup/turn guards
  let greeted = false;
  let lastSttFinalText: string = '';
  let lastSttFinalAt: number = 0;
  let processingTurn = false;
  // Track current turn's normalized user text to suppress near-duplicate finals
  let currentTurnUserNorm: string = '';
  let currentTurnStartedAt: number = 0;
  // If barge-in blocks an STT final during active TTS, queue it to process after TTS ends
  let pendingUserFinal: string | null = null;
  // Intelligent analyzer instance (per-connection)
  const sentenceDetector = new SentenceDetector();
  // Feature flag to control early TTS behavior (disabled by default to avoid 1-2 word issue)
  const EARLY_TTS_ENABLED = String(process.env.EARLY_TTS_ENABLED || 'false') === 'true';
  // Feature flag to control early LLM start on partial transcripts (disabled by default for correctness)
  const ENABLE_EARLY_LLM = String(process.env.ENABLE_EARLY_LLM || 'false') === 'true';
  // Strict turn-taking: never start/continue LLM/TTS while user is talking
  const STRICT_TURN_TAKING = String(process.env.STRICT_TURN_TAKING || 'true') === 'true';
  let userTalking = false;
  // STT final deferral state (allow micro-pauses to finish a thought)
  let finalDeferralActive = false;

  function normalizeText(s: string): string {
    return String(s).toLowerCase().replace(/[\s\.,!?]+/g, ' ').trim();
  }

  // Simple token overlap similarity (Jaccard-like)
  function isSimilar(a: string, b: string): boolean {
    const A = new Set(a.split(/\s+/).filter(Boolean));
    const B = new Set(b.split(/\s+/).filter(Boolean));
    if (A.size === 0 || B.size === 0) return a === b;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const sim = inter / Math.min(A.size, B.size);
    return sim >= 0.8 || a.includes(b) || b.includes(a);
  }

  // Smart barge-in protection function
  const STOP_PATTERNS = /\b(stop|pause|hold on|wait|be quiet|quiet|shut up|silent|silence|cancel|that's enough|enough)\b/i;
  function shouldAllowBargein(userText: string): boolean {
    if (!isTtsActive) return true; // No TTS playing, always allow
    
    const ttsElapsedMs = Date.now() - ttsStartTime;
    // Always allow barge-in on explicit stop/interrupt phrases
    if (STOP_PATTERNS.test(userText)) {
      return true;
    }
    
    // Rule 1: Minimum duration protection - don't interrupt in first few seconds
    if (ttsElapsedMs < TTS_MIN_DURATION_MS) {
      console.log('[agent] Barge-in blocked: TTS duration too short (', ttsElapsedMs, 'ms <', TTS_MIN_DURATION_MS, 'ms)');
      return false;
    }
    
    // Rule 2: Word count threshold - require substantial user input
    const userWords = userText.trim().split(/\s+/).filter(w => w.length > 0);
    if (userWords.length < TTS_BARGE_THRESHOLD_WORDS) {
      console.log('[agent] Barge-in blocked: User input too short (', userWords.length, 'words <', TTS_BARGE_THRESHOLD_WORDS, 'words)');
      return false;
    }
    
    // Rule 3: Protected phrases - don't interrupt during important information
    if (TTS_PROTECTED_PHRASES && currentTtsText) {
      const protectedPatterns = [
        /\d{3}-\d{3}-\d{4}/, // Phone numbers
        /\d+-\d+-\d+/,      // Policy numbers
        /\$[\d,]+/,         // Dollar amounts
        /\d+%/,             // Percentages
        /call.*\d/i,        // "call 1-800..." instructions
      ];
      
      for (const pattern of protectedPatterns) {
        if (pattern.test(currentTtsText)) {
          console.log('[agent] Barge-in blocked: TTS contains protected phrase pattern');
          return false;
        }
      }
    }
    
    // Rule 4: Sentence boundary protection - don't interrupt mid-sentence
    if (TTS_SENTENCE_BOUNDARY_PROTECTION && currentTtsText) {
      // Check if we're likely in the middle of a sentence/clause
      const lastWords = currentTtsText.toLowerCase().split(/\s+/).slice(-5).join(' ');
      
      // Mid-clause indicators (incomplete thoughts)
      const midClausePatterns = [
        /\band\s*$/,           // "hospital, outpatient, and"
        /\bor\s*$/,            // "auto or"  
        /\bbut\s*$/,           // "covers everything but"
        /\bthe\s*$/,           // "the"
        /\byour\s*$/,          // "your" 
        /\bis\s*$/,            // "is"
        /\bwill\s*$/,          // "will"
        /\bfrom\s*$/,          // "from"
        /\bto\s*$/,            // "to"
        /\bfor\s*$/,           // "for"
        /\bwith\s*$/,          // "with"
        /\bof\s*$/,            // "of"
        /\bin\s*$/,            // "in"
        /,\s*$/,               // ends with comma
        /\bincluding\s*$/,     // "including"
        /\bsuch\s+as\s*$/,     // "such as"
      ];
      
      for (const pattern of midClausePatterns) {
        if (pattern.test(lastWords) && ttsElapsedMs < TTS_CLAUSE_PROTECTION_MS) {
          console.log('[agent] Barge-in blocked: Mid-clause protection (pattern:', pattern, 'matched:', lastWords, ')');
          return false;
        }
      }
    }
    
    // Rule 5: Critical information protection - extra protection for important data
    if (TTS_CRITICAL_INFO_PROTECTION && currentTtsText) {
      const criticalInfoPatterns = [
        /\d{3,}/,                    // Any 3+ digit number
        /\b\d+\s*(am|pm)\b/i,        // Times
        /\b\d+\s*(st|nd|rd|th)\b/i,  // Dates
        /\b[a-z]+\s*@\s*[a-z]+/i,    // Email addresses
        /\b\d+\s*(street|ave|road|blvd|dr)/i, // Addresses
      ];
      
      for (const pattern of criticalInfoPatterns) {
        if (pattern.test(currentTtsText) && ttsElapsedMs < TTS_MIN_DURATION_MS + 1000) {
          console.log('[agent] Barge-in blocked: Critical information protection');
          return false;
        }
      }
    }
    
    console.log('[agent] Barge-in allowed: Duration=', ttsElapsedMs, 'ms, Words=', userWords.length);
    return true;
  }

  // Deepgram STT event handlers
  const ENABLE_PARTIAL_BARGE = String(process.env.ENABLE_PARTIAL_BARGE || 'true') === 'true';

  const deepgramCallbacks = {
    onSttPartial: (transcript: string) => {
      if (LOG_LEVEL === 'debug') console.log('[agent] Sending STT partial:', transcript);
      
      // Lightweight turn detection (performance optimized)
      const hasContent = String(transcript).trim().length > 0;
      if (ENABLE_ADVANCED_TURN_DETECTION && turnDetector) {
        const turnDecision = turnDetector.decideTurn(hasContent, transcript, 0.8, Date.now());
        if (LOG_LEVEL === 'debug') {
          console.log('[agent] Turn decision:', turnDecision.action, 'confidence:', turnDecision.confidence, 'reasons:', turnDecision.reasons.join(','));
        }
      }
      
      sendJson(ws, {
        type: 'stt.partial',
        ts: nowTs(),
        sessionId: session?.sessionId ?? 'unknown',
        turnId: session?.turnId ?? 'unknown',
        data: { text: transcript },
      });

      // Mark that user is currently talking (any non-empty partial)
      if (hasContent) {
        userTalking = true;
      }

      // Optional: Smart barge-in on substantial partials (disabled by default to avoid mid-sentence cuts)
      if (ENABLE_PARTIAL_BARGE) {
        try {
          // Immediate cancel on stop phrases
          if (isTtsActive && STOP_PATTERNS.test(transcript)) {
            console.log('[agent] Stop phrase detected in partial; cancelling current TTS');
            try { openaiAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
            try { ttsAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
            isTtsActive = false;
            sendTtsEnd('barge');
            return;
          }
          // ENHANCED: Immediate interruption with confidence threshold
          if (STRICT_TURN_TAKING && isTtsActive && String(transcript).trim().length > 0) {
            const words = transcript.trim().split(/\s+/).filter(Boolean);
            const hasSubstantialContent = words.length >= 1; // Require at least 1 word (changed from 2)
            const ttsElapsedMs = Date.now() - ttsStartTime;
            const allowImmediateInterrupt = ttsElapsedMs > 300; // Allow after 300ms of TTS
            
            if (hasSubstantialContent && allowImmediateInterrupt) {
              console.log('[agent] Immediate interruption: user speaking with', words.length, 'words after', ttsElapsedMs, 'ms TTS');
              try { openaiAbort?.abort(); } catch {}
              try { ttsAbort?.abort(); } catch {}
              isTtsActive = false;
              sendTtsEnd('barge');
              return;
            } else if (!hasSubstantialContent) {
              console.log('[agent] Ignoring brief sound - insufficient content:', transcript);
            } else if (!allowImmediateInterrupt) {
              console.log('[agent] Allowing TTS to continue - too early to interrupt (', ttsElapsedMs, 'ms)');
            }
          }
          if (isTtsActive && transcript && transcript.trim().length > 0) {
            const ttsElapsedMs = Date.now() - ttsStartTime;
            const words = transcript.trim().split(/\s+/).filter(Boolean).length;
            // Analyzer-based early barge-in: if it's clearly a new sentence, allow earlier
            let analyzerAllowsEarly = false;
            try {
              const a = sentenceDetector.analyzeSentence(String(transcript || ''), 0);
              analyzerAllowsEarly = (a.suggestion === 'process' && words >= 3 && ttsElapsedMs >= Math.min(600, TTS_MIN_DURATION_MS));
            } catch {}
            if (ttsElapsedMs >= TTS_MIN_DURATION_MS && words >= Math.max(2, TTS_BARGE_THRESHOLD_WORDS - 1)) {
              if (shouldAllowBargein(transcript)) {
                console.log('[agent] Barge-in on partial: cancelling current TTS (elapsed=', ttsElapsedMs, 'ms, words=', words, ')');
                try { openaiAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
                try { ttsAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
                sendTtsEnd('barge');
              }
            } else if (analyzerAllowsEarly) {
              console.log('[agent] Analyzer-approved early barge-in on partial; cancelling current TTS');
              try { openaiAbort?.abort(); } catch {}
              try { ttsAbort?.abort(); } catch {}
              sendTtsEnd('barge');
            }
          }
        } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
      }

      // Early LLM start on substantial partial to reduce perceived latency
      try {
        if (ENABLE_EARLY_LLM && !STRICT_TURN_TAKING && !processingTurn && !isTtsActive && !startedFromPartial) {
          const text = String(transcript || '').trim();
          const words = text.split(/\s+/).filter(Boolean);
          const hasCompleteSentence = /[.!?]\s/.test(text) || /[.!?]$/.test(text);
          const hasClauseEnd = /[,;:]\s/.test(text) && words.length >= 3;
          const substantial = words.length >= 8 || hasCompleteSentence || hasClauseEnd;
          // Gate early LLM on analyzer suggesting "process"
          let analyzerOk = false;
          try { analyzerOk = sentenceDetector.analyzeSentence(text, 0).suggestion === 'process'; } catch {}
          if (substantial && analyzerOk) {
            console.log('[agent] Starting LLM on substantial partial to reduce latency:', text.slice(0, 80) + '...');
            startedFromPartial = true;
            // Do not add to memory yet; memory will be on final to avoid duplication
            processOpenAIAndTTS(text);
          }
        }
      } catch (e: unknown) {
        console.error('[agent] Early LLM on partial error:', e instanceof Error ? e.message : String(e));
      }
    },
    onReady: (info: { connectLatencyMs: number; queueSize: number }) => {
      try {
        sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { deepgramReadyMs: info.connectLatencyMs, deepgramQueueAtReady: info.queueSize } });
      } catch (e: unknown) {
        console.error('[agent] Failed to emit Deepgram readiness metric:', e instanceof Error ? e.message : String(e));
      }
    },
    
    onSttFinal: (transcript: string) => {
      if (LOG_LEVEL === 'debug') console.log('[agent] Received STT final:', transcript);

      // Background noise and content filtering
      const hasContent = String(transcript).trim().length > 0;
      const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
      const isSubstantialContent = wordCount >= 1; // At least 1 word (changed from 2)
      const isLikelyNoise = /^(uh|um|ah|eh|mm|hmm|hm|oh)$/i.test(transcript.trim());
      
      // Filter out background noise and meaningless sounds
      if (!isSubstantialContent || isLikelyNoise) {
        if (LOG_LEVEL === 'debug') {
          console.log('[agent] Filtering out noise/brief content:', transcript, 'words:', wordCount);
        }
        return; // Don't process noise or very brief content
      }
      
      // Use optimized turn detection only when needed
      if (ENABLE_ADVANCED_TURN_DETECTION && turnDetector) {
        try {
          const turnDecision = turnDetector.decideTurn(false, transcript, 0.9, Date.now());
          
          if (LOG_LEVEL === 'debug') {
            console.log('[agent] Turn detector decision:', turnDecision.action, 'confidence:', turnDecision.confidence);
          }
          
          // Handle turn decision
          if (turnDecision.action === 'wait' && turnDecision.waitDuration && !finalDeferralActive) {
            console.log('[agent] Deferring STT final by', turnDecision.waitDuration, 'ms');
            finalDeferralActive = true;
            setTimeout(() => {
              finalDeferralActive = false;
              try { deepgramCallbacks.onSttFinal(transcript); } catch {}
            }, turnDecision.waitDuration);
            return;
          }
          
          // Handle barge-in
          if (turnDecision.action === 'interrupt' && isTtsActive) {
            console.log('[agent] User barge-in detected');
            try { openaiAbort?.abort(); } catch {}
            try { ttsAbort?.abort(); } catch {}
            isTtsActive = false;
            sendTtsEnd('barge');
            userTalking = true;
          }
          
        } catch (e) {
          console.log('[agent] Turn detector error:', e);
        }
      }

      // Reinstate barge-in protection to avoid cutting TTS too early
      if (!shouldAllowBargein(transcript)) {
        console.log('[agent] Barge-in rejected; deferring STT final until TTS ends');
        // Keep the most recent user final only
        pendingUserFinal = String(transcript || '');
        return; // Do not process now; will run on tts.end
      }

      // User has finished talking for this turn
      userTalking = false;
      // If user says a stop phrase in final, cancel TTS and do not proceed with a response
      if (isTtsActive && STOP_PATTERNS.test(transcript)) {
        console.log('[agent] Stop phrase detected in final; cancelling current TTS and ignoring LLM');
        try { openaiAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
        try { ttsAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
        isTtsActive = false;
        sendTtsEnd('barge');
        return;
      }
      // De-duplicate rapid identical/similar finals and abort current turn if needed
      const nowTsLocal = Date.now();
      const norm = String(transcript).toLowerCase().replace(/[\s\.,!?]+/g, ' ').trim();
      const normLast = String(lastSttFinalText).toLowerCase().replace(/[\s\.,!?]+/g, ' ').trim();
      const similar = norm === normLast || norm.includes(normLast) || normLast.includes(norm);
      if (similar && nowTsLocal - lastSttFinalAt < 2500) {
        console.log('[agent] Ignoring duplicate STT final within 2500ms');
        return;
      }
      lastSttFinalText = transcript;
      lastSttFinalAt = nowTsLocal;
      // Emit metric: STT final latency from last audio chunk
      try {
        if (lastAudioReceivedTs > 0) {
          sttLatencyLastMs = Date.now() - lastAudioReceivedTs;
          lastSttFinalLatencyMs = sttLatencyLastMs;
          pushSample(sttFinalLatencyHistory, sttLatencyLastMs);
          sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { sttFinalLatencyMs: sttLatencyLastMs } });
        }
      } catch (e: unknown) {
        console.error('[agent] Error emitting STT latency metric:', e instanceof Error ? e.message : String(e));
      }
      if (processingTurn || isTtsActive) {
        const normIncoming = normalizeText(transcript);
        if (currentTurnUserNorm && isSimilar(normIncoming, currentTurnUserNorm)) {
          console.log('[agent] Suppressing similar STT final during active turn');
          return;
        }
        console.log('[agent] Queuing new STT final until current turn completes');
        pendingUserFinal = transcript;
        return;
      }
      // Reset partial-start flag for this final-driven turn
      startedFromPartial = false;
      currentTurnUserNorm = normalizeText(transcript);
      currentTurnStartedAt = Date.now();
      const sttFinalReceivedTs = Date.now();
      const sttFinalTimestampStr = new Date().toISOString().split('T')[1].slice(0, -1);
      console.log(`[agent] [${sttFinalTimestampStr}] 🎤 STT FINAL received:`, JSON.stringify(transcript), `sttFinalReceived: ${sttFinalReceivedTs}`);
      
      // Perform intent analysis
      const conversationHistory = session ? conversationMemory.getMessages(session.sessionId).map(m => m.content) : [];
      const intentResult = intentAnalyzer.analyzeIntent(transcript, conversationHistory);
      
      if (LOG_LEVEL === 'debug') console.log('[agent] Intent analysis:', {
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        entities: Object.keys(intentResult.entities),
        requiresAction: intentResult.requiresAction
      });
      
      sendJson(ws, {
        type: 'stt.final',
        ts: nowTs(),
        sessionId: session?.sessionId ?? 'unknown',
        turnId: session?.turnId ?? 'unknown',
        data: { 
          text: transcript, 
          startTs: nowTs() - 50, 
          endTs: nowTs(),
          intent: intentResult.intent,
          confidence: intentResult.confidence,
          entities: intentResult.entities,
          context: intentResult.context
        },
      });
      
      // Send dedicated intent event for UI/analytics
      sendJson(ws, {
        type: 'intent.detected',
        ts: nowTs(),
        sessionId: session?.sessionId ?? 'unknown',
        turnId: session?.turnId ?? 'unknown',
        data: intentResult,
      });

      // Cancel any inflight LLM/TTS from previous turn (only if barge-in is allowed)
      if (isTtsActive) {
        if (LOG_LEVEL === 'debug') console.log('[agent] Barge-in allowed, cancelling current TTS');
        try { openaiAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
        try { ttsAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
        isTtsActive = false;
      }

      // Start OpenAI streaming for the user's utterance
      if (session) {
        // Ensure conversation exists or create it
        let conversation = conversationMemory.getConversation(session.sessionId);
        if (!conversation) {
          conversation = conversationMemory.createConversation(session.sessionId, session.systemPrompt || 'You are InsureBot, an AI insurance assistant. Be helpful and conversational.');
        }
        conversationMemory.addUserMessage(session.sessionId, transcript);
      }
      
      // Use enhanced version with function calling if available
      const ACTIONS_ENABLED = String(process.env.ACTIONS_ENABLED || 'true') === 'true';
      if (ACTIONS_ENABLED && openaiManager && actionManager) {
        processOpenAIWithActions(transcript, intentResult);
      } else {
        processOpenAIAndTTS(transcript, intentResult);
      }
    },
    
    onError: (error: any) => {
      console.log('[agent] Deepgram error:', error);
      sendError(ws, session?.sessionId ?? 'unknown', session?.turnId ?? 'unknown', 'deepgram_error', error.message || 'Deepgram connection error');
    }
  };

  function createDeepgramConnection(opts: { encoding: 'linear16' | 'opus'; sampleRate: number; channels: number }) {
    if (useMulti && sttProvider) {
      if (sttProvider.isReady()) return;
      console.log('[stt] Connecting provider:', (sttProvider as any).type, '-', sttProvider.name, 'opts=', opts);
      sttProvider.connect(
        opts,
        {
          onPartial: deepgramCallbacks.onSttPartial,
          onFinal: deepgramCallbacks.onSttFinal,
          onError: deepgramCallbacks.onError,
          onReady: deepgramCallbacks.onReady,
        },
        session
      );
      return;
    }
    if (deepgramManager.isConnected()) return;
    deepgramManager.createConnection(opts, deepgramCallbacks, session);
  }

  // Wrapper to send audio to STT that respects the feature flag
  let __sttFrameCounter = 0;
  function sendAudioToSTT(payload: Buffer, codec: 'pcm16' | 'opus' = 'pcm16'): boolean {
    if (useMulti && sttProvider) {
      __sttFrameCounter += 1;
      if (__sttFrameCounter === 1 || __sttFrameCounter % 50 === 0) {
        console.log('[stt] sendAudio ->', (sttProvider as any).type, 'frame=', __sttFrameCounter, 'bytes=', payload.length, 'codec=', codec);
      }
      return sttProvider.sendAudio(payload, codec);
    }
    return deepgramManager.sendAudio(payload, codec);
  }

  // Enhanced processOpenAI with Function Calling Support
  async function processOpenAIWithActions(transcript: string, intentResult?: IntentResult) {
    const processingStartTs = Date.now();
    connTurnStartTs = processingStartTs;
    connLlmFirstTokenMs = -1;
    connTtsFirstAudioMs = -1;
    const timestampStr = new Date().toISOString().split('T')[1].slice(0, -1);
    console.log(`[agent] [${timestampStr}] 🚀 Starting LLM processing with actions for:`, JSON.stringify(transcript), `processingStart: ${processingStartTs}`);
    
    if (!openaiManager || !actionManager || !session) {
      console.warn('[agent] Actions not available, falling back to regular processing');
      return processOpenAIAndTTS(transcript, intentResult);
    }

    openaiAbort = new AbortController();
    processingTurn = true;

    try {
      // KB GROUNDING - Check knowledge base first (CRITICAL FIX)
      let kbContextForMessages: string | null = null;
      try {
        const useKb = String(process.env.KB_ENABLED || 'true') === 'true';
        const hasAgent = Boolean(session?.agentId);

        console.log('[agent] 📚 KB check (actions path):', {
          useKb,
          hasAgent,
          agentId: session?.agentId,
          transcript: transcript?.substring(0, 100)
        });

        if (useKb && hasAgent && session && transcript) {
          const { retrieve } = require('../src/lib/retrieve');
          const chunks = await retrieve(transcript, session.agentId, 5) as any[];

          console.log('[agent] Retrieved KB chunks:', {
            count: chunks.length,
            topScore: chunks[0]?.score
          });

          if (chunks && chunks.length > 0) {
            const topChunks = chunks
              .slice(0, 3)
              .map((chunk: any, i: number) => {
                const preview = chunk.content.substring(0, 400);
                return `[Knowledge ${i + 1}] ${preview}`;
              })
              .join('\n\n');

            kbContextForMessages = `=== YOUR PERSONAL KNOWLEDGE BASE ===\n${topChunks}\n\n⚠️ CRITICAL: Use this as YOUR OWN expertise. Speak with authority using "we", "our", "I". Never mention "knowledge base" or "sources".`;
            console.log('[agent] ✅ Added KB context to messages (', kbContextForMessages.length, 'chars)');
          } else {
            console.log('[agent] ⚠️ No KB chunks found for this query');
          }
        }
      } catch (kbErr) {
        console.error('[agent] ❌ KB retrieval error:', kbErr);
      }

      // Prepare context for actions
      const actionContext: ActionContext = {
        userId: session.sessionId, // Use sessionId as userId for now
        agentId: session.agentId || 'default',
        sessionId: session.sessionId,
        permissions: ['email:send', 'notes:create', 'slack:write'], // Grant basic permissions
        timestamp: Date.now()
      };

      // Get conversation history
      const messages = conversationMemory.getMessages(session.sessionId);

      // INJECT KB CONTEXT into system message if available
      if (kbContextForMessages && messages.length > 0 && messages[0]?.role === 'system') {
        messages[0].content += `\n\n${kbContextForMessages}`;
        console.log('[agent] 📝 Injected KB context into system message');
      }

      // Get available functions for this agent
      const availableFunctions = openaiManager.getAvailableFunctions(session.agentId);
      console.log(`[agent] Available functions: ${availableFunctions.map(f => f.name).join(', ')}`);
      console.log(`[agent] Function descriptions: ${availableFunctions.map(f => `${f.name}: "${f.description}"`).join(' | ')}`);

      // Create completion with function calling
      const stream = await openaiManager.createChatCompletion(messages, {
        functions: availableFunctions,
        functionCall: 'auto',
        stream: true,
        abortSignal: openaiAbort.signal
      });

      let full = '';
      let functionCallDetected = false;

      // Process streaming response with function call handling
      await openaiManager.processStreamingResponse(
        stream as any,
        // onToken
        (token: string) => {
          full += token;
          if (connLlmFirstTokenMs < 0 && connTurnStartTs > 0) {
            connLlmFirstTokenMs = Date.now() - connTurnStartTs;
            try { sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { llmFirstTokenMs: connLlmFirstTokenMs } }); } catch {}
          }
          sendJson(ws, { 
            type: 'llm.partial', 
            ts: nowTs(), 
            sessionId: session?.sessionId ?? 'unknown', 
            turnId: session?.turnId ?? 'unknown', 
            data: { text: token } 
          });
        },
        // onFunctionCall
        async (functionCall) => {
          functionCallDetected = true;
          console.log(`[agent] 🔧 Function call detected: ${functionCall.name}`);
          
          try {
            // Execute the action
            const functionResult = await actionManager!.executeAction(functionCall, actionContext);
            
            // Send action execution result to client
            sendJson(ws, { 
              type: 'action.executed', 
              ts: nowTs(),
              sessionId: session?.sessionId ?? 'unknown', 
              turnId: session?.turnId ?? 'unknown',
              data: { 
                action: functionCall.name,
                success: functionResult.success,
                message: functionResult.message,
                data: functionResult.data
              } 
            });

            // Continue conversation with function result
            const continuedStream = await openaiManager!.continueConversationAfterFunction(
              messages,
              functionCall,
              functionResult,
              { stream: true, abortSignal: openaiAbort?.signal }
            );

            // Process the continued response
            await openaiManager!.processStreamingResponse(
              continuedStream as any,
              (token: string) => {
                full += token;
                sendJson(ws, { 
                  type: 'llm.partial', 
                  ts: nowTs(), 
                  sessionId: session?.sessionId ?? 'unknown', 
                  turnId: session?.turnId ?? 'unknown', 
                  data: { text: token } 
                });
              },
              undefined, // no nested function calls for now
              (response) => {
                sendJson(ws, { 
                  type: 'llm.final', 
                  ts: nowTs(), 
                  sessionId: session?.sessionId ?? 'unknown', 
                  turnId: session?.turnId ?? 'unknown', 
                  data: { text: response.text } 
                });
                
                // Add assistant response to conversation memory
                conversationMemory.addAssistantMessage(session?.sessionId ?? 'unknown', response.text || '');
                
                // Start TTS
                if (response.text) {
                  startTTSProcessing(response.text);
                }
              }
            );

          } catch (actionError) {
            console.error('[agent] Action execution failed:', actionError);
            const errorMessage = `I tried to ${functionCall.name} but encountered an error: ${actionError instanceof Error ? actionError.message : 'Unknown error'}`;
            
            sendJson(ws, { 
              type: 'llm.final', 
              ts: nowTs(), 
              sessionId: session?.sessionId ?? 'unknown', 
              turnId: session?.turnId ?? 'unknown', 
              data: { text: errorMessage } 
            });
            
            conversationMemory.addAssistantMessage(session?.sessionId ?? 'unknown', errorMessage);
            startTTSProcessing(errorMessage);
          }
        },
        // onComplete (for regular responses without function calls)
        (response) => {
          if (!functionCallDetected) {
            sendJson(ws, { 
              type: 'llm.final', 
              ts: nowTs(), 
              sessionId: session?.sessionId ?? 'unknown', 
              turnId: session?.turnId ?? 'unknown', 
              data: { text: response.text } 
            });
            
            conversationMemory.addAssistantMessage(session?.sessionId ?? 'unknown', response.text || '');
            
            if (response.text) {
              startTTSProcessing(response.text);
            }
          }
        }
      );

    } catch (error) {
      console.error('[agent] Enhanced OpenAI processing failed:', error);
      // Fallback to regular processing
      return processOpenAIAndTTS(transcript, intentResult);
    } finally {
      processingTurn = false;
    }
  }

  // Helper function to start TTS processing
  function startTTSProcessing(text: string) {
    if (!session) return;
    
    const { apiKey: elevenApiKey, voiceId: elevenVoiceId } = getElevenLabsConfig(session.voiceId);
    if (elevenApiKey && elevenVoiceId) {
      // Align TTS streaming format with binary frame used elsewhere
      ttsEnded = false;
      ttsStartTime = Date.now();
      currentTtsText = text;
      isTtsActive = true;
      notifyTtsStart(); // Notify turn detector
      (async () => {
        try {
          const abort = new AbortController();
          ttsAbort = abort;
          let seq = 0;
          if (useMulti && ttsProvider) {
            console.log('[tts] Using provider interface for TTS', (ttsProvider as any).type, 'voiceId=', elevenVoiceId);
            for await (const chunk of ttsProvider.stream(text, { voiceId: elevenVoiceId, optimizeStreamingLatency: 2, signal: abort.signal })) {
              try {
                if (connTtsFirstAudioMs < 0 && connTurnStartTs > 0) {
                  connTtsFirstAudioMs = Date.now() - connTurnStartTs;
                  sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { ttsFirstAudioMs: connTtsFirstAudioMs } });
                }
              } catch {}
              const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seq++, mime: 'audio/mpeg' };
              ws.send(encodeBinaryFrame(header, chunk));
            }
            sendTtsEnd('complete');
          } else {
            console.log('[tts] Using legacy ElevenLabs stream path');
            await streamElevenLabsTTS({
              text,
              apiKey: elevenApiKey,
              voiceId: elevenVoiceId,
              optimizeStreamingLatency: 2,
              signal: abort.signal,
              onChunk: (chunk: Buffer) => {
                try {
                  if (connTtsFirstAudioMs < 0 && connTurnStartTs > 0) {
                    connTtsFirstAudioMs = Date.now() - connTurnStartTs;
                    sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { ttsFirstAudioMs: connTtsFirstAudioMs } });
                  }
                } catch {}
                const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seq++, mime: 'audio/mpeg' };
                ws.send(encodeBinaryFrame(header, chunk));
              },
              onEnd: (reason: 'complete' | 'barge' | 'error') => {
                sendTtsEnd(reason);
              }
            });
          }
        } catch (error) {
          console.error('[agent] TTS error in startTTSProcessing:', error);
          sendTtsEnd('error');
        }
      })();
    }
  }

  async function processOpenAIAndTTS(transcript: string, intentResult?: IntentResult) {
    const processingStartTs = Date.now();
    const timestampStr = new Date().toISOString().split('T')[1].slice(0, -1);
    console.log(`[agent] [${timestampStr}] 🚀 Starting LLM processing for:`, JSON.stringify(transcript), `processingStart: ${processingStartTs}`);
    
    openaiAbort = new AbortController();
    let full = '';
    const turnStartTs = Date.now();
    connTurnStartTs = turnStartTs;
    let llmFirstTokenMs = -1;
    let ttsFirstAudioMs = -1;
    // Phase 2.2: Early TTS on first complete sentence, then remainder
    let earlyTtsStartedFlag = false;
    let earlyTtsEndedFlag = false;
    let earlyTtsSentence = '';
    let remainderAfterEarly = '';
    const logMetrics = (label: string) => {
      console.log('[metrics]', label, {
        llmFirstTokenMs,
        ttsFirstAudioMs,
        turnElapsedMs: Date.now() - turnStartTs,
      });
    };
    processingTurn = true;
    (async () => {
      try {
        // Attempt KB grounding if agentId present and KB feature is enabled
        let kbPreface: string | null = null;
        let kbContextForLLM: string | null = null;
        let kbDebugInfo: any = null;

        try {
          const useKb = String(process.env.KB_ENABLED || 'true') === 'true';
          const hasAgent = Boolean(session?.agentId);

          console.log('[agent] 📚 KB check:', {
            useKb,
            hasAgent,
            agentId: session?.agentId,
            transcript: transcript?.substring(0, 100)
          });

          if (useKb && hasAgent && session && transcript) {
            const { groundedAnswer } = require('../src/lib/grounded');
            const result = await groundedAnswer(transcript, session.agentId) as GroundedAnswerResult;

            kbDebugInfo = {
              sourcesFound: result?.sources?.length || 0,
              hasText: Boolean(result?.text),
              textLength: result?.text?.length || 0,
              text: result?.text?.substring(0, 100)
            };

            console.log('[agent] 📊 KB grounded result:', kbDebugInfo);

            if (result && Array.isArray(result.sources) && result.sources.length > 0) {
              // Check if we got a meaningful answer (not the default "I don't have enough information")
              const hasValidAnswer = result.text &&
                result.text !== "I don't have enough information for that yet." &&
                result.text.length > 20;

              if (hasValidAnswer) {
                kbPreface = result.text;
                console.log('[agent] ✅ Using grounded KB answer:', kbPreface.substring(0, 100) + '...');
              } else {
                // KB found sources but no confident answer - get context for LLM
                console.log('[agent] 📖 KB found sources but no direct answer, fetching context for LLM...');
                try {
                  const { retrieve } = require('../src/lib/retrieve');
                  const chunks = await retrieve(transcript, session.agentId, 5) as KBChunk[];

                  console.log('[agent] Retrieved chunks for LLM context:', {
                    count: chunks.length,
                    topScore: chunks[0]?.score,
                    hasContent: chunks.length > 0 && Boolean(chunks[0]?.content)
                  });

                  if (chunks && chunks.length > 0 && chunks[0]?.content) {
                    const topChunks = chunks
                      .slice(0, 3)
                      .map((chunk, i) => {
                        const preview = chunk.content.substring(0, 400);
                        return `[Knowledge Area ${i + 1}] ${preview}`;
                      })
                      .join('\n\n');

                    kbContextForLLM = `=== YOUR PERSONAL KNOWLEDGE BASE ===\n${topChunks}\n\n⚠️ IMPORTANT: Use this as YOUR OWN expertise. Speak with confidence using "we", "our", "I". Don't mention "knowledge base", "sources" or "documents".`;
                    console.log('[agent] ✅ Added KB context to LLM prompt (', topChunks.length, 'chars)');
                  } else {
                    console.warn('[agent] ⚠️ No chunks retrieved despite sources existing - possible retrieval issue!');
                  }
                } catch (retrieveErr) {
                  console.error('[agent] ❌ KB context retrieval failed:', retrieveErr);
                }
              }
            } else {
              console.log('[agent] ⚠️ No KB sources found for query - KB might be empty or query mismatch');
            }
          } else {
            console.log('[agent] KB disabled or no agent:', { useKb, hasAgent });
          }
        } catch (e) {
          console.error('[agent] ❌ KB grounding error:', e);
        }
        // If we have a grounded KB answer, use it directly for fastest, most faithful response
        if (kbPreface) {
          full = kbPreface;
          if (LOG_LEVEL === 'debug') console.log('[agent] Using grounded KB answer directly');
          sendJson(ws, { type: 'llm.final', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { text: full } });
          try { if (session) conversationMemory.addAssistantMessage(session.sessionId, full); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
          // Proceed to TTS of the grounded answer
          const { apiKey: finalApiKey, voiceId: finalVoiceId } = getElevenLabsConfig(session?.voiceId);
          if (finalApiKey && finalVoiceId) {
            const epRaw = (session as any)?.endpointing || {};
            const ep = {
              waitSeconds: Math.min(0.3, Math.max(0, Number((epRaw as any).waitSeconds ?? 0.1))),
              punctuationSeconds: Math.min(0.25, Math.max(0, Number((epRaw as any).punctuationSeconds ?? 0.05))),
              noPunctSeconds: Math.min(0.8, Math.max(0.3, Number((epRaw as any).noPunctSeconds ?? 0.35))),
              numberSeconds: Math.min(0.5, Math.max(0, Number((epRaw as any).numberSeconds ?? 0.1))),
            };
            let delayMs = Math.round((ep.waitSeconds || 0) * 1000);
            if (/[\.!?]$/.test(full)) delayMs += Math.round((ep.punctuationSeconds || 0) * 1000);
            if (!/[\.!?]$/.test(full)) delayMs += Math.round((ep.noPunctSeconds || 0) * 1000);
            if (/\d$/.test(full)) delayMs += Math.round((ep.numberSeconds || 0) * 1000);
            if (delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(delayMs, 200)));
            ttsEnded = false;
            ttsStartTime = Date.now();
            currentTtsText = full;
            isTtsActive = true;
            const abort = new AbortController();
            ttsAbort = abort;
            let seq = 0;
            await streamElevenLabsTTS({
              apiKey: finalApiKey,
              voiceId: finalVoiceId,
              text: full,
              optimizeStreamingLatency: 2,
              onChunk: (chunk) => {
                if (ttsFirstAudioMs < 0) { ttsFirstAudioMs = Date.now() - turnStartTs; connTtsFirstAudioMs = ttsFirstAudioMs; logMetrics('tts.first'); sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { ttsFirstAudioMs } }); }
                const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seq++, mime: 'audio/mpeg' };
                ws.send(encodeBinaryFrame(header, chunk));
              },
              onEnd: (reason) => { sendTtsEnd(reason); },
              signal: abort.signal,
            });
          } else {
            sendTtsEnd('complete');
          }
          return; // Skip normal OpenAI streaming path
        }

        // Phase 3: Response cache lookup for common questions
        try {
          const agentId = (session as any)?.agentId || 'na';
          const key = `${agentId}|${String(transcript).toLowerCase().replace(/[\s\.,!?]+/g, ' ').trim()}`;
          const hit = responseCache.get(key);
          if (hit && Date.now() - hit.ts < CACHE_TTL_MS && hit.text) {
            full = hit.text;
            if (LOG_LEVEL === 'debug') console.log('[agent] Cache hit; using cached response');
            sendJson(ws, { type: 'llm.final', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { text: full } });
            try { if (session) conversationMemory.addAssistantMessage(session.sessionId, full); } catch {}
            const { apiKey: apiC, voiceId: vC } = getElevenLabsConfig(session?.voiceId);
            if (apiC && vC) {
              const epRaw = (session as any)?.endpointing || {};
              const ep = {
                waitSeconds: Math.min(0.3, Math.max(0, Number((epRaw as any).waitSeconds ?? 0.1))),
                punctuationSeconds: Math.min(0.25, Math.max(0, Number((epRaw as any).punctuationSeconds ?? 0.05))),
                noPunctSeconds: Math.min(0.8, Math.max(0.3, Number((epRaw as any).noPunctSeconds ?? 0.35))),
                numberSeconds: Math.min(0.5, Math.max(0, Number((epRaw as any).numberSeconds ?? 0.1))),
              };
              let delayMs = Math.round((ep.waitSeconds || 0) * 1000);
              if (/[\.!?]$/.test(full)) delayMs += Math.round((ep.punctuationSeconds || 0) * 1000);
              if (!/[\.!?]$/.test(full)) delayMs += Math.round((ep.noPunctSeconds || 0) * 1000);
              if (/\d$/.test(full)) delayMs += Math.round((ep.numberSeconds || 0) * 1000);
              if (delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(delayMs, 200)));
              ttsEnded = false;
              ttsStartTime = Date.now();
              currentTtsText = full;
              isTtsActive = true;
              const abort = new AbortController();
              ttsAbort = abort;
              let seq = 0;
              await streamElevenLabsTTS({
                apiKey: apiC,
                voiceId: vC,
                text: full,
                optimizeStreamingLatency: 2,
                onChunk: (chunk) => {
                  if (ttsFirstAudioMs < 0) { ttsFirstAudioMs = Date.now() - turnStartTs; connTtsFirstAudioMs = ttsFirstAudioMs; logMetrics('tts.first'); sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { ttsFirstAudioMs } }); }
                  const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seq++, mime: 'audio/mpeg' };
                  ws.send(encodeBinaryFrame(header, chunk));
                },
                onEnd: (reason) => { sendTtsEnd(reason); },
                signal: abort.signal,
              });
              return;
            } else {
              sendTtsEnd('complete');
              return;
            }
          }
        } catch {}

        if (LOG_LEVEL === 'debug') console.log('[agent] Creating OpenAI stream...');
        let messages = session ? conversationMemory.getMessages(session.sessionId) : [{ role: 'system', content: 'You are InsureBot, an AI insurance assistant. Be helpful and conversational.' }];
        // No static brand disambiguation injected; rely on KB grounding only
        // If a custom prompt file exists, override the first system message
        try {
          const promptPath = require('path').join(__dirname, '..', 'data', 'prompt.json');
          if (fs.existsSync(promptPath)) {
            const raw = await fsp.readFile(promptPath, 'utf8');
            const json = JSON.parse(raw);
            // Only override from file if session has no explicit systemPrompt
            const hasSessionPrompt = typeof session?.systemPrompt === 'string' && session.systemPrompt.trim().length > 0;
            if (!hasSessionPrompt && json?.prompt && messages.length > 0 && messages[0]?.role === 'system') {
              messages[0].content = String(json.prompt);
            }
          }
        } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
        // If Hindi is selected, enforce Hindi responses at the system level (strong instruction at top)
        if (session?.language === 'hi') {
          messages = [
            { role: 'system', content: 'IMPORTANT: Respond in natural Hindi (hi-IN) only. Do not use English unless explicitly requested.' } as ChatMessage,
            ...messages
          ];
        }
        
        // Add KB context to enhance LLM responses with personal touch
        if (kbContextForLLM && messages.length > 0 && messages[0]?.role === 'system') {
          messages[0].content += `\n\n=== YOUR PERSONAL EXPERTISE ===\n${kbContextForLLM}\n\n=== RESPONSE INSTRUCTIONS ===\nUse this as YOUR OWN knowledge and experience. Speak personally using "I", "we", "our", etc. Be conversational, enthusiastic, and helpful. Transform this information into engaging personal recommendations. Never say "according to documents" - this IS your expertise.`;
          if (LOG_LEVEL === 'debug') console.log('[agent] Enhanced system message with personal KB context');
        }
      // Note: Hardcoded <__START__> logic removed - first messages now handled via database first_message field
        
        // Enhance with intent-aware system context
        if (intentResult && intentResult.confidence > 0.7) {
          const intentContext = `[INTENT: ${intentResult.intent} (confidence: ${intentResult.confidence})]`;
          const entityContext = Object.keys(intentResult.entities).length > 0 
            ? `[ENTITIES: ${Object.entries(intentResult.entities).map(([k,v]) => `${k}=${v.value}`).join(', ')}]`
            : '';
          const contextualPrompt = `${intentContext} ${entityContext} ${intentResult.suggestedResponse || ''}`;
          
          // Add context as a system message if not already present
          if (messages.length > 0 && messages[0].role === 'system') {
            messages[0] = {
              ...messages[0],
              content: `${messages[0].content}\n\nCONTEXT: ${contextualPrompt}`
            };
          }
          if (LOG_LEVEL === 'debug') console.log('[agent] Enhanced prompt with intent context:', contextualPrompt);
        }
        async function createOpenAIStreamWithRetry(): Promise<AsyncIterable<string> | any> {
          const shortUtterance = (transcript || '').trim().length <= 120;
          const modelToUse = shortUtterance ? (process.env.FAST_LLM_MODEL || 'gpt-3.5-turbo') : 'gpt-4o-mini';
          if (useMulti && llmProvider) {
            console.log('[llm] 🤖 USING PROVIDER LLM:', (llmProvider as any).type.toUpperCase(), '(' + llmProvider.name + ')', 'model=', modelToUse);
            return llmProvider.stream(messages as any, { model: modelToUse, temperature: 0, maxTokens: 150, signal: openaiAbort?.signal as any });
          }
          let attempt = 0;
          for (;;) {
            try {
              console.log('[llm] 🤖 USING LEGACY LLM: OPENAI (Direct SDK)', 'model=', modelToUse);
              return await agentConfig.openai.chat.completions.create({
                model: modelToUse,
                messages: messages as any,
                temperature: 0,
                max_tokens: 150,
                stream: true,
                ...(process.env.OPENAI_STREAMING_OPTIMIZATIONS === 'true' && { frequency_penalty: 0, presence_penalty: 0 })
              });
            } catch (e) {
              attempt += 1;
              if (attempt >= 2) throw e;
              await new Promise((r) => setTimeout(r, 200));
            }
          }
        }
        const stream = await createOpenAIStreamWithRetry();
        
        let ttsStarted = false;
        const { apiKey: elevenApiKey, voiceId: elevenVoiceId } = getElevenLabsConfig(session?.voiceId);
        
        if (useMulti && llmProvider && Symbol.asyncIterator in Object(stream)) {
          for await (const content of stream as AsyncIterable<string>) {
            full += content;
            sendJson(ws, { type: 'llm.partial', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { text: content } });
            if (llmFirstTokenMs < 0) { llmFirstTokenMs = Date.now() - turnStartTs; connLlmFirstTokenMs = llmFirstTokenMs; logMetrics('llm.first'); sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { llmFirstTokenMs } }); }
            
            // Start EARLY TTS for the first complete sentence (safe boundary)
            if (!earlyTtsStartedFlag && elevenApiKey && elevenVoiceId) {
              const match = full.match(/^[\s\S]*?[\.!?](?:\s|$)/);
              const candidate = match ? String(match[0]).trim() : '';
              const wordCount = candidate ? candidate.split(/\s+/).filter(Boolean).length : 0;
              if (candidate && wordCount >= 6) {
                earlyTtsStartedFlag = true;
                ttsStarted = true;
                earlyTtsSentence = candidate;
                // Protect TTS state
                ttsEnded = false;
                ttsStartTime = Date.now();
                currentTtsText = candidate;
                isTtsActive = true;
                // Fire-and-forget: stream early sentence
                (async () => {
                  try {
                    let seqEarly = 0;
                    await streamElevenLabsTTS({
                      apiKey: elevenApiKey,
                      voiceId: elevenVoiceId,
                      text: candidate,
                      optimizeStreamingLatency: 2,
                      onChunk: (chunk) => {
                        if (ttsFirstAudioMs < 0) { ttsFirstAudioMs = Date.now() - turnStartTs; connTtsFirstAudioMs = ttsFirstAudioMs; logMetrics('tts.first'); sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { ttsFirstAudioMs } }); }
                        const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seqEarly++, mime: 'audio/mpeg' };
                        ws.send(encodeBinaryFrame(header, chunk));
                      },
                      onEnd: (reason) => {
                        earlyTtsEndedFlag = true;
                        // If remainder was prepared after final, speak it now; else end
                        if (remainderAfterEarly) {
                          (async () => {
                            try {
                              let seqRem = 0;
                              await streamElevenLabsTTS({
                                apiKey: elevenApiKey,
                                voiceId: elevenVoiceId,
                                text: remainderAfterEarly,
                                optimizeStreamingLatency: 2,
                                onChunk: (chunk) => {
                                  const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seqRem++, mime: 'audio/mpeg' };
                                  ws.send(encodeBinaryFrame(header, chunk));
                                },
                                onEnd: (r2) => { sendTtsEnd(r2); remainderAfterEarly = ''; },
                                signal: new AbortController().signal,
                              });
                            } catch {
                              sendTtsEnd('error');
                            }
                          })();
                        } else {
                          sendTtsEnd(reason);
                        }
                      },
                      signal: new AbortController().signal,
                    });
                  } catch (e) {
                    console.log('[agent] Early TTS failed:', e instanceof Error ? e.message : String(e));
                  }
                })();
              }
            }
          }
        } else {
          for await (const chunk of stream as any) {
            const content = chunk?.choices?.[0]?.delta?.content ?? '';
            if (content) {
              full += content;
              sendJson(ws, { type: 'llm.partial', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { text: content } });
              if (llmFirstTokenMs < 0) { llmFirstTokenMs = Date.now() - turnStartTs; connLlmFirstTokenMs = llmFirstTokenMs; logMetrics('llm.first'); sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { llmFirstTokenMs } }); }
              
              // Start EARLY TTS for the first complete sentence (safe boundary)
              if (!earlyTtsStartedFlag && elevenApiKey && elevenVoiceId) {
                const match = full.match(/^[\s\S]*?[\.!?](?:\s|$)/);
                const candidate = match ? String(match[0]).trim() : '';
                const wordCount = candidate ? candidate.split(/\s+/).filter(Boolean).length : 0;
                if (candidate && wordCount >= 6) {
                  earlyTtsStartedFlag = true;
                  ttsStarted = true;
                  earlyTtsSentence = candidate;
                  // Protect TTS state
                  ttsEnded = false;
                  ttsStartTime = Date.now();
                  currentTtsText = candidate;
                  isTtsActive = true;
                  // Fire-and-forget: stream early sentence
                  (async () => {
                    try {
                      let seqEarly = 0;
                      await streamElevenLabsTTS({
                        apiKey: elevenApiKey,
                        voiceId: elevenVoiceId,
                        text: candidate,
                        optimizeStreamingLatency: 2,
                        onChunk: (chunk) => {
                          if (ttsFirstAudioMs < 0) { ttsFirstAudioMs = Date.now() - turnStartTs; connTtsFirstAudioMs = ttsFirstAudioMs; logMetrics('tts.first'); sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { ttsFirstAudioMs } }); }
                          const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seqEarly++, mime: 'audio/mpeg' };
                          ws.send(encodeBinaryFrame(header, chunk));
                        },
                        onEnd: (reason) => {
                          earlyTtsEndedFlag = true;
                          // If remainder was prepared after final, speak it now; else end
                          if (remainderAfterEarly) {
                            (async () => {
                              try {
                                let seqRem = 0;
                                await streamElevenLabsTTS({
                                  apiKey: elevenApiKey,
                                  voiceId: elevenVoiceId,
                                  text: remainderAfterEarly,
                                  optimizeStreamingLatency: 2,
                                  onChunk: (chunk) => {
                                    const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seqRem++, mime: 'audio/mpeg' };
                                    ws.send(encodeBinaryFrame(header, chunk));
                                  },
                                  onEnd: (r2) => { sendTtsEnd(r2); remainderAfterEarly = ''; },
                                  signal: new AbortController().signal,
                                });
                              } catch {
                                sendTtsEnd('error');
                              }
                            })();
                          } else {
                            sendTtsEnd(reason);
                          }
                        },
                        signal: new AbortController().signal,
                      });
                    } catch (e) {
                      console.log('[agent] Early TTS failed:', e instanceof Error ? e.message : String(e));
                    }
                  })();
                }
              }
            }
          }
        }
        
        if (LOG_LEVEL === 'debug') console.log('[agent] OpenAI streaming complete. Full response:', full);
        sendJson(ws, { type: 'llm.final', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { text: full } });
        
        try {
          if (session) {
            conversationMemory.addAssistantMessage(session.sessionId, full);
          }
          // Populate cache for repeated questions
          try {
            const agentId = (session as any)?.agentId || 'na';
            const key = `${agentId}|${String(transcript).toLowerCase().replace(/[\s\.,!?]+/g, ' ').trim()}`;
            responseCache.set(key, { text: full, ts: Date.now() });
          } catch {}
        } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }

        // Stream TTS: if early TTS was used, queue remainder; else speak full response
        const { apiKey: finalApiKey, voiceId: finalVoiceId } = getElevenLabsConfig(session?.voiceId);
        if (earlyTtsStartedFlag) {
          const trimmedFull = String(full).trimStart();
          const trimmedEarly = String(earlyTtsSentence).trim();
          if (trimmedFull.toLowerCase().startsWith(trimmedEarly.toLowerCase())) {
            remainderAfterEarly = trimmedFull.slice(trimmedEarly.length).trim();
          }
          if (!remainderAfterEarly) {
            if (earlyTtsEndedFlag) sendTtsEnd('complete');
            // else: will end in early onEnd
          }
        } else if (!ttsStarted && finalApiKey && finalVoiceId) {
          // STRICT: Do not start TTS if user is talking
          if (STRICT_TURN_TAKING && userTalking) {
            console.log('[agent] Strict turn-taking: skipping TTS start because user is talking');
            return;
          }
          // Simple endpointing delays based on session settings
          const epRaw = (session as any)?.endpointing || {};
          const ep = {
            waitSeconds: Math.min(1, Math.max(0, Number((epRaw as any).waitSeconds ?? 0.15))),
            punctuationSeconds: Math.min(0.5, Math.max(0, Number((epRaw as any).punctuationSeconds ?? 0.1))),
            noPunctSeconds: Math.min(1, Math.max(0.3, Number((epRaw as any).noPunctSeconds ?? 0.4))),
            numberSeconds: Math.min(1, Math.max(0, Number((epRaw as any).numberSeconds ?? 0.2))),
          };
          let delayMs = Math.round((ep.waitSeconds || 0) * 1000);
          if (/[\.!?]$/.test(full)) delayMs += Math.round((ep.punctuationSeconds || 0) * 1000);
          if (!/[\.!?]$/.test(full)) delayMs += Math.round((ep.noPunctSeconds || 0) * 1000);
          if (/\d$/.test(full)) delayMs += Math.round((ep.numberSeconds || 0) * 1000);
          if (delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(delayMs, 2000)));
          if (STRICT_TURN_TAKING && userTalking) {
            console.log('[agent] Strict turn-taking (post-delay): user resumed talking, skip TTS');
            return;
          }
          
          ttsEnded = false;
          ttsStartTime = Date.now();
          currentTtsText = full;
          isTtsActive = true;
          const ttsStartTs = Date.now();
          const ttsTimestampStr = new Date().toISOString().split('T')[1].slice(0, -1);
          console.log(`[agent] [${ttsTimestampStr}] 🎵 Starting TTS for:`, full.slice(0, 50) + '...', `ttsStart: ${ttsStartTs}`);
          
          const abort = new AbortController();
          ttsAbort = abort;
          let seq = 0;
          if (useMulti && ttsProvider) {
            console.log('[tts] Using provider interface for TTS', (ttsProvider as any).type, 'voiceId=', finalVoiceId);
            for await (const chunk of ttsProvider.stream(full, { voiceId: finalVoiceId, optimizeStreamingLatency: 2, signal: abort.signal })) {
              if (ttsFirstAudioMs < 0) { ttsFirstAudioMs = Date.now() - turnStartTs; connTtsFirstAudioMs = ttsFirstAudioMs; logMetrics('tts.first'); sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { ttsFirstAudioMs } }); }
              const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seq++, mime: 'audio/mpeg' };
              ws.send(encodeBinaryFrame(header, chunk));
            }
            sendTtsEnd('complete');
          } else {
            await streamElevenLabsTTS({
              apiKey: elevenApiKey,
              voiceId: elevenVoiceId,
              text: full,
               optimizeStreamingLatency: 2,
              onChunk: (chunk) => {
                if (ttsFirstAudioMs < 0) { ttsFirstAudioMs = Date.now() - turnStartTs; connTtsFirstAudioMs = ttsFirstAudioMs; logMetrics('tts.first'); sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { ttsFirstAudioMs } }); }
                const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seq++, mime: 'audio/mpeg' };
                ws.send(encodeBinaryFrame(header, chunk));
              },
              onEnd: (reason) => { sendTtsEnd(reason); },
              signal: abort.signal,
            });
          }
        } else {
          // If early TTS was started, let its onEnd callback send tts.end.
          // Avoid premature tts.end here to prevent truncation.
          if (!ttsStarted) sendTtsEnd('complete');
        }
      } catch (err) {
        console.error('[agent] OpenAI/TTS error:', err);
        // Ensure a single tts.end on error
        sendTtsEnd('error');
      }
    })();
  }

  function sendTtsEnd(reason: 'complete' | 'barge' | 'error') {
    if (ttsEnded) return;
    ttsEnded = true;
    // Clear TTS protection state
    isTtsActive = false;
    currentTtsText = '';
    processingTurn = false;
    
    // Notify turn detector that agent stopped speaking
    if (turnDetector) {
      turnDetector.onAgentStopSpeaking(Date.now());
    }
    
    const ttsElapsed = Date.now() - ttsStartTime;
    console.log('[agent] TTS ended:', reason, 'after', ttsElapsed, 'ms');
    try {
      // Update global turn metrics and notify client
      lastLlmFirstTokenMs = connLlmFirstTokenMs;
      lastTtsFirstAudioMs = connTtsFirstAudioMs;
      lastTurnElapsedMs = Math.max(0, Date.now() - (connTurnStartTs || Date.now()));
      totalTurns += 1;
      pushSample(llmFirstTokenHistory, lastLlmFirstTokenMs);
      pushSample(ttsFirstAudioHistory, lastTtsFirstAudioMs);
      pushSample(e2eHistory, lastTurnElapsedMs);
      const cls = classifyLatency();
      sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { e2eMs: lastTurnElapsedMs, llmFirstTokenMs: lastLlmFirstTokenMs, ttsFirstAudioMs: lastTtsFirstAudioMs, latencyStatus: cls.latencyStatus, reasons: cls.reasons } });
    } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
    
    sendJson(ws, {
      type: 'tts.end',
      ts: nowTs(),
      sessionId: session?.sessionId ?? 'unknown',
      turnId: session?.turnId ?? 'unknown',
      data: { reason },
    });

    // If a user STT final was deferred during active TTS, process it now
    try {
      const text = pendingUserFinal;
      if (text && String(text).trim()) {
        pendingUserFinal = null;
        console.log('[agent] Processing deferred STT final after TTS end');
        const transcript = String(text);
        // Emit synthetic stt.final for UI continuity
        sendJson(ws, { type: 'stt.final', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { text: transcript, startTs: nowTs() - 50, endTs: nowTs() } });
        // Update duplicate guard baseline
        lastSttFinalText = transcript;
        lastSttFinalAt = Date.now();
        // Intent analysis
        const conversationHistory = session ? conversationMemory.getMessages(session.sessionId).map(m => m.content) : [];
        const intentResult = intentAnalyzer.analyzeIntent(transcript, conversationHistory);
        // Ensure conversation exists or create it
        if (session) {
          let conversation = conversationMemory.getConversation(session.sessionId);
          if (!conversation) {
            conversation = conversationMemory.createConversation(session.sessionId, session.systemPrompt || 'You are InsureBot, an AI insurance assistant. Be helpful and conversational.');
          }
          conversationMemory.addUserMessage(session.sessionId, transcript);
        }
        // Process via actions (if available) or regular path
        const ACTIONS_ENABLED = String(process.env.ACTIONS_ENABLED || 'true') === 'true';
        if (ACTIONS_ENABLED && openaiManager && actionManager) {
          processOpenAIWithActions(transcript, intentResult);
        } else {
          processOpenAIAndTTS(transcript, intentResult);
        }
      }
    } catch (e: unknown) {
      console.error('[agent] Failed to process deferred STT final:', e instanceof Error ? e.message : String(e));
    }
  }

  // Helper function to notify when TTS starts
  function notifyTtsStart() {
    if (turnDetector) {
      turnDetector.onAgentStartSpeaking(Date.now());
    }
  }

  // Helper function to determine if we should start TTS early
  function shouldStartEarlyTTS(text: string): boolean {
    // Only start TTS with complete sentences to avoid cutting off
    const hasCompleteSentence = /[.!?]\s/.test(text) || /[.!?]$/.test(text.trim());
    const hasSubstantialContent = text.split(/\s+/).length >= 3; // Reduced to 3 words for faster TTS
    const hasClauseEnd = /[,;:]\s/.test(text) && text.split(/\s+/).length >= 2;
    
    // More aggressive TTS starting per AMP analysis
    return hasCompleteSentence || hasSubstantialContent || hasClauseEnd;
  }

  // Send first message directly to TTS without LLM processing
  async function sendTtsDirectly(text: string) {
    try {
      const { apiKey: elevenApiKey, voiceId: elevenVoiceId } = getElevenLabsConfig(session?.voiceId);
      
      if (!elevenApiKey || !elevenVoiceId) {
        console.log('[agent] No TTS config available for direct message');
        return;
      }

      // Send LLM final message for UI
      sendJson(ws, { type: 'llm.final', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { text } });

      // Start TTS
      ttsEnded = false;
      ttsStartTime = Date.now();
      currentTtsText = text;
      isTtsActive = true;
      notifyTtsStart(); // Notify turn detector
      
      const abort = new AbortController();
      ttsAbort = abort;
      let seq = 0;
      
      await streamElevenLabsTTS({
        apiKey: elevenApiKey,
        voiceId: elevenVoiceId,
        text,
        optimizeStreamingLatency: 2,
        onChunk: (chunk) => {
          const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seq++, mime: 'audio/mpeg' };
          ws.send(encodeBinaryFrame(header, chunk));
        },
        onEnd: (reason) => { sendTtsEnd(reason); },
        signal: abort.signal,
      });
    } catch (error) {
      console.error('[agent] Direct TTS error:', error);
      sendTtsEnd('error');
    }
  }

  // Optimized first message processing using faster model
  async function processOpenAIAndTTSFirstMessage(transcript: string) {
    try {
      console.log('[agent] Processing first message with fast model:', transcript);
      
      const messages = conversationMemory.getMessages(session?.sessionId ?? '');
      messages.push({ role: 'user', content: transcript });

      // Use faster model for first messages
      const stream = await agentConfig.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',  // Faster model for greetings
        messages: messages as any,
        temperature: 0,
        max_tokens: 100,  // Shorter responses for greetings
        stream: true,
      });

      let full = '';
      let ttsStarted = false;
      const { apiKey: elevenApiKey, voiceId: elevenVoiceId } = getElevenLabsConfig(session?.voiceId);
      
      for await (const chunk of stream as any) {
        const content = chunk?.choices?.[0]?.delta?.content ?? '';
        if (content) {
          full += content;
          sendJson(ws, { type: 'llm.partial', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { text: content } });
          
          // Start TTS early for first messages (wait for complete sentence)
          if (EARLY_TTS_ENABLED && !ttsStarted && elevenApiKey && elevenVoiceId && shouldStartEarlyTTS(full)) {
            // ttsStarted = true; // REMOVED: This was preventing normal TTS from running
            console.log('[agent] Early TTS trigger detected in first message but disabled for full response:', full.slice(0, 30) + '...');
            // Note: Use optimized streaming that waits for full response  
            // startEarlyTTS(full, elevenApiKey, elevenVoiceId); // Disabled to prevent truncation
          }
        }
      }
      
      sendJson(ws, { type: 'llm.final', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { text: full } });
      
      if (session) {
        conversationMemory.addAssistantMessage(session.sessionId, full);
      }
      
      // Process TTS with the complete response
      if (!ttsStarted && elevenApiKey && elevenVoiceId && full.trim()) {
        console.log('[agent] Starting TTS for complete first message response');
        await sendTtsDirectly(full);
      }
      
    } catch (e: unknown) {
      console.error('[agent] First message processing error:', e instanceof Error ? e.message : String(e));
      // Fallback to regular processing
      processOpenAIAndTTS(transcript);
    }
  }

  // Helper function to start TTS early with partial content
  function startEarlyTTS(text: string, apiKey: string, voiceId: string) {
    // Apply minimal endpointing delays for speed
    const ep = (session as any)?.endpointing || { waitSeconds: 0.1 };
    const delayMs = Math.round((ep.waitSeconds || 0.1) * 1000);
    
    setTimeout(async () => {
      ttsEnded = false;
      ttsStartTime = Date.now();
      currentTtsText = text;
      isTtsActive = true;
      notifyTtsStart(); // Notify turn detector
      
      const abort = new AbortController();
      ttsAbort = abort;
      let seq = 0;
      
      try {
        await streamElevenLabsTTS({
          apiKey,
          voiceId,
          text,
          optimizeStreamingLatency: 2, // Highest speed setting
          onChunk: (chunk) => {
            const header = { type: 'tts.chunk', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', seq: seq++, mime: 'audio/mpeg' };
            ws.send(encodeBinaryFrame(header, chunk));
          },
          onEnd: (reason) => { sendTtsEnd(reason); },
          signal: abort.signal,
        });
      } catch (err) {
        console.error('[agent] Early TTS error:', err);
        sendTtsEnd('error');
      }
    }, delayMs);
  }

  ws.on('pong', () => {
    alive = true;
  });

  // Apply UI-provided provider selections from session.start (if multi-provider enabled)
  function applyProviderSelections(sel: any) {
    // Allow UI-driven selections regardless of feature flag to remove .env dependency
    if (!sel || typeof sel !== 'object') return;
    try {
      // LLM
      if (sel.llm && typeof sel.llm === 'object') {
        const llmType = String(sel.llm.type || '').toLowerCase() as any;
        const model = sel.llm.model ? String(sel.llm.model) : undefined;
        const temperature = typeof sel.llm.temperature === 'number' ? sel.llm.temperature : undefined;
        if (llmType === 'openai' || llmType === 'anthropic' || llmType === 'gemini') {
          llmProvider = ProviderFactory.createLLM(llmType, { model, temperature });
        }
      }
      // STT
      if (sel.stt && typeof sel.stt === 'object') {
        const sttType = String(sel.stt.type || '').toLowerCase() as any;
        if (sttType === 'deepgram') {
          sttProvider = ProviderFactory.createSTT('deepgram');
        }
      }
      // TTS
      if (sel.tts && typeof sel.tts === 'object') {
        const ttsType = String(sel.tts.type || '').toLowerCase() as any;
        const voiceId = sel.tts.voiceId ? String(sel.tts.voiceId) : (session?.voiceId || undefined);
        if (ttsType === 'elevenlabs' || ttsType === 'openai') {
          ttsProvider = ProviderFactory.createTTS(ttsType, { voiceId: voiceId || undefined });
        }
      }
      // Update diagnostics snapshot
      try {
        // @ts-ignore
        lastProviders.llm = (llmProvider as any)?.type || (llmProvider as any)?.name || lastProviders.llm;
        // @ts-ignore
        lastProviders.stt = (sttProvider as any)?.type || (sttProvider as any)?.name || lastProviders.stt;
        // @ts-ignore
        lastProviders.tts = (ttsProvider as any)?.type || (ttsProvider as any)?.name || lastProviders.tts;
      } catch {}
      console.log('[providers] Applied UI selections:', lastProviders);
    } catch (e) {
      console.warn('[providers] Failed to apply UI provider selections:', e instanceof Error ? e.message : String(e));
    }
  }

  ws.on('message', async (raw) => {
    try {
      // Update connection activity in pool
      if (connectionId) {
        connectionPool.updateActivity(connectionId);
      }
      
      console.log('[agent] Received message type:', typeof raw, 'isBuffer:', Buffer.isBuffer(raw), 'length:', Buffer.isBuffer(raw) ? raw.length : 'N/A');
      
      // TEMPORARY FIX: Check if this is actually JSON data sent as binary
      if (Buffer.isBuffer(raw) && raw[0] === 123) { // 123 = '{'
        console.log('[agent] Detected JSON sent as binary, converting...');
        try {
          // Size cap for safety
          if (raw.length > MAX_JSON_BYTES) {
            return sendError(ws, session?.sessionId ?? 'unknown', session?.turnId ?? 'unknown', 'payload_too_large', `JSON frame exceeds ${MAX_JSON_BYTES} bytes`);
          }
          const jsonStr = raw.toString('utf8');
          const msg = JSON.parse(jsonStr);
          console.log('[agent] Successfully parsed JSON from binary:', msg.type);
          // Process as JSON message
          const base = EnvelopeSchema.safeParse(msg);
          if (!base.success) {
            return sendError(ws, 'unknown', 'unknown', 'bad_envelope', 'Invalid message envelope');
          }
          // Allowlist of types handled in this shim
          const allowedTypes = new Set(['session.start', 'test.utterance']);
          if (!allowedTypes.has(base.data.type)) {
            return sendError(ws, session?.sessionId ?? 'unknown', session?.turnId ?? 'unknown', 'unsupported', `Type ${base.data.type} not allowed in binary JSON`);
          }
          // Handle critical JSON types that may arrive as binary
          if (base.data.type === 'session.start') {
            const parsedStart = SessionStartSchema.safeParse(msg);
            const s = parsedStart.success ? parsedStart.data : (msg as any);
            // Only reset session if it's truly a new session, otherwise preserve memory
            const prevLang = session?.language;
            if (!session || session.sessionId !== s.sessionId) {
            console.log('[agent] Creating new session:', s.sessionId);
            
            // Associate session with connection pool
            if (connectionId) {
              connectionPool.setSessionId(connectionId, s.sessionId);
            }
            
            session = {
                sessionId: s.sessionId,
                turnId: s.turnId,
              systemPrompt: s.data.systemPrompt || 'You are a helpful AI assistant.',
                voiceId: s.data.voiceId ?? null,
                vadEnabled: s.data.vadEnabled,
                pttMode: s.data.pttMode,
                firstMessageMode: (s.data as any).firstMessageMode || 'assistant_speaks_first',
                language: (s.data as any).language || 'en',
                endpointing: (s.data as any).endpointing,
              };
            // Create new conversation memory with optional first message
            const firstMessage = (session as any).firstMessage;
            conversationMemory.createConversation(s.sessionId, session.systemPrompt, firstMessage);
              // Capture agentId if provided for KB
              try { (session as any).agentId = (s.data as any)?.agentId || (session as any).agentId; } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
            try { activeSessionIds.add(s.sessionId); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
              // Reset intent analyzer for new session
              intentAnalyzer.resetSession();
          } else {
              const messageCount = conversationMemory.getMessageCount(s.sessionId);
              console.log('[agent] Updating existing session:', s.sessionId, 'preserving', messageCount, 'messages');
              // Update session properties but keep conversation history
              session.turnId = s.turnId;
              const newSystemPrompt = s.data.systemPrompt || session.systemPrompt;
              if (newSystemPrompt !== session.systemPrompt) {
              session.systemPrompt = newSystemPrompt || session.systemPrompt;
              conversationMemory.updateSystemPrompt(s.sessionId, session.systemPrompt);
              }
              session.voiceId = s.data.voiceId ?? session.voiceId;
              session.vadEnabled = s.data.vadEnabled;
              session.pttMode = s.data.pttMode;
              session.endpointing = (s.data as any).endpointing || session.endpointing;
              // Update agentId if provided
              try { (session as any).agentId = (s.data as any)?.agentId || (session as any).agentId; } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
              session.firstMessageMode = (s.data as any).firstMessageMode || session.firstMessageMode || 'assistant_speaks_first';
              session.language = (s.data as any).language || session.language || 'en';
            try { if (session.sessionId) activeSessionIds.add(session.sessionId); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
            }
            log('session.start (binary)', session);
            if (!parsedStart.success) {
              console.log('[agent] session.start (binary) schema validation failed, proceeding with tolerant handling:', String(parsedStart.error));
            }
            sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session.sessionId, turnId: session.turnId, data: { alive: true } });
            try {
              // If language changed on an existing connection, recreate Deepgram to honor new language
              const languageChanged = typeof prevLang !== 'undefined' && prevLang !== session.language;
              if (deepgramManager.isConnected() && languageChanged) {
                console.log('[agent] Language changed from', prevLang, 'to', session.language, '— recreating Deepgram connection');
                deepgramManager.closeConnection();
              }
              if (!deepgramManager.isConnected()) {
                createDeepgramConnection({ encoding: 'linear16', sampleRate: 16000, channels: 1 });
              }
            } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
            if (!greeted && session.firstMessageMode === 'assistant_speaks_first') {
              greeted = true;
              // Use database first_message if available, otherwise let system prompt handle greeting
              const firstMsg = (session as any).firstMessage;
              if (firstMsg) {
                // Add first message directly to conversation and send to TTS (skip LLM for predefined message)
                const sessionId = session.sessionId;
                if (sessionId) {
                  conversationMemory.addAssistantMessage(sessionId, firstMsg);
                }
                // Send first message directly to TTS
                sendTtsDirectly(firstMsg);
              } else {
                // Let system prompt handle greeting naturally - use simple trigger with faster model
                processOpenAIAndTTSFirstMessage('Hello');
              }
            }
            return;
          }
          if (base.data.type === 'test.utterance') {
            // Enforce TEST_HOOKS gate in binary-JSON path as well
            if (!TEST_HOOKS) {
              return sendError(ws, session?.sessionId ?? 'unknown', session?.turnId ?? 'unknown', 'forbidden', 'test hooks disabled');
            }
            const t = TestUtteranceSchema.parse(msg);
            console.log('[agent] Processing test.utterance:', t.data.text);
            // Emit stt.final for UI
            sendJson(ws, { type: 'stt.final', ts: nowTs(), sessionId: t.sessionId, turnId: t.turnId, data: { text: t.data.text, startTs: nowTs() - 100, endTs: nowTs() } });
            
            // Stream OpenAI response
            console.log('[agent] Starting OpenAI request...');
            if (session) {
              // Ensure conversation exists or create it
              let conversation = conversationMemory.getConversation(session.sessionId);
              if (!conversation) {
                conversation = conversationMemory.createConversation(session.sessionId, session.systemPrompt || 'You are InsureBot, an AI insurance assistant. Be helpful and conversational.');
              }
              conversationMemory.addUserMessage(session.sessionId, t.data.text);
            }
            openaiAbort = new AbortController();
            
            let full = '';
            try {
              console.log('[agent] Creating OpenAI stream...');
              const messages = session ? conversationMemory.getMessages(session.sessionId) : [{ role: 'system', content: 'You are InsureBot, an AI insurance assistant. Be helpful and conversational.' }];
              const stream = await agentConfig.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: messages as any,
                temperature: 0,
                stream: true,
              });

              console.log('[agent] OpenAI stream created, starting iteration...');
              let chunkCount = 0;
              for await (const chunk of stream as any) {
                chunkCount++;
                console.log('[agent] Received OpenAI chunk', chunkCount, ':', JSON.stringify(chunk));
                const content = chunk?.choices?.[0]?.delta?.content ?? '';
                if (content) {
                  console.log('[agent] Content chunk:', JSON.stringify(content));
                  full += content;
                  sendJson(ws, { type: 'llm.partial', ts: nowTs(), sessionId: t.sessionId, turnId: t.turnId, data: { text: content } });
                }
              }
              console.log('[agent] OpenAI streaming complete. Full response:', JSON.stringify(full));
              sendJson(ws, { type: 'llm.final', ts: nowTs(), sessionId: t.sessionId, turnId: t.turnId, data: { text: full } });
              try {
                if (session) {
                  conversationMemory.addAssistantMessage(session.sessionId, full);
                }
              } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
            } catch (err) {
              console.error('[agent] OpenAI error:', err);
              throw err;
            }
            
            // Stream TTS with ElevenLabs if key and voice are available
            const apiKey = process.env.ELEVENLABS_API_KEY;
            const voiceId = session?.voiceId || process.env.VOICE_ID;
            if (apiKey && voiceId) {
              if (STRICT_TURN_TAKING && userTalking) {
                console.log('[agent] Strict turn-taking: skipping TTS start because user is talking');
                return;
              }
              // Apply simple endpointing delays based on session settings
          const ep = (session as any)?.endpointing || { waitSeconds: 0.1, punctuationSeconds: 0.05, noPunctSeconds: 0.35, numberSeconds: 0.1 };
          let delayMs = Math.round((ep.waitSeconds || 0) * 1000);
          if (/[\\.!?]$/.test(full)) delayMs += Math.round((ep.punctuationSeconds || 0) * 1000);
          if (!/[\\.!?]$/.test(full)) delayMs += Math.round((ep.noPunctSeconds || 0) * 1000);
          if (/\\d$/.test(full)) delayMs += Math.round((ep.numberSeconds || 0) * 1000);
          if (delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(delayMs, 200)));
          ttsEnded = false;
          // Track TTS start for barge-in protection (test utterance binary path)
              ttsStartTime = Date.now();
              currentTtsText = full;
              isTtsActive = true;
              console.log('[agent] Starting TTS protection (test utterance binary) for:', full.slice(0, 100) + '...');
              
              const abort = new AbortController();
              ttsAbort = abort;
              let seq = 0;
              await streamElevenLabsTTS({
                apiKey,
                voiceId,
            text: full,
                optimizeStreamingLatency: 2,
                onChunk: (chunk) => {
                  const header = { type: 'tts.chunk', ts: nowTs(), sessionId: t.sessionId, turnId: t.turnId, seq: seq++, mime: 'audio/mpeg' };
                  ws.send(encodeBinaryFrame(header, chunk));
                },
                onEnd: (reason) => {
                  sendTtsEnd(reason);
                },
                signal: abort.signal,
              });
            } else {
              console.log('[agent] No ElevenLabs API key or voice ID available for TTS');
              sendTtsEnd('complete');
            }
          }
          return;
        } catch (e) {
          console.log('[agent] Failed to parse as JSON, treating as binary frame');
        }
      }
      
      if (Buffer.isBuffer(raw)) {
        // Binary frame: audio.chunk or tts.chunk (client sends only audio.chunk)
        console.log('[agent] Received binary frame:', raw.length, 'bytes, first 16:', Array.from(raw.slice(0, 16)));
        if (raw.length < 4) {
          console.error('[agent] Frame too short:', raw.length, 'bytes');
          return;
        }
        if (raw.length > MAX_FRAME_BYTES) {
          console.error('[agent] Frame too large:', raw.length, 'bytes >', MAX_FRAME_BYTES);
          return sendError(ws, session?.sessionId ?? 'unknown', session?.turnId ?? 'unknown', 'payload_too_large', `Frame exceeds ${MAX_FRAME_BYTES} bytes`);
        }
        const headerLen = raw.readUInt32BE(0);
        console.log('[agent] Header length:', headerLen, 'total frame length:', raw.length, 'expected min length:', 4 + headerLen);
        if (raw.length < 4 + headerLen) {
          console.error('[agent] Invalid frame: header length', headerLen, 'but total frame length', raw.length);
          return;
        }
        try {
          const { header, payload } = decodeBinaryFrame(raw);
          console.log('[agent] Decoded header:', JSON.stringify(header));
          const parsed = AudioChunkHeaderSchema.safeParse(header);
          if (!parsed.success) {
            console.log('[agent] Header validation failed:', parsed.error);
            return; // ignore unknown binary
          }
          console.log('[agent] Header validation SUCCESS, processing audio chunk seq:', parsed.data.seq);
        log('audio.chunk', parsed.data.seq);
          // Record last audio time for STT latency measurement
          lastAudioReceivedTs = Date.now();
          // Token-bucket rate limiting per connection for audio frames
          if (framesBudget <= 0) {
            console.log('[agent] Rate limit exceeded for audio frames; dropping frame seq:', parsed.data.seq);
            return; // Drop silently to prevent overload
          }
          framesBudget -= 1;
        // Phase C: route to STT provider path (multi or legacy)
        if (useMulti && sttProvider) {
          console.log('[stt] Routing audio chunk to provider', (sttProvider as any).type, 'seq=', parsed.data.seq);
        } else {
          console.log('[agent] Starting Deepgram processing for chunk', parsed.data.seq);
        }
          try {
            if (!deepgramManager.isConnected()) {
              if (session) {
                createDeepgramConnection({
                  encoding: parsed.data.codec === 'pcm16' ? 'linear16' : 'opus',
                  sampleRate: parsed.data.sampleRate,
                  channels: parsed.data.channels ?? 1,
                });
              } else {
                console.log('[agent] Deepgram connect deferred until session.start to honor language settings');
              }
            }

          // Forward audio to Deepgram manager
          sendAudioToSTT(payload, parsed.data.codec);
        } catch (e) {
          log('deepgram error', e);
        }
        } catch (e) {
          console.error('[agent] Binary frame decode error:', e);
          return;
        }
        return;
      }

      const msg = JSON.parse(String(raw));
      const base = EnvelopeSchema.safeParse(msg);
      if (!base.success) {
        return sendError(ws, 'unknown', 'unknown', 'bad_envelope', 'Invalid message envelope');
      }

      switch (base.data.type) {
        case 'session.start': {
          const s = SessionStartSchema.parse(msg);
      // Validate optional session JWT if configured
      try {
        const secret = process.env.SESSION_JWT_SECRET;
        const tok = (s.data as any)?.token as string | undefined;
        if (secret && tok) {
          const [headB64, payB64, sigB64] = tok.split('.');
          if (!headB64 || !payB64 || !sigB64) throw new Error('bad_jwt');
          const unsigned = `${headB64}.${payB64}`;
          const expected = require('crypto').createHmac('sha256', secret).update(unsigned).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
          if (expected !== sigB64) throw new Error('bad_sig');
          const payload = JSON.parse(Buffer.from(payB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
          const now = Math.floor(Date.now() / 1000);
          if (typeof payload?.exp !== 'number' || payload.exp < now) throw new Error('expired');
          if (typeof payload?.sid !== 'string' || payload.sid !== s.sessionId) throw new Error('sid_mismatch');
        }
      } catch (e) {
        return sendError(ws, s.sessionId, s.turnId, 'auth_failed', 'invalid token');
      }
          // Only reset session if it's truly a new session, otherwise preserve memory  
          if (!session || session.sessionId !== s.sessionId) {
            console.log('[agent] Creating new session (JSON):', s.sessionId);
            
            // Associate session with connection pool
            if (connectionId) {
              connectionPool.setSessionId(connectionId, s.sessionId);
            }
            
            session = {
              sessionId: s.sessionId,
              turnId: s.turnId,
              systemPrompt: s.data.systemPrompt || '',
              voiceId: s.data.voiceId ?? null,
              vadEnabled: s.data.vadEnabled,
              pttMode: s.data.pttMode,
              firstMessageMode: (s.data as any).firstMessageMode || 'assistant_speaks_first',
              language: (s.data as any).language || 'en',
              endpointing: (s.data as any).endpointing,
            };
            // Use cached agent data if provided, otherwise load from Supabase
            try {
              const agentId = (s.data as any)?.agentId as string | undefined;
              const cachedAgentData = (s.data as any)?.cachedAgentData;
              
              if (cachedAgentData) {
                // Use cached data from client to avoid database query
                console.log('[agent] ⚡ Using cached agent data - skipping database query!');
                session.systemPrompt = String(cachedAgentData.prompt || session.systemPrompt);
                session.voiceId = cachedAgentData.voice_id || session.voiceId;
                session.language = cachedAgentData.language || session.language;
                session.endpointing = cachedAgentData.endpointing || session.endpointing;
                (session as any).firstMessage = cachedAgentData.first_message || null;
                (session as any).agentId = agentId;
              } else if (agentId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
                // Fallback: load from database if no cached data provided
                console.log('[agent] Loading agent data from database...');
                const { supabaseService } = require('../src/lib/supabaseServer');
                const sb = supabaseService();
                const { data, error } = await sb.from('agents').select('*').eq('id', agentId).single();
                if (!error && data) {
                  session.systemPrompt = String(data.prompt || session.systemPrompt);
                  session.voiceId = data.voice_id || session.voiceId;
                  session.language = data.language || session.language;
                  session.endpointing = data.endpointing || session.endpointing;
                  // Add first_message from database for custom greetings
                  (session as any).firstMessage = data.first_message || null;
                  // Persist agentId for KB lookups
                  try { (session as any).agentId = agentId; } catch (e: unknown) {
                    console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
                  }
                }
              }
            } catch (e: unknown) {
              console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
            }
            // Create new conversation memory with optional first message
            const firstMessage = (session as any).firstMessage;
            conversationMemory.createConversation(s.sessionId, s.data.systemPrompt || '', firstMessage);
            // Reset intent analyzer for new session
            intentAnalyzer.resetSession();
          } else {
            const messageCount = conversationMemory.getMessageCount(s.sessionId);
            console.log('[agent] Updating existing session (JSON):', s.sessionId, 'preserving', messageCount, 'messages');
            // Update session properties but keep messages history
            session.turnId = s.turnId;
            session.systemPrompt = s.data.systemPrompt || session.systemPrompt;
            session.voiceId = s.data.voiceId ?? session.voiceId;
            session.vadEnabled = s.data.vadEnabled;
            session.pttMode = s.data.pttMode;
            session.endpointing = (s.data as any).endpointing || session.endpointing;
            // Apply agentId updates with cached data if provided
            try {
              const agentId = (s.data as any)?.agentId as string | undefined;
              const cachedAgentData = (s.data as any)?.cachedAgentData;
              
              if (cachedAgentData) {
                // Use cached data from client to avoid database query
                console.log('[agent] ⚡ Using cached agent data for session update - skipping database query!');
                session.systemPrompt = String(cachedAgentData.prompt || session.systemPrompt);
                session.voiceId = cachedAgentData.voice_id || session.voiceId;
                session.language = cachedAgentData.language || session.language;
                session.endpointing = cachedAgentData.endpointing || session.endpointing;
                (session as any).firstMessage = cachedAgentData.first_message || null;
                (session as any).agentId = agentId;
              } else if (agentId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
                // Fallback: load from database if no cached data provided
                console.log('[agent] Loading agent data from database for session update...');
                const { supabaseService } = require('../src/lib/supabaseServer');
                const sb = supabaseService();
                const { data, error } = await sb.from('agents').select('*').eq('id', agentId).single();
                if (!error && data) {
                  session.systemPrompt = String(data.prompt || session.systemPrompt);
                  session.voiceId = data.voice_id || session.voiceId;
                  session.language = data.language || session.language;
                  session.endpointing = data.endpointing || session.endpointing;
                  // Add first_message from database for custom greetings
                  (session as any).firstMessage = data.first_message || null;
                  try { (session as any).agentId = agentId; } catch (e: unknown) {
                    console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
                  }
                }
              }
            } catch (e: unknown) {
              console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
            }
            session.firstMessageMode = (s.data as any).firstMessageMode || session.firstMessageMode || 'assistant_speaks_first';
            session.language = (s.data as any).language || session.language || 'en';
          }
          // Apply provider selections from client, if present
          try { applyProviderSelections((s as any)?.data?.providers); } catch {}
          log('session.start', session);
          // emit a metrics.update to confirm (include providers)
          sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session.sessionId, turnId: session.turnId, data: { alive: true, providers: lastProviders } });
          // Proactively start Deepgram connection to avoid first-chunk race
          try {
            if (!deepgramManager.isConnected()) {
              createDeepgramConnection({ encoding: 'linear16', sampleRate: 16000, channels: 1 });
            }
          } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
          if (!greeted && session.firstMessageMode === 'assistant_speaks_first') {
            greeted = true;
            // Use database first_message if available, otherwise let system prompt handle greeting
            const firstMsg = (session as any).firstMessage;
            if (firstMsg) {
              // Add first message directly to conversation and send to TTS (skip LLM for predefined message)
              const sessionId = session.sessionId;
              if (sessionId) {
                conversationMemory.addAssistantMessage(sessionId, firstMsg);
              }
              // Send first message directly to TTS
              sendTtsDirectly(firstMsg);
            } else {
              // Let system prompt handle greeting naturally - use simple trigger
              processOpenAIAndTTS('Hello');
            }
          }
          return;
        }
        case 'audio.end': {
          AudioEndSchema.parse(msg);
          log('audio.end');
          try {
            if (useMulti && sttProvider) {
              try {
                console.log('[stt] audio.end -> closing provider to finalize transcription');
                await Promise.resolve(sttProvider.close());
              } catch (e) {
                console.warn('[stt] provider close error:', e instanceof Error ? e.message : String(e));
              }
            } else {
              deepgramManager.closeConnection();
            }
          } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
          return;
        }
        case 'barge.cancel': {
          BargeCancelSchema.parse(msg);
          log('barge.cancel');
          try { openaiAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
          try { ttsAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
          sendTtsEnd('barge');
          return;
        }
        case 'test.utterance': {
          if (!TEST_HOOKS) {
            return sendError(ws, session?.sessionId ?? 'unknown', session?.turnId ?? 'unknown', 'forbidden', 'test hooks disabled');
          }
          const t = TestUtteranceSchema.parse(msg);
          log('test.utterance', t.data.text);
          // Emit stt.final for UI
          sendJson(ws, { type: 'stt.final', ts: nowTs(), sessionId: t.sessionId, turnId: t.turnId, data: { text: t.data.text, startTs: nowTs() - 100, endTs: nowTs() } });

          // Stream OpenAI response tokens (deterministic for tests)
          if (session) {
            // Ensure conversation exists or create it
            let conversation = conversationMemory.getConversation(session.sessionId);
            if (!conversation) {
              conversation = conversationMemory.createConversation(session.sessionId, session.systemPrompt || 'You are InsureBot, an AI insurance assistant. Be helpful and conversational.');
            }
            conversationMemory.addUserMessage(session.sessionId, t.data.text);
          }
          openaiAbort = new AbortController();
          
          let full = '';
          try {
            console.log('[agent] Creating OpenAI stream (JSON handler)...');
            const messages = session ? conversationMemory.getMessages(session.sessionId) : [{ role: 'system', content: 'You are InsureBot, an AI insurance assistant. Be helpful and conversational.' }];
            const stream = await agentConfig.openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: messages as any,
              temperature: 0,
              stream: true,
            });

            console.log('[agent] OpenAI stream created (JSON handler), starting iteration...');
            let chunkCount = 0;
            for await (const chunk of stream as any) {
              chunkCount++;
              console.log('[agent] Received OpenAI chunk (JSON)', chunkCount, ':', JSON.stringify(chunk));
              const content = chunk?.choices?.[0]?.delta?.content ?? '';
              if (content) {
                console.log('[agent] Content chunk (JSON):', JSON.stringify(content));
                full += content;
                sendJson(ws, { type: 'llm.partial', ts: nowTs(), sessionId: t.sessionId, turnId: t.turnId, data: { text: content } });
              }
            }
            console.log('[agent] OpenAI streaming complete (JSON). Full response:', JSON.stringify(full));
            sendJson(ws, { type: 'llm.final', ts: nowTs(), sessionId: t.sessionId, turnId: t.turnId, data: { text: full } });
            try {
              if (session) {
                conversationMemory.addAssistantMessage(session.sessionId, full);
              }
            } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
          } catch (err) {
            console.error('[agent] OpenAI error (JSON):', err);
            throw err;
          }

          // Stream TTS with ElevenLabs if key and voice are available
          const { apiKey, voiceId } = getElevenLabsConfig(session?.voiceId);
          if (apiKey && voiceId) {
            if (STRICT_TURN_TAKING && userTalking) {
              console.log('[agent] Strict turn-taking: skipping TTS start because user is talking');
              return;
            }
            // Apply simple endpointing delays based on session settings
            const epRaw = (session as any)?.endpointing || {};
            const ep = {
              waitSeconds: Math.min(1, Math.max(0, Number((epRaw as any).waitSeconds ?? 0.15))),
              punctuationSeconds: Math.min(0.5, Math.max(0, Number((epRaw as any).punctuationSeconds ?? 0.1))),
              noPunctSeconds: Math.min(1, Math.max(0.3, Number((epRaw as any).noPunctSeconds ?? 0.4))),
              numberSeconds: Math.min(1, Math.max(0, Number((epRaw as any).numberSeconds ?? 0.2))),
            };
            let delayMs = Math.round((ep.waitSeconds || 0) * 1000);
            if (/[\.!?]$/.test(full)) delayMs += Math.round((ep.punctuationSeconds || 0) * 1000);
            if (!/[\.!?]$/.test(full)) delayMs += Math.round((ep.noPunctSeconds || 0) * 1000);
            if (/\d$/.test(full)) delayMs += Math.round((ep.numberSeconds || 0) * 1000);
            if (delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(delayMs, 2000)));
            ttsEnded = false;
            // Track TTS start for barge-in protection (test utterance JSON path)
            ttsStartTime = Date.now();
            currentTtsText = full;
            isTtsActive = true;
            console.log('[agent] Starting TTS protection (test utterance JSON) for:', full.slice(0, 100) + '...');
            
            const abort = new AbortController();
            ttsAbort = abort;
            let seq = 0;
            await streamElevenLabsTTS({
              apiKey,
              voiceId,
              text: full,
              optimizeStreamingLatency: 2,
              onChunk: (chunk) => {
                const header = { type: 'tts.chunk', ts: nowTs(), sessionId: t.sessionId, turnId: t.turnId, seq: seq++, mime: 'audio/mpeg' };
                ws.send(encodeBinaryFrame(header, chunk));
              },
              onEnd: (reason) => {
                sendTtsEnd(reason);
              },
              signal: abort.signal,
            });
          } else {
            sendTtsEnd('complete');
          }
          return;
        }
        case 'session.end': {
          // Handle user-initiated session termination
          try {
            const sessionId = session?.sessionId ?? 'unknown';
            const turnId = session?.turnId ?? 'unknown';
            
            console.log('[agent] Received session.end for session:', sessionId);
            
            // Stop any ongoing processes
            try {
              if (useMulti && sttProvider) {
                try {
                  console.log('[stt] session.end -> closing provider to finalize transcription');
                  await Promise.resolve(sttProvider.close());
                } catch (e) {
                  console.warn('[stt] provider close error on session.end:', e instanceof Error ? e.message : String(e));
                }
              }
              if (deepgramManager.isConnected()) {
                deepgramManager.closeConnection();
                console.log('[agent] Closed Deepgram connection for session end');
              }
            } catch (e: unknown) {
              console.error('[agent] Error closing Deepgram:', e instanceof Error ? e.message : String(e));
            }
            
            // Abort OpenAI request if running
            try {
              if (openaiAbort) {
                openaiAbort.abort();
                openaiAbort = null;
                console.log('[agent] Aborted OpenAI request for session end');
              }
            } catch (e: unknown) {
              console.error('[agent] Error aborting OpenAI:', e instanceof Error ? e.message : String(e));
            }
            
            // Clean up session from connection pool
            try {
              if (connectionId) {
                connectionPool.removeConnection(connectionId);
                console.log('[agent] Removed session from connection pool');
              }
            } catch (e: unknown) {
              console.error('[agent] Error cleaning connection pool:', e instanceof Error ? e.message : String(e));
            }
            
            // Remove from active sessions
            try {
              if (session?.sessionId) {
                activeSessionIds.delete(session.sessionId);
                console.log('[agent] Removed session from active sessions');
              }
            } catch (e: unknown) {
              console.error('[agent] Error removing from active sessions:', e instanceof Error ? e.message : String(e));
            }
            
            // Clear session reference  
            session = null;
            
            // Send confirmation of session termination
            sendJson(ws, {
              type: 'session.ended',
              ts: nowTs(),
              sessionId,
              turnId,
              data: { reason: 'user_disconnect' }
            });
            
            console.log('[agent] Session termination complete for:', sessionId);
            
          } catch (e: unknown) {
            console.error('[agent] Error during session.end handling:', e instanceof Error ? e.message : String(e));
          }
          return;
        }
        default:
          return sendError(ws, session?.sessionId ?? 'unknown', session?.turnId ?? 'unknown', 'unsupported', `Unknown type ${base.data.type}`);
      }
    } catch (err: unknown) {
      sendError(ws, session?.sessionId ?? 'unknown', session?.turnId ?? 'unknown', 'exception', (err instanceof Error ? err.message : 'unknown error'));
    }
  });

  // Connection pool handles heartbeat, but we still send periodic metrics
  const metricsInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { alive: true } });
    } else {
      clearInterval(metricsInterval);
    }
  }, 5000);

  ws.on('close', () => {
    clearInterval(metricsInterval);
    // Clear per-connection audio rate limiter refill interval to avoid leaks
    try { clearInterval(refillInterval); } catch {} // Cleanup operation - empty catch is intentional
    
    // Remove from connection pool
    if (connectionId) {
      connectionPool.removeConnection(connectionId);
    }
    // Abort any in-flight LLM/TTS operations
    try { openaiAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
    try { ttsAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
    // Ensure Deepgram connection is closed
    try { deepgramManager.closeConnection(); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
    // Clean up conversation memory for this session
    if (session) {
      // Note: We don't remove the conversation immediately as the user might reconnect
      // The memory manager will clean up expired conversations automatically
      const stats = conversationMemory.getStats();
      console.log(`[agent] Connection closed for session ${session.sessionId}. Total conversations: ${stats.totalConversations}, total messages: ${stats.totalMessages}`);
      try { activeSessionIds.delete(session.sessionId); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
    }
    log('connection closed');
  });
});

// Start the combined HTTP + WebSocket server
server.listen(PORT, () => {
  console.log(`[agent-server] Server started on port ${PORT}`);
  console.log(`[agent-server] WebSocket endpoint: ws://localhost:${PORT}/agent`);
  console.log(`[agent-server] Health check: http://localhost:${PORT}/healthz`);
  console.log(`[agent-server] Metrics: http://localhost:${PORT}/metrics`);
  console.log(`[agent-server] Flags: ENABLE_MULTI_PROVIDER=${ENABLE_MULTI_PROVIDER}, ENABLE_PROVIDER_ROUTER=${ENABLE_PROVIDER_ROUTER}`);
});
