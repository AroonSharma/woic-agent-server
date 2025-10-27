import OpenAI from 'openai';

// ===== AGENT SERVER CONFIGURATION =====

export interface AgentServerConfig {
  port: number;
  logLevel: string;
  testHooksEnabled: boolean;
}

export interface STTConfig {
  silenceTimeoutMs: number;
  utteranceEndMs: number;
  endpointingMs: number;
}

export interface TTSConfig {
  minDurationMs: number;
  bargeThresholdWords: number;
  protectedPhrasesEnabled: boolean;
  sentenceBoundaryProtection: boolean;
  clauseProtectionMs: number;
  criticalInfoProtection: boolean;
}

export interface APIKeysConfig {
  deepgramApiKey: string;
  openaiApiKey: string;
  elevenlabsApiKey: string;
  defaultVoiceId: string;
}

export interface AgentConfig {
  server: AgentServerConfig;
  stt: STTConfig;
  tts: TTSConfig;
  apiKeys: APIKeysConfig;
  openai: OpenAI;
}

// ===== CONFIGURATION LOADING =====

function loadServerConfig(): AgentServerConfig {
  return {
    port: Number(process.env.PORT || process.env.AGENT_WS_PORT || 4010),
    logLevel: process.env.LOG_LEVEL || 'info',
    testHooksEnabled: String(process.env.TEST_HOOKS_ENABLED || 'false') === 'true'
  };
}

function loadSTTConfig(): STTConfig {
  return {
    silenceTimeoutMs: Number(process.env.STT_SILENCE_TIMEOUT_MS || 2500),  // Increased to 2.5s to allow complete sentences
    utteranceEndMs: Number(process.env.DEEPGRAM_UTTERANCE_END_MS || 1200), // Increased for better sentence boundary detection
    endpointingMs: Number(process.env.DEEPGRAM_ENDPOINTING_MS || 800)      // More conservative to prevent premature cuts
  };
}

function loadTTSConfig(): TTSConfig {
  return {
    minDurationMs: Number(process.env.TTS_MIN_DURATION_MS || 1000),       // Reduced from 3000ms
    bargeThresholdWords: Number(process.env.TTS_BARGE_THRESHOLD_WORDS || 2), // Lower threshold for snappier barge-in
    protectedPhrasesEnabled: String(process.env.TTS_PROTECTED_PHRASES || 'true') === 'true',
    sentenceBoundaryProtection: String(process.env.TTS_SENTENCE_BOUNDARY_PROTECTION || 'true') === 'true',
    clauseProtectionMs: Number(process.env.TTS_CLAUSE_PROTECTION_MS || 800), // Reduced from 1500ms
    criticalInfoProtection: String(process.env.TTS_CRITICAL_INFO_PROTECTION || 'true') === 'true'
  };
}

function loadAPIKeysConfig(): APIKeysConfig {
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  console.log('[agent-config] DEEPGRAM_API_KEY loaded:', deepgramApiKey ? `${deepgramApiKey.slice(0, 10)}...` : 'MISSING');
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const elevenlabsApiKey = process.env.ELEVENLABS_API_KEY;
  const defaultVoiceId = process.env.VOICE_ID;

  if (!deepgramApiKey) {
    throw new Error('DEEPGRAM_API_KEY environment variable is required');
  }
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }
  if (!elevenlabsApiKey) {
    throw new Error('ELEVENLABS_API_KEY environment variable is required');
  }
  if (!defaultVoiceId) {
    throw new Error('VOICE_ID environment variable is required');
  }
  
  // Debug log to check API key format
  console.log('[config] OpenAI API key format check:', {
    length: openaiApiKey.length,
    prefix: openaiApiKey.substring(0, 10),
    hasBearer: openaiApiKey.includes('Bearer'),
    startsWithSk: openaiApiKey.startsWith('sk-')
  });

  return {
    deepgramApiKey,
    openaiApiKey,
    elevenlabsApiKey,
    defaultVoiceId
  };
}

function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

// ===== CONFIGURATION VALIDATION =====

function validateConfig(config: AgentConfig): void {
  // Server validation
  if (config.server.port < 1 || config.server.port > 65535) {
    throw new Error(`Invalid server port: ${config.server.port}. Must be between 1 and 65535.`);
  }

  // API key presence validation per AMP analysis
  if (!config.apiKeys.deepgramApiKey || config.apiKeys.deepgramApiKey.length < 20) {
    throw new Error('DEEPGRAM_API_KEY is missing or invalid');
  }
  if (!config.apiKeys.openaiApiKey || !config.apiKeys.openaiApiKey.startsWith('sk-')) {
    throw new Error('OPENAI_API_KEY is missing or invalid format');
  }
  if (!config.apiKeys.elevenlabsApiKey || config.apiKeys.elevenlabsApiKey.length < 20) {
    throw new Error('ELEVENLABS_API_KEY is missing or invalid');
  }

  // STT validation
  if (config.stt.silenceTimeoutMs < 500 || config.stt.silenceTimeoutMs > 10000) {
    throw new Error(`Invalid STT silence timeout: ${config.stt.silenceTimeoutMs}ms. Must be between 500ms and 10s.`);
  }

  if (config.stt.utteranceEndMs < 500 || config.stt.utteranceEndMs > 5000) {
    throw new Error(`Invalid STT utterance end timeout: ${config.stt.utteranceEndMs}ms. Must be between 500ms and 5s.`);
  }

  // TTS validation
  if (config.tts.minDurationMs < 1000 || config.tts.minDurationMs > 10000) {
    throw new Error(`Invalid TTS min duration: ${config.tts.minDurationMs}ms. Must be between 1s and 10s.`);
  }

  if (config.tts.bargeThresholdWords < 1 || config.tts.bargeThresholdWords > 20) {
    throw new Error(`Invalid TTS barge threshold: ${config.tts.bargeThresholdWords} words. Must be between 1 and 20.`);
  }

  // API keys validation (basic format check)
  if (!config.apiKeys.deepgramApiKey.match(/^[a-f0-9]{40}$/)) {
    console.warn('Warning: DEEPGRAM_API_KEY format may be invalid (expected 40 hex characters)');
  }

  if (!config.apiKeys.openaiApiKey.startsWith('sk-')) {
    console.warn('Warning: OPENAI_API_KEY format may be invalid (expected to start with "sk-")');
  }

  if (!config.apiKeys.elevenlabsApiKey.startsWith('sk_')) {
    console.warn('Warning: ELEVENLABS_API_KEY format may be invalid (expected to start with "sk_")');
  }
}

