// @ts-nocheck
// Disable TypeScript checks temporarily for deployment
import { config } from 'dotenv';
import * as path from 'path';

// Load local .env first (for agent-server specific config)
config({ path: path.join(__dirname, '..', '.env') });
// Fall back to repository root .env if needed
config({ path: path.join(__dirname, '..', '..', '.env') });
import { WebSocket, WebSocketServer } from 'ws';
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
} from './agent-config';
import { z } from 'zod';
import { 
  SessionStart,
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
} from './types';
import { streamElevenLabsTTS } from './elevenlabs';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
// axios import removed (unused)
import * as http from 'http';

// Enforce session JWT presence in production
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.error('[config] SESSION_JWT_SECRET is required in production');
  process.exit(1);
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

// Create HTTP server that handles both HTTP and WebSocket requests
const server = http.createServer((req, res) => {
  if (!req.url) { res.statusCode = 400; return res.end('Bad Request'); }
  
  if (req.url === '/healthz') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
  }
  
  if (req.url === '/metrics') {
    const body = {
      activeCalls: metrics.activeCalls,
      retainedConversations: metrics.retainedConversations, 
      totalMessages: metrics.totalMessages,
      totalTurns,
      lastLlmFirstTokenMs,
      lastTtsFirstAudioMs,
      lastTurnElapsedMs,
      ts: Date.now(),
    };
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(body));
  }
  
  // Default response for other paths
  res.statusCode = 404; 
  res.end('Not Found');
});

// Track active sessionIds for live call count
const activeSessionIds = new Set<string>();
// Global turn metrics (simple, in-memory)
let totalTurns = 0;
let lastLlmFirstTokenMs = -1;
let lastTtsFirstAudioMs = -1;
let lastTurnElapsedMs = -1;

// Metrics object
const metrics = {
  get activeCalls() { return activeSessionIds.size; },
  get retainedConversations() {
    const total = conversationMemory.getStats().totalConversations;
    const active = activeSessionIds.size;
    return Math.max(0, total - active);
  },
  get totalMessages() { return conversationMemory.getStats().totalMessages; },
};

const wss = new WebSocketServer({ server, path: '/agent' });
// Allowed origins for WebSocket connections (comma-separated)
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || 'http://localhost:3010,http://localhost:3000,http://localhost:5173,http://localhost:5175,http://localhost:5176,https://woic.app,https://woic.realmonkey.ai')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

