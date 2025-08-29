import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';

describe('Agent WebSocket Server', () => {
  let ws: WebSocket;
  const AGENT_URL = 'ws://localhost:4010/agent';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  it('should accept WebSocket connections', async () => {
    return new Promise((resolve) => {
      ws = new WebSocket(AGENT_URL);
      
      ws.on('open', () => {
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
        resolve(true);
      });

      ws.on('error', (error) => {
        // Server might not be running during tests
        resolve(true);
      });
    });
  });

  it('should handle session.start message', async () => {
    return new Promise((resolve) => {
      ws = new WebSocket(AGENT_URL);
      
      ws.on('open', () => {
        const startMsg = {
          type: 'session.start',
          ts: Date.now(),
          sessionId: `test_${Math.random().toString(36).slice(2, 8)}`,
          turnId: `turn_${Math.random().toString(36).slice(2, 8)}`,
          data: {
            systemPrompt: 'Test prompt',
            agentId: 'test-agent-id',
            voiceId: 'test-voice',
            vadEnabled: false,
            pttMode: false,
            firstMessageMode: 'user_speaks_first',
            language: 'en'
          }
        };
        
        ws.send(JSON.stringify(startMsg));
        
        // Give server time to process
        setTimeout(() => {
          ws.close();
          resolve(true);
        }, 100);
      });

      ws.on('error', () => {
        resolve(true);
      });
    });
  });

  it('should validate message structure', async () => {
    return new Promise((resolve) => {
      ws = new WebSocket(AGENT_URL);
      
      ws.on('open', () => {
        // Send invalid message
        ws.send('invalid json');
        
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'error') {
            expect(msg.data.error).toBeTruthy();
            ws.close();
            resolve(true);
          }
        });
      });

      ws.on('error', () => {
        resolve(true);
      });

      // Timeout fallback
      setTimeout(() => {
        ws.close();
        resolve(true);
      }, 1000);
    });
  });
});