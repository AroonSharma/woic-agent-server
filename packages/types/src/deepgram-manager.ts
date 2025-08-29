import { WebSocket } from 'ws';
import * as dns from 'dns';
import { getDeepgramConfig, STT_SILENCE_TIMEOUT_MS, LOG_LEVEL } from './agent-config';

const isDebug = LOG_LEVEL === 'debug';
const dbg = (...args: unknown[]) => { if (isDebug) { try { console.log(...args); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      } } };

// Configuration constants for backward compatibility
export const DEEPGRAM_UTTERANCE_END_MS = getDeepgramConfig().utteranceEndMs;
export const DEEPGRAM_ENDPOINTING_MS = getDeepgramConfig().endpointingMs;

export interface DeepgramConnectionOptions {
  encoding: 'linear16' | 'opus';
  sampleRate: number;
  channels: number;
}

export interface DeepgramCallbacks {
  onSttPartial: (transcript: string) => void;
  onSttFinal: (transcript: string) => void;
  onError: (error: any) => void;
}

export class DeepgramManager {
  private ws: WebSocket | null = null;
  private ready: boolean = false;
  private queue: Buffer[] = [];
  private connectionTimeout: NodeJS.Timeout | null = null;
  private stateLogInterval: NodeJS.Timeout | null = null;
  private sttSilenceTimer: NodeJS.Timeout | null = null;
  private callbacks: DeepgramCallbacks | null = null;
  private sessionContext: any = null;
  // De-duplication state for finals to avoid repeated turns
  private lastEmittedFinalNorm: string | null = null;
  private lastEmittedFinalAt: number = 0;

  constructor() {}

  private buildWebSocketUrl(opts: DeepgramConnectionOptions): string {
    // Override with optimized settings for low latency
    const rawUem = this.sessionContext?.endpointing?.noPunctSeconds 
      ? Math.round(this.sessionContext.endpointing.noPunctSeconds * 1000)
      : 800;  // default
    const utteranceEndMs = Math.max(1000, rawUem);
    
    const rawEp = this.sessionContext?.endpointing?.waitSeconds
      ? Math.round(this.sessionContext.endpointing.waitSeconds * 1000)
      : 300;  // default
    const endpointingMs = Math.max(300, rawEp);
    
    const params = new URLSearchParams({
      encoding: opts.encoding,
      sample_rate: String(opts.sampleRate),
      channels: String(opts.channels),
      punctuate: 'true',
      interim_results: 'true',
      utterance_end_ms: String(utteranceEndMs),
      endpointing: String(endpointingMs),
      language: (this.sessionContext?.language === 'hi' ? 'hi' : 'en-US'),
      model: process.env.DEEPGRAM_MODEL || 'nova-2',
      smart_format: 'true',
      numerals: 'true',
    });

    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }

  private setupDnsLookup(url: string): void {
    try {
      const { hostname } = new URL(url);
      dns.lookup(hostname, { all: true }, (err, addresses) => {
        if (err) {
          dbg('[deepgram] DNS lookup error for', hostname, err);
        } else {
          dbg('[deepgram] DNS lookup for', hostname, '→', addresses?.map((a: any) => `${a.address}/${a.family}`).join(', '));
        }
      });
    } catch (e) {
      console.error('[deepgram] CRITICAL: DNS lookup setup failed:', e);
    }
  }