wss.on('connection', (ws, req) => {
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
        const parsed = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
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
  const deepgramManager = new DeepgramManager();
  const intentAnalyzer = new IntentAnalyzer();
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
  // Greeting/dup/turn guards
  let greeted = false;
  let lastSttFinalText: string = '';
  let lastSttFinalAt: number = 0;
  let processingTurn = false;
  // Feature flag to control early TTS behavior (disabled by default to avoid 1-2 word issue)
  const EARLY_TTS_ENABLED = String(process.env.EARLY_TTS_ENABLED || 'false') === 'true';

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
      sendJson(ws, {
        type: 'stt.partial',
        ts: nowTs(),
        sessionId: session?.sessionId ?? 'unknown',
        turnId: session?.turnId ?? 'unknown',
        data: { text: transcript },
      });

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
          if (isTtsActive && transcript && transcript.trim().length > 0) {
            const ttsElapsedMs = Date.now() - ttsStartTime;
            const words = transcript.trim().split(/\s+/).filter(Boolean).length;
            if (ttsElapsedMs >= TTS_MIN_DURATION_MS && words >= Math.max(2, TTS_BARGE_THRESHOLD_WORDS - 1)) {
              if (shouldAllowBargein(transcript)) {
                console.log('[agent] Barge-in on partial: cancelling current TTS (elapsed=', ttsElapsedMs, 'ms, words=', words, ')');
                try { openaiAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
                try { ttsAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
                sendTtsEnd('barge');
              }
            }
          }
        } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
      }
    },
    
    onSttFinal: (transcript: string) => {
      if (LOG_LEVEL === 'debug') console.log('[agent] Sending STT final:', transcript);
      
      // Reinstate barge-in protection to avoid cutting TTS too early
      if (!shouldAllowBargein(transcript)) {
        console.log('[agent] Barge-in rejected; ignoring STT final during active TTS');
        return; // Protect ongoing TTS
      }
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
      if (processingTurn) {
        console.log('[agent] Turn in progress; aborting current LLM/TTS before processing new final');
        try { openaiAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
        try { ttsAbort?.abort(); } catch {} // Cleanup operation - empty catch is intentional
        isTtsActive = false;
        processingTurn = false;
      }
      console.log('[agent] Processing STT final:', transcript);
      
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
      
      processOpenAIAndTTS(transcript, intentResult);
    },
    
    onError: (error: any) => {
      console.log('[agent] Deepgram error:', error);
      sendError(ws, session?.sessionId ?? 'unknown', session?.turnId ?? 'unknown', 'deepgram_error', error.message || 'Deepgram connection error');
    }
  };

  function createDeepgramConnection(opts: { encoding: 'linear16' | 'opus'; sampleRate: number; channels: number }) {
    if (deepgramManager.isConnected()) return;
    deepgramManager.createConnection(opts, deepgramCallbacks, session);
  }

  async function processOpenAIAndTTS(transcript: string, intentResult?: IntentResult) {
    openaiAbort = new AbortController();
    let full = '';
    const turnStartTs = Date.now();
    connTurnStartTs = turnStartTs;
    let llmFirstTokenMs = -1;
    let ttsFirstAudioMs = -1;
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
        try {
          const useKb = String(process.env.KB_ENABLED || 'true') === 'true';
          const hasAgent = Boolean(session?.agentId);
          if (useKb && hasAgent && session && transcript && transcript !== '<__START__>') {
            const { groundedAnswer } = require('../src/lib/grounded');
            const result = await groundedAnswer(transcript, session.agentId) as GroundedAnswerResult;
            if (result && Array.isArray(result.sources)) {
              if (result.sources.length > 0 && result.text) {
                kbPreface = result.text; // grounded
              } else {
                // No direct KB answer found - try to get context for LLM enhancement
                try {
                  const { retrieve } = require('../src/lib/retrieve');
                  const chunks = await retrieve(transcript, session.agentId, 3) as KBChunk[];
                  if (chunks && chunks.length > 0 && chunks[0]?.content) {
                    const topChunks = chunks.slice(0, 2).map((chunk, i) => 
                      `Expertise Area ${i + 1}: ${chunk.content.substring(0, 300)}`
                    ).join('\n\n');
                    kbContextForLLM = `Your Personal Knowledge & Experience:\n${topChunks}`;
                    if (LOG_LEVEL === 'debug') console.log('[agent] Added personalized KB context for LLM enhancement');
                  }
                } catch (retrieveErr) {
                  if (LOG_LEVEL === 'debug') console.log('[agent] KB context retrieval failed:', String((retrieveErr as any)?.message));
                }
                if (LOG_LEVEL === 'debug') console.log('[agent] No high-confidence KB answer, allowing LLM fallback with context');
              }
            }
          }
        } catch (e) {
          console.log('[agent] KB grounding skipped/failed:', String((e as any)?.message || e));
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
              waitSeconds: Math.min(2, Math.max(0, Number((epRaw as any).waitSeconds ?? 0.4))),
              punctuationSeconds: Math.min(1, Math.max(0, Number((epRaw as any).punctuationSeconds ?? 0.1))),
              noPunctSeconds: Math.min(3, Math.max(0.3, Number((epRaw as any).noPunctSeconds ?? 1.5))),
              numberSeconds: Math.min(2, Math.max(0, Number((epRaw as any).numberSeconds ?? 0.5))),
            };
            let delayMs = Math.round((ep.waitSeconds || 0) * 1000);
            if (/[\.!?]$/.test(full)) delayMs += Math.round((ep.punctuationSeconds || 0) * 1000);
            if (!/[\.!?]$/.test(full)) delayMs += Math.round((ep.noPunctSeconds || 0) * 1000);
            if (/\d$/.test(full)) delayMs += Math.round((ep.numberSeconds || 0) * 1000);
            if (delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(delayMs, 2000)));
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
      // If this is the first-turn greeting trigger, seed a short greeting prompt with wait instruction
      if (transcript === '<__START__>') {
        const greet = session?.language === 'hi'
          ? 'कृपया बहुत संक्षिप्त अभिवादन करें और प्रश्न पूछ कर रुकें — यूज़र को जवाब देने के लिए पर्याप्त समय दें; तुरंत दोहराएँ नहीं।'
          : 'Give a very brief greeting, ask one concise question, and then pause — give the user time to answer; do not repeat immediately.';
        messages = [...messages, { role: 'user', content: greet } as ChatMessage];
      }
        
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
        async function createOpenAIStreamWithRetry(): Promise<any> {
          let attempt = 0;
          for (;;) {
            try {
              return await agentConfig.openai.chat.completions.create({
                model: 'gpt-4o-mini',
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
        
        for await (const chunk of stream as any) {
          const content = chunk?.choices?.[0]?.delta?.content ?? '';
          if (content) {
            full += content;
            sendJson(ws, { type: 'llm.partial', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { text: content } });
            if (llmFirstTokenMs < 0) { llmFirstTokenMs = Date.now() - turnStartTs; connLlmFirstTokenMs = llmFirstTokenMs; logMetrics('llm.first'); sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { llmFirstTokenMs } }); }
            
            // Start TTS early when we have enough content for natural speech
            if (EARLY_TTS_ENABLED && !ttsStarted && elevenApiKey && elevenVoiceId && shouldStartEarlyTTS(full)) {
              ttsStarted = true;
              if (LOG_LEVEL === 'debug') console.log('[agent] Starting early TTS with partial content:', full.slice(0, 50) + '...');
              startEarlyTTS(full, elevenApiKey, elevenVoiceId);
            }
          }
        }
        
        if (LOG_LEVEL === 'debug') console.log('[agent] OpenAI streaming complete. Full response:', full);
        sendJson(ws, { type: 'llm.final', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { text: full } });
        
        try {
          if (session) {
            conversationMemory.addAssistantMessage(session.sessionId, full);
          }
        } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }

        // Stream TTS with ElevenLabs if not already started (preferred: speak full response)
        const { apiKey: finalApiKey, voiceId: finalVoiceId } = getElevenLabsConfig(session?.voiceId);
        if (!ttsStarted && finalApiKey && finalVoiceId) {
          // Simple endpointing delays based on session settings
          const epRaw = (session as any)?.endpointing || {};
          const ep = {
            waitSeconds: Math.min(2, Math.max(0, Number((epRaw as any).waitSeconds ?? 0.4))),
            punctuationSeconds: Math.min(1, Math.max(0, Number((epRaw as any).punctuationSeconds ?? 0.1))),
            noPunctSeconds: Math.min(3, Math.max(0.3, Number((epRaw as any).noPunctSeconds ?? 1.5))),
            numberSeconds: Math.min(2, Math.max(0, Number((epRaw as any).numberSeconds ?? 0.5))),
          };
          let delayMs = Math.round((ep.waitSeconds || 0) * 1000);
          if (/[\.!?]$/.test(full)) delayMs += Math.round((ep.punctuationSeconds || 0) * 1000);
          if (!/[\.!?]$/.test(full)) delayMs += Math.round((ep.noPunctSeconds || 0) * 1000);
          if (/\d$/.test(full)) delayMs += Math.round((ep.numberSeconds || 0) * 1000);
          if (delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(delayMs, 2000)));
          
          ttsEnded = false;
          ttsStartTime = Date.now();
          currentTtsText = full;
          isTtsActive = true;
          if (LOG_LEVEL === 'debug') console.log('[agent] Starting TTS protection for:', full.slice(0, 100) + '...');
          
          const abort = new AbortController();
          ttsAbort = abort;
          let seq = 0;
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
    const ttsElapsed = Date.now() - ttsStartTime;
    console.log('[agent] TTS ended:', reason, 'after', ttsElapsed, 'ms');
    try {
      // Update global turn metrics and notify client
      lastLlmFirstTokenMs = connLlmFirstTokenMs;
      lastTtsFirstAudioMs = connTtsFirstAudioMs;
      lastTurnElapsedMs = Math.max(0, Date.now() - (connTurnStartTs || Date.now()));
      totalTurns += 1;
      sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session?.sessionId ?? 'unknown', turnId: session?.turnId ?? 'unknown', data: { e2eMs: lastTurnElapsedMs, llmFirstTokenMs: lastLlmFirstTokenMs, ttsFirstAudioMs: lastTtsFirstAudioMs } });
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
              systemPrompt: s.data.systemPrompt || process.env.SYSTEM_PROMPT || 'You are InsureBot, an AI insurance assistant. Be helpful and conversational.',
                voiceId: s.data.voiceId ?? null,
                vadEnabled: s.data.vadEnabled,
                pttMode: s.data.pttMode,
                firstMessageMode: (s.data as any).firstMessageMode || 'assistant_speaks_first',
                language: (s.data as any).language || 'en',
                endpointing: (s.data as any).endpointing,
              };
            // Create new conversation memory
            conversationMemory.createConversation(s.sessionId, session.systemPrompt);
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
              session.systemPrompt = newSystemPrompt || process.env.SYSTEM_PROMPT || session.systemPrompt;
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
              processOpenAIAndTTS('<__START__>');
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
              // Apply simple endpointing delays based on session settings
              const ep = (session as any)?.endpointing || { waitSeconds: 0.4, punctuationSeconds: 0.1, noPunctSeconds: 1.5, numberSeconds: 0.5 };
              let delayMs = Math.round((ep.waitSeconds || 0) * 1000);
              if (/[\\.!?]$/.test(full)) delayMs += Math.round((ep.punctuationSeconds || 0) * 1000);
              if (!/[\\.!?]$/.test(full)) delayMs += Math.round((ep.noPunctSeconds || 0) * 1000);
              if (/\\d$/.test(full)) delayMs += Math.round((ep.numberSeconds || 0) * 1000);
              if (delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(delayMs, 2000)));
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
          // TARGETED FIX: Use correct destructuring to match decodeBinaryFrame return type
          // decodeBinaryFrame returns { type, data } not { header, payload }
          const decoded = decodeBinaryFrame(raw);
          if (!decoded) {
            console.log('[agent] Failed to decode binary frame - invalid format');
            return;
          }
          const { type: header, data: payload } = decoded;
          console.log('[agent] Decoded header:', JSON.stringify(header));
          const parsed = AudioChunkHeaderSchema.safeParse(header);
          if (!parsed.success) {
            console.log('[agent] Header validation failed:', parsed.error);
            return; // ignore unknown binary
          }
          console.log('[agent] Header validation SUCCESS, processing audio chunk seq:', parsed.data.seq);
        log('audio.chunk', parsed.data.seq);
          // Token-bucket rate limiting per connection for audio frames
          if (framesBudget <= 0) {
            console.log('[agent] Rate limit exceeded for audio frames; dropping frame seq:', parsed.data.seq);
            return; // Drop silently to prevent overload
          }
          framesBudget -= 1;
        // Phase C: route to Deepgram streaming STT
        console.log('[agent] Starting Deepgram processing for chunk', parsed.data.seq);
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
          deepgramManager.sendAudio(payload, parsed.data.codec);
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
            // If agentId provided, load agent config from Supabase
            try {
              const agentId = (s.data as any)?.agentId as string | undefined;
              if (agentId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
                const { supabaseService } = require('../src/lib/supabaseServer');
                const sb = supabaseService();
                const { data, error } = await sb.from('agents').select('*').eq('id', agentId).single();
                if (!error && data) {
                  session.systemPrompt = String(data.prompt || session.systemPrompt);
                  session.voiceId = data.voice_id || session.voiceId;
                  session.language = data.language || session.language;
                  session.endpointing = data.endpointing || session.endpointing;
                  // Persist agentId for KB lookups
                  try { (session as any).agentId = agentId; } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
                }
              }
            } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
            // Create new conversation memory
            conversationMemory.createConversation(s.sessionId, s.data.systemPrompt || '');
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
            // Apply agentId updates if provided
            try {
              const agentId = (s.data as any)?.agentId as string | undefined;
              if (agentId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
                const { supabaseService } = require('../src/lib/supabaseServer');
                const sb = supabaseService();
                const { data, error } = await sb.from('agents').select('*').eq('id', agentId).single();
                if (!error && data) {
                  session.systemPrompt = String(data.prompt || session.systemPrompt);
                  session.voiceId = data.voice_id || session.voiceId;
                  session.language = data.language || session.language;
                  session.endpointing = data.endpointing || session.endpointing;
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
          log('session.start', session);
          // emit a metrics.update to confirm
          sendJson(ws, { type: 'metrics.update', ts: nowTs(), sessionId: session.sessionId, turnId: session.turnId, data: { alive: true } });
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
            processOpenAIAndTTS('<__START__>');
          }
          return;
        }
        case 'audio.end': {
          AudioEndSchema.parse(msg);
          log('audio.end');
          try {
            deepgramManager.closeConnection();
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
            // Apply simple endpointing delays based on session settings
            const epRaw = (session as any)?.endpointing || {};
            const ep = {
              waitSeconds: Math.min(2, Math.max(0, Number((epRaw as any).waitSeconds ?? 0.4))),
              punctuationSeconds: Math.min(1, Math.max(0, Number((epRaw as any).punctuationSeconds ?? 0.1))),
              noPunctSeconds: Math.min(3, Math.max(0.3, Number((epRaw as any).noPunctSeconds ?? 1.5))),
              numberSeconds: Math.min(2, Math.max(0, Number((epRaw as any).numberSeconds ?? 0.5))),
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

// Start the server on the configured PORT - bind to all interfaces for Railway
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';
server.listen(PORT, host, () => {
  console.log(`[agent-server] HTTP & WebSocket server listening on ${host}:${PORT}`);
  console.log(`[agent-server] WebSocket endpoint: ws://${host}:${PORT}/agent`);
  console.log(`[agent-server] Health check: http://${host}:${PORT}/healthz`);
  console.log(`[agent-server] Metrics: http://${host}:${PORT}/metrics`);
  console.log(`[agent-server] Environment: NODE_ENV=${process.env.NODE_ENV}`);
});
