// @ts-nocheck
export type AgentEvents = {
  onOpen?: () => void;
  onClose?: () => void;
  onSttPartial?: (text: string) => void;
  onSttFinal?: (text: string) => void;
  onLlmPartial?: (text: string) => void;
  onLlmFinal?: (text: string) => void;
  onTtsEnd?: (reason: string) => void;
  onError?: (msg: string) => void;
};
import { emitTtsChunk, emitTtsComplete } from './ttsBus';
import { AGENT_WS_URL } from '@/config/agent';

export type EndpointingConfig = {
  waitSeconds: number;
  punctuationSeconds: number;
  noPunctSeconds: number;
  numberSeconds: number;
  smartEndpointing: boolean;
};

export type AgentConnection = {
  ws: WebSocket;
  updateEndpointing: (newEp: EndpointingConfig) => void;
  testUtterance: (text: string) => void;
  close: () => void;
};

export function connectAgent(params: {
  sessionId: string;
  turnId: string;
  systemPrompt: string;
  voiceId: string | null;
  language?: 'en' | 'hi';
  endpointing?: EndpointingConfig;
  getToken?: (sessionId: string) => Promise<string | null>;
  events: AgentEvents;
}) {
  const { sessionId, turnId, systemPrompt, voiceId, endpointing, language = 'en', getToken, events } = params;
  // Use config-based URL
  const url = AGENT_WS_URL;
  console.log('[agentSocket] Connecting to WebSocket:', url);

  let currentWs: WebSocket;
  let reconnectAttempts = 0;
  let shouldReconnect = true;

  const startSession = (sock: WebSocket) => {
    sock.send(
      JSON.stringify({
        type: 'session.start',
        ts: Date.now(),
        sessionId,
        turnId,
        data: { systemPrompt, voiceId, vadEnabled: true, pttMode: false, endpointing, firstMessageMode: 'user_speaks_first', language },
      })
    );
  };

  const setupSocket = () => {
    const ws = new WebSocket(url);
    // @ts-ignore
    (ws as any).binaryType = 'arraybuffer';
    currentWs = ws;

    ws.addEventListener('open', async () => {
      console.log('[agentSocket] WebSocket connected');
      reconnectAttempts = 0;
      events.onOpen?.();
      let token: string | null = null;
      try {
        if (typeof getToken === 'function') {
          token = await getToken(sessionId);
        }
      } catch (e: unknown) {
        console.error('[ws] Failed to send message:', e instanceof Error ? e.message : String(e));
      }
      try {
        ws.send(
          JSON.stringify({
            type: 'session.start',
            ts: Date.now(),
            sessionId,
            turnId,
            data: { systemPrompt, voiceId, vadEnabled: true, pttMode: false, endpointing, firstMessageMode: 'user_speaks_first', language, token },
          })
        );
      } catch {
        startSession(ws);
      }
    });

    ws.addEventListener('error', (error) => {
      console.error('[agentSocket] WebSocket error:', error);
    });

    ws.addEventListener('close', (event) => {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[agentSocket] WebSocket closed:', event.code, event.reason);
      }
      events.onClose?.();
      if (!shouldReconnect) return;
      const base = 1000; // 1s
      const delay = Math.min(30000, base * Math.pow(2, reconnectAttempts)) + Math.floor(Math.random() * 500);
      reconnectAttempts = Math.min(reconnectAttempts + 1, 6);
      if (process.env.NODE_ENV !== 'production') {
        console.log('[agentSocket] Scheduling reconnect in', delay, 'ms');
      }
      setTimeout(() => {
        if (!shouldReconnect) return;
        setupSocket();
      }, delay);
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data === 'string') {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        console.error('[agentSocket] Failed to parse JSON message:', ev.data?.slice?.(0, 200));
        return;
      }
      switch (msg.type) {
        case 'stt.partial':
          events.onSttPartial?.(msg.data.text);
          break;
        case 'stt.final':
          events.onSttFinal?.(msg.data.text);
          break;
        case 'metrics.update':
          // Could surface to UI later (Phase F)
          break;
        case 'llm.partial':
          events.onLlmPartial?.(msg.data.text);
          break;
        case 'llm.final':
          events.onLlmFinal?.(msg.data.text);
          break;
        case 'tts.end':
          emitTtsComplete();
          events.onTtsEnd?.(msg.data.reason);
          break;
        case 'error':
          events.onError?.(msg.data.message || 'error');
          break;
        default:
          console.log('[agentSocket] Unhandled event type:', msg.type);
      }
    } else if (ev.data instanceof ArrayBuffer) {
      const buf = new Uint8Array(ev.data);
      // First 4 bytes header length, then JSON, then payload
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const headerLen = view.getUint32(0, false); // false = big-endian to match server format
      const headerJson = new TextDecoder().decode(buf.subarray(4, 4 + headerLen));
      let header: any;
      try {
        header = JSON.parse(headerJson);
      } catch (e) {
        console.error('[agentSocket] Failed to parse binary header JSON:', headerJson.slice(0, 200));
        return;
      }
      const payload = buf.subarray(4 + headerLen);
      if (process.env.NODE_ENV !== 'production') {
        console.log('[agentSocket] Received binary message, header:', header, 'payload size:', payload.length);
      }
      if (header.type === 'tts.chunk') {
        if (process.env.NODE_ENV !== 'production') {
          console.log('[agentSocket] Appending TTS chunk:', payload.length, 'bytes');
        }
        const audioData = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
        emitTtsChunk(audioData);
      }
    }
  });

    return ws;
  };

  setupSocket();

  const api: AgentConnection = {
    get ws() { return currentWs; },
    updateEndpointing(newEp: EndpointingConfig) {
      try {
        const newTurnId = `t_${Math.random().toString(36).slice(2, 8)}`;
        currentWs?.send(
          JSON.stringify({
            type: 'session.start',
            ts: Date.now(),
            sessionId,
            turnId: newTurnId,
            data: { systemPrompt, voiceId, vadEnabled: true, pttMode: false, endpointing: newEp, firstMessageMode: 'user_speaks_first', language },
          })
        );
      } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
    },
    testUtterance(text: string) {
      currentWs?.send(
        JSON.stringify({
          type: 'test.utterance',
          ts: Date.now(),
          sessionId,
          turnId,
          data: { text },
        })
      );
    },
    close() {
      try {
        shouldReconnect = false;
        currentWs?.close();
      } catch {} // Cleanup operation - empty catch is intentional
    },
  };

  return api;
}