  createConnection(
    opts: DeepgramConnectionOptions,
    callbacks: DeepgramCallbacks,
    sessionContext?: any
  ): void {
    if (this.ws) {
      console.log('[deepgram] Connection already exists, skipping creation');
      return;
    }

    this.callbacks = callbacks;
    this.sessionContext = sessionContext;

    dbg('[deepgram] Creating new Deepgram connection...');
    
    const { apiKey: key } = getDeepgramConfig();

    const url = this.buildWebSocketUrl(opts);
    dbg('[deepgram] Creating WebSocket with URL:', url);
    dbg('[deepgram] Using headers:', { Authorization: `Token ${key.slice(0, 10)}...` });
    
    this.setupDnsLookup(url);

    // Create WebSocket connection with enhanced debugging
    dbg('[deepgram] 🔧 Creating WebSocket connection...');
    dbg('[deepgram] 🔧 Full URL:', url);
    dbg('[deepgram] 🔧 Headers:', { Authorization: `Token ${key.slice(0,10)}...` });
    
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${key}` },
      perMessageDeflate: false,
      handshakeTimeout: 10000,
    });
    
    dbg('[deepgram] 🔧 WebSocket created, initial readyState:', this.ws.readyState);

    this.setupEventHandlers(opts);
    this.setupConnectionTimeout(opts);
  }

  private setupEventHandlers(opts: DeepgramConnectionOptions): void {
    if (!this.ws) return;

    // Periodic connection state logging
    dbg('[deepgram] 🔧 Setting up state logging interval...');
    this.stateLogInterval = setInterval(() => {
      try {
        const state = this.ws?.readyState;
        dbg('[deepgram] 📊 readyState check:', state, '(0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)');
        if (state === WebSocket.OPEN || state === WebSocket.CLOSED) {
          dbg('[deepgram] 📊 Final state reached, clearing interval');
          if (this.stateLogInterval) {
            clearInterval(this.stateLogInterval);
            this.stateLogInterval = null;
          }
        }
      } catch (e) {
        console.error('[deepgram] CRITICAL: State logging failed:', e);
      }
    }, 1000);

    this.ws.on('upgrade', (res: any) => {
      try {
        dbg('[deepgram] upgrade received. Status:', res?.statusCode, 'Headers:', res?.headers);
        if (res?.statusCode === 101) {
          // Treat successful upgrade as effectively open to avoid race conditions
          this.markReady();
        }
      } catch (e) {
        console.error('[deepgram] CRITICAL: Upgrade event handler failed:', e);
      }
    });

    this.ws.on('unexpected-response', (_req: any, res: any) => {
      try {
        dbg('[deepgram] unexpected-response. Status:', res?.statusCode, res?.statusMessage);
        dbg('[deepgram] Headers:', res?.headers);
        let body = '';
        res.on('data', (chunk: any) => { try { body += chunk.toString(); } catch (e) { console.error('[deepgram] Error processing response chunk:', e); } });
        res.on('end', () => {
          dbg('[deepgram] unexpected-response body (first 1k):', String(body).slice(0, 1024));
        });
      } catch (e) {
        console.log('[deepgram] Error handling unexpected-response:', e);
      }
    });

    this.ws.on('error', (e) => {
      console.error('[deepgram] 🚨 WebSocket ERROR:', e);
      console.error('[deepgram] 🚨 Error details:', {
        message: e.message,
        code: (e as any).code,
        type: (e as any).type,
        target: (e as any).target?.url
      });
      this.callbacks?.onError(e);
      this.cleanup();
    });

    this.ws.on('open', () => {
      dbg('[deepgram] ✅ WebSocket connection opened successfully! readyState:', this.ws?.readyState);
      this.clearConnectionTimeout();
      this.markReady();
      dbg('[deepgram] ✅ markReady() called, ready status:', this.ready);
      
      // Race condition safeguard
      setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.ready) {
          dbg('[deepgram] ⚠️ Race condition detected; enabling and flushing queue.');
          this.markReady();
        }
      }, 100);
    });

    this.ws.on('message', (data: any) => {
      if (isDebug) {
        try {
          console.log('[deepgram] 📨 RAW MESSAGE RECEIVED:', {
            type: typeof data,
            length: Buffer.isBuffer(data) ? data.length : (typeof data === 'string' ? data.length : 'unknown'),
            isBuffer: Buffer.isBuffer(data),
            first50chars: Buffer.isBuffer(data) ? data.toString().slice(0, 50) : String(data).slice(0, 50)
          });
        } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
      }
      this.handleMessage(data);
    });

    this.ws.on('close', (code, reason) => {
    console.error('[deepgram] 🔴 WebSocket CLOSED. Code:', code, 'Reason:', reason?.toString());
    dbg('[deepgram] 🔴 Close details:', { code, reason: reason?.toString(), readyState: this.ws?.readyState, wasReady: this.ready });
      this.cleanup();
      // Backoff + jitter reconnect strategy for transient closures
      try {
        if (this.callbacks) {
          let attempts = 0;
          const attemptReconnect = () => {
            const base = 300; // ms
            const delay = Math.min(5000, base * Math.pow(2, attempts)) + Math.floor(Math.random() * 200);
            attempts = Math.min(attempts + 1, 6);
            dbg('[deepgram] Reconnecting in', delay, 'ms');
            setTimeout(() => {
              try {
                // Simple provider fallback hook (scaffold): environment flag to skip reconnect
                if (process.env.DEEPGRAM_FALLBACK_DISABLED !== 'true') {
                  this.createConnection(opts, this.callbacks!, this.sessionContext);
                } else {
                  console.error('[deepgram] Fallback disabled by env, not reconnecting');
                }
              } catch (e) {
                dbg('[deepgram] Reconnect attempt failed:', e);
              }
            }, delay);
          };
          attemptReconnect();
        }
      } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
    });
  }

  private handleMessage(data: any): void {
    try {
      const messageStr = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      dbg('[deepgram] Received message:', messageStr.slice(0, 200));
      const msg = JSON.parse(messageStr);
      
      const alt = msg?.channel?.alternatives?.[0];
      const transcript: string = alt?.transcript ?? '';
      const isFinal: boolean = Boolean(msg?.is_final);
      const speechFinal: boolean = Boolean(msg?.speech_final);
      
      console.log('[deepgram] Parsed transcript:', JSON.stringify(transcript), 'isFinal:', isFinal, 'speechFinal:', speechFinal);
      
      // Enhanced logging for debugging accuracy issues
      if (msg?.channel?.alternatives?.[0]) {
        const alt = msg.channel.alternatives[0];
        dbg('[deepgram] Full alternative:', {
          transcript: alt.transcript,
          confidence: alt.confidence,
          words: alt.words?.map((w: any) => ({
            word: w.word,
            confidence: w.confidence,
            start: w.start,
            end: w.end
          })) || 'no words'
        });
      }
      
      if (!transcript) return;
      
      if (isFinal || speechFinal) {
        this.clearSttSilenceTimer();
        const norm = this.normalize(transcript);
        const now = Date.now();
        if (norm && this.lastEmittedFinalNorm === norm && now - this.lastEmittedFinalAt < 3000) {
          dbg('[deepgram] Suppressing duplicate STT final within 3s');
          return;
        }
        this.lastEmittedFinalNorm = norm;
        this.lastEmittedFinalAt = now;
        dbg('[deepgram] Sending STT final:', transcript);
        this.callbacks?.onSttFinal(transcript);
      } else {
        dbg('[deepgram] Sending STT partial:', transcript);
        this.callbacks?.onSttPartial(transcript);
        
        // Setup timeout to promote partial to final if needed
        this.setupSttSilenceTimer(transcript);
      }
    } catch (e) {
      console.log('[deepgram] Error processing message:', e);
    }
  }

  private setupSttSilenceTimer(transcript: string): void {
    this.clearSttSilenceTimer();
    
    // Use faster timeout for better responsiveness
    const ep = this.sessionContext?.endpointing || { noPunctSeconds: 1.2 };  // 1.2s default to reduce premature finals
    const delayMs = Math.round(((ep.noPunctSeconds ?? 1.2) as number) * 1000);
    
    this.sttSilenceTimer = setTimeout(() => {
      try {
        console.log('[deepgram] STT timeout: promoting partial to final after', delayMs, 'ms');
        const norm = this.normalize(transcript);
        const now = Date.now();
        if (norm && this.lastEmittedFinalNorm === norm && now - this.lastEmittedFinalAt < 3000) {
          dbg('[deepgram] Suppressing timeout-promoted duplicate final within 3s');
        } else {
          this.lastEmittedFinalNorm = norm;
          this.lastEmittedFinalAt = now;
          this.callbacks?.onSttFinal(transcript);
        }
      } finally {
        this.clearSttSilenceTimer();
      }
    }, Math.min(delayMs, 1500));  // Allow up to 1.5s before promoting
  }

  private normalize(text: string): string {
    return String(text).toLowerCase().replace(/[\s\.,!?]+/g, ' ').trim();
  }

  private clearSttSilenceTimer(): void {
    if (this.sttSilenceTimer) {
      clearTimeout(this.sttSilenceTimer);
      this.sttSilenceTimer = null;
    }
  }

  private setupConnectionTimeout(opts: DeepgramConnectionOptions): void {
    this.connectionTimeout = setTimeout(() => {
      console.error('[deepgram] 🚨 TIMEOUT: WebSocket failed to connect within 3 seconds');
      console.error('[deepgram] 🚨 WebSocket readyState:', this.ws?.readyState, '(0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)');
      console.error('[deepgram] 🚨 WebSocket URL:', this.ws?.url);
      console.error('[deepgram] 🚨 Queue size:', this.queue.length);
      
      if (this.ws && this.ws.readyState === 0) {
        console.error('[deepgram] 🔥 Terminating hanging WebSocket connection...');
        try { 
          this.ws.terminate(); 
        } catch (e) {
          console.error('[deepgram] CRITICAL: Failed to terminate WebSocket:', e);
        }
        
        this.cleanup();
        console.error('[deepgram] 💀 Clearing audio queue due to connection failure, lost', this.queue.length, 'chunks');
        
        // Report the failure to callbacks
        if (this.callbacks) {
          this.callbacks.onError(new Error('WebSocket connection timeout'));
        }
      }
    }, 10000); // Increased to 10 seconds
  }

  private markReady(): void {
    dbg('[deepgram] 🔧 markReady() called, current ready status:', this.ready);
    if (!this.ready) {
      this.clearConnectionTimeout();
      this.clearStateInterval();
      this.ready = true;
      dbg('[deepgram] ✅ Marked ready! Flushing', this.queue.length, 'queued chunks');
      
      // Send a test message to trigger a response for debugging
      try {
        if (this.ws && this.ws.readyState === 1) {
          dbg('[deepgram] 📤 Sending KeepAlive message to trigger response...');
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        } else {
          dbg('[deepgram] ⚠️ Cannot send KeepAlive, WebSocket state:', this.ws?.readyState);
        }
      } catch (e) {
        console.error('[deepgram] Failed to send KeepAlive:', e);
      }
      
      this.flushQueue();
    }
  }

  private flushQueue(): void {
    while (this.queue.length) {
      const chunk = this.queue.shift()!;
      try {
        if (this.ws) {
          this.ws.send(chunk);
          dbg('[deepgram] Sent queued chunk:', chunk.length, 'bytes');
        }
      } catch (e) {
        console.log('[deepgram] Failed to send queued chunk:', e);
        break;
      }
    }
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  private clearStateInterval(): void {
    if (this.stateLogInterval) {
      clearInterval(this.stateLogInterval);
      this.stateLogInterval = null;
    }
  }

  private cleanup(): void {
    this.ws = null;
    this.ready = false;
    this.queue.length = 0;
    this.clearConnectionTimeout();
    this.clearStateInterval();
    this.clearSttSilenceTimer();
  }

  sendAudio(payload: Buffer, codec: 'pcm16' | 'opus' = 'pcm16'): boolean {
    dbg('[deepgram] 🎵 Audio forwarding - ready:', this.ready, 'payload size:', payload.length, 'queue size:', this.queue.length);
    
    if (this.ready && this.ws) {
      try {
        // Debug: Check if payload contains actual audio data (not just silence)
        if (codec === 'pcm16') {
          const audioLevel = this.calculateAudioLevel(payload);
          dbg('[deepgram] 🎵 Audio level in payload (pcm16):', audioLevel.toFixed(4));
        } else {
          // Skip PCM RMS on non-PCM codecs
          dbg('[deepgram] 🎵 Forwarding non-PCM payload (', codec, ')');
        }
        
        this.ws.send(payload);
        dbg('[deepgram] ✅ Sent audio payload:', payload.length, 'bytes');
        return true;
      } catch (e) {
        console.log('[deepgram] Failed to send audio payload, queueing:', e);
        this.queueAudio(payload);
        return false;
      }
    } else {
      console.log('[deepgram] Not ready, queueing payload:', payload.length, 'bytes');
      this.queueAudio(payload);
      return false;
    }
  }
  
  private calculateAudioLevel(buffer: Buffer): number {
    // Convert buffer to 16-bit PCM samples and calculate RMS
    let sum = 0;
    const samples = buffer.length / 2; // 16-bit = 2 bytes per sample
    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i) / 32768; // Normalize to -1 to 1
      sum += sample * sample;
    }
    return Math.sqrt(sum / samples);
  }

  private queueAudio(payload: Buffer): void {
    // Limit queue size
    if (this.queue.length < 100) {
      this.queue.push(payload);
    } else {
      console.log('[deepgram] Queue full, dropping oldest audio chunk');
      this.queue.shift();
      this.queue.push(payload);
    }

    // Auto-reconnect if queue is getting large
    if (this.queue.length > 50 && !this.ws && this.callbacks) {
      console.log('[deepgram] Large queue detected, attempting reconnection...');
      try {
        this.createConnection(
          { encoding: 'linear16', sampleRate: 16000, channels: 1 },
          this.callbacks,
          this.sessionContext
        );
      } catch (e) {
        console.log('[deepgram] Auto-reconnection failed:', e);
      }
    }
  }

  closeConnection(): void {
    try {
      if (this.ws) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        this.ws.close();
      }
    } catch (e) {
      console.error('[deepgram] CRITICAL: Failed to close WebSocket properly:', e);
    }
    this.cleanup();
  }

  isReady(): boolean {
    return this.ready;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getQueueSize(): number {
    return this.queue.length;
  }
}