// ===== MAIN CONFIGURATION LOADER =====

function loadAgentConfig(): AgentConfig {
  try {
    const server = loadServerConfig();
    const stt = loadSTTConfig();
    const tts = loadTTSConfig();
    const apiKeys = loadAPIKeysConfig();
    const openai = createOpenAIClient(apiKeys.openaiApiKey);

    const config: AgentConfig = {
      server,
      stt,
      tts,
      apiKeys,
      openai
    };

    validateConfig(config);

    console.log('[config] Agent configuration loaded successfully');
    console.log('[config] Server port:', config.server.port);
    console.log('[config] STT silence timeout:', config.stt.silenceTimeoutMs + 'ms');
    console.log('[config] TTS min duration:', config.tts.minDurationMs + 'ms');
    console.log('[config] TTS barge threshold:', config.tts.bargeThresholdWords, 'words');
    console.log('[config] Protected phrases enabled:', config.tts.protectedPhrasesEnabled);

    return config;
  } catch (error) {
    const msg = (error instanceof Error) ? error.message : String(error);
    console.error('[config] Failed to load agent configuration:', msg);
    throw error;
  }
}

// ===== EXPORT SINGLETON =====

export const agentConfig = loadAgentConfig();

// ===== UTILITY FUNCTIONS =====

export function getElevenLabsConfig(sessionVoiceId?: string | null) {
  return {
    apiKey: agentConfig.apiKeys.elevenlabsApiKey,
    voiceId: sessionVoiceId || agentConfig.apiKeys.defaultVoiceId
  };
}

export function getDeepgramConfig() {
  return {
    apiKey: agentConfig.apiKeys.deepgramApiKey,
    utteranceEndMs: agentConfig.stt.utteranceEndMs,
    endpointingMs: agentConfig.stt.endpointingMs
  };
}

// ===== CONFIGURATION CONSTANTS FOR BACKWARD COMPATIBILITY =====

export const PORT = agentConfig.server.port;
export const LOG_LEVEL = agentConfig.server.logLevel;
export const TEST_HOOKS = agentConfig.server.testHooksEnabled;

export const STT_SILENCE_TIMEOUT_MS = agentConfig.stt.silenceTimeoutMs;
export const DEEPGRAM_UTTERANCE_END_MS = agentConfig.stt.utteranceEndMs;
export const DEEPGRAM_ENDPOINTING_MS = agentConfig.stt.endpointingMs;

export const TTS_MIN_DURATION_MS = agentConfig.tts.minDurationMs;
export const TTS_BARGE_THRESHOLD_WORDS = agentConfig.tts.bargeThresholdWords;
export const TTS_PROTECTED_PHRASES = agentConfig.tts.protectedPhrasesEnabled;
export const TTS_SENTENCE_BOUNDARY_PROTECTION = agentConfig.tts.sentenceBoundaryProtection;
export const TTS_CLAUSE_PROTECTION_MS = agentConfig.tts.clauseProtectionMs;
export const TTS_CRITICAL_INFO_PROTECTION = agentConfig.tts.criticalInfoProtection;

// ===== SAFETY / RATE LIMITING CONSTANTS =====
// Max allowed inbound binary frame size (bytes) from client (audio frames)
export const MAX_FRAME_BYTES = Number(process.env.MAX_FRAME_BYTES || 262144); // 256KB
// Max allowed inbound JSON message size (bytes) when sent as binary
export const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 65536); // 64KB
// Per-session max audio frames per second (token-bucket capacity and refill rate)
export const MAX_AUDIO_FRAMES_PER_SEC = Number(process.env.MAX_AUDIO_FRAMES_PER_SEC || 100);

// ===== PHASE 1 FEATURE FLAGS (No behavior change yet) =====
export const ENABLE_MULTI_PROVIDER = String(process.env.ENABLE_MULTI_PROVIDER || 'false') === 'true';
export const MULTI_PROVIDER_ROLLOUT_PERCENTAGE = Number(process.env.MULTI_PROVIDER_ROLLOUT_PERCENTAGE || 0);
export const API_KEY_ENCRYPTION_KEY = process.env.API_KEY_ENCRYPTION_KEY;
// ===== PHASE 2 FEATURE FLAGS =====
export const ENABLE_PROVIDER_ROUTER = String(process.env.ENABLE_PROVIDER_ROUTER || 'false') === 'true';
