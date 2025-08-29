/**
 * Enhanced WebSocket client with automatic reconnection and exponential backoff
 * 
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Connection state management
 * - Message queuing during disconnection
 * - Heartbeat monitoring
 * - Event-based architecture for easy integration
 */

export interface WebSocketClientOptions {
  url: string;
  protocols?: string | string[];
  reconnectEnabled?: boolean;
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number; // ms
  reconnectMaxDelay?: number; // ms
  heartbeatInterval?: number; // ms
  connectionTimeout?: number; // ms
  messageQueueSize?: number;
}

export interface WebSocketMessage {
  type: string;
  data: any;
  timestamp: number;
  id?: string;
}

export enum ConnectionState {
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  DISCONNECTED = 'disconnected',
  FAILED = 'failed'
}

export type WebSocketClientEventMap = {
  'stateChange': { state: ConnectionState; previousState: ConnectionState };
  'message': { message: WebSocketMessage; raw: MessageEvent };
  'connected': { attemptNumber: number };
  'disconnected': { code: number; reason: string; wasClean: boolean };
  'error': { error: Event | Error };
  'reconnectAttempt': { attemptNumber: number; delay: number };
  'reconnectFailed': { attemptNumber: number; maxAttempts: number };
  'messageQueued': { message: any; queueSize: number };
  'messageSent': { message: any };
};

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private options: WebSocketClientOptions & Required<Omit<WebSocketClientOptions, 'protocols'>>;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private messageQueue: any[] = [];
  private listeners = new Map<keyof WebSocketClientEventMap, Set<(...args: any[]) => void>>();
  private isManuallyDisconnected = false;

  constructor(options: WebSocketClientOptions) {
    this.options = {
      reconnectEnabled: true,
      maxReconnectAttempts: 5,
      reconnectBaseDelay: 1000, // 1 second
      reconnectMaxDelay: 30000, // 30 seconds
      heartbeatInterval: 30000, // 30 seconds
      connectionTimeout: 10000, // 10 seconds
      messageQueueSize: 50,
      ...options
    };
  }

  /**
   * Connect to the WebSocket server
   */
  connect(): void {
    if (this.state === ConnectionState.CONNECTING || this.state === ConnectionState.CONNECTED) {
      console.warn('[WebSocketClient] Already connecting/connected');
      return;
    }

    this.isManuallyDisconnected = false;
    this.setState(ConnectionState.CONNECTING);
    this.createConnection();
  }

  /**
   * Manually disconnect from the WebSocket server
   */
  disconnect(): void {
    this.isManuallyDisconnected = true;
    this.cleanup();
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'Manual disconnect');
    }
    
    this.setState(ConnectionState.DISCONNECTED);
  }

  /**
   * Send a message through the WebSocket
   */
  send(data: any): boolean {
    if (this.state === ConnectionState.CONNECTED && this.ws) {
      try {
        const message = typeof data === 'string' ? data : JSON.stringify(data);
        this.ws.send(message);
        this.emit('messageSent', { message: data });
        return true;
      } catch (error) {
        console.error('[WebSocketClient] Failed to send message:', error);
        this.queueMessage(data);
        return false;
      }
    } else {
      this.queueMessage(data);
      return false;
    }
  }

  /**
   * Send binary data through the WebSocket
   */
  sendBinary(data: ArrayBuffer | Uint8Array): boolean {
    if (this.state === ConnectionState.CONNECTED && this.ws) {
      try {
        this.ws.send(data);
        this.emit('messageSent', { message: data });
        return true;
      } catch (error) {
        console.error('[WebSocketClient] Failed to send binary message:', error);
        return false;
      }
    }
    return false;
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if currently connected
   */
  isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return {
      state: this.state,
      reconnectAttempts: this.reconnectAttempts,
      queuedMessages: this.messageQueue.length,
      isManuallyDisconnected: this.isManuallyDisconnected,
      readyState: this.ws?.readyState ?? WebSocket.CLOSED,
      url: this.options.url
    };
  }

  /**
   * Add event listener
   */
  on<K extends keyof WebSocketClientEventMap>(
    event: K,
    listener: (data: WebSocketClientEventMap[K]) => void
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  /**
   * Remove event listener
   */
  off<K extends keyof WebSocketClientEventMap>(
    event: K,
    listener: (data: WebSocketClientEventMap[K]) => void
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener);
    }
  }

  /**
   * Remove all event listeners
   */
  removeAllListeners(): void {
    this.listeners.clear();
  }

  /**
   * Create a new WebSocket connection
   */
  private createConnection(): void {
    try {
      this.cleanup();

      const ws = new WebSocket(this.options.url, this.options.protocols);
      this.ws = ws;

      // Set connection timeout
      this.connectionTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          console.warn('[WebSocketClient] Connection timeout');
          ws.close();
          this.handleConnectionFailure();
        }
      }, this.options.connectionTimeout);

      ws.onopen = () => {
        console.log('[WebSocketClient] Connected successfully');
        this.clearConnectionTimer();
        this.reconnectAttempts = 0;
        this.setState(ConnectionState.CONNECTED);
        this.startHeartbeat();
        this.flushMessageQueue();
        this.emit('connected', { attemptNumber: this.reconnectAttempts });
      };

      ws.onclose = (event) => {
        console.log(`[WebSocketClient] Connection closed: ${event.code} ${event.reason}`);
        this.cleanup();
        this.emit('disconnected', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean
        });

        if (!this.isManuallyDisconnected) {
          this.handleConnectionFailure();
        }
      };

      ws.onerror = (error) => {
        console.error('[WebSocketClient] WebSocket error:', error);
        this.emit('error', { error });
      };

      ws.onmessage = (event) => {
        try {
          let parsedMessage: WebSocketMessage;
          
          if (typeof event.data === 'string') {
            try {
              const jsonData = JSON.parse(event.data);
              parsedMessage = {
                type: jsonData.type || 'unknown',
                data: jsonData,
                timestamp: Date.now()
              };
            } catch {
              // Not JSON, treat as plain text
              parsedMessage = {
                type: 'text',
                data: event.data,
                timestamp: Date.now()
              };
            }
          } else {
            // Binary data
            parsedMessage = {
              type: 'binary',
              data: event.data,
              timestamp: Date.now()
            };
          }

          this.emit('message', { message: parsedMessage, raw: event });
        } catch (error) {
          console.error('[WebSocketClient] Error processing message:', error);
        }
      };

    } catch (error) {
      console.error('[WebSocketClient] Failed to create connection:', error);
      this.handleConnectionFailure();
    }
  }

  /**
   * Handle connection failure and attempt reconnection
   */
  private handleConnectionFailure(): void {
    if (this.isManuallyDisconnected || !this.options.reconnectEnabled) {
      this.setState(ConnectionState.DISCONNECTED);
      return;
    }

    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error(`[WebSocketClient] Max reconnection attempts reached (${this.options.maxReconnectAttempts})`);
      this.setState(ConnectionState.FAILED);
      this.emit('reconnectFailed', {
        attemptNumber: this.reconnectAttempts,
        maxAttempts: this.options.maxReconnectAttempts
      });
      return;
    }

    this.setState(ConnectionState.RECONNECTING);
    this.reconnectAttempts++;

    // Calculate exponential backoff delay
    const baseDelay = this.options.reconnectBaseDelay;
    const maxDelay = this.options.reconnectMaxDelay;
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), maxDelay);
    
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.3; // 0-30% jitter
    const delay = exponentialDelay * (1 + jitter);

    console.log(`[WebSocketClient] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts})`);
    
    this.emit('reconnectAttempt', { attemptNumber: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(() => {
      if (!this.isManuallyDisconnected) {
        this.createConnection();
      }
    }, delay);
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(): void {
    if (this.options.heartbeatInterval <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Send ping - the server should handle this
        try {
          this.send({ type: 'ping', timestamp: Date.now() });
        } catch (error) {
          console.error('[WebSocketClient] Heartbeat failed:', error);
        }
      }
    }, this.options.heartbeatInterval);
  }

  /**
   * Queue a message for later delivery
   */
  private queueMessage(data: any): void {
    if (this.messageQueue.length >= this.options.messageQueueSize) {
      console.warn('[WebSocketClient] Message queue full, dropping oldest message');
      this.messageQueue.shift();
    }
    
    this.messageQueue.push(data);
    this.emit('messageQueued', { message: data, queueSize: this.messageQueue.length });
  }

  /**
   * Send all queued messages
   */
  private flushMessageQueue(): void {
    if (this.messageQueue.length === 0) return;

    console.log(`[WebSocketClient] Flushing ${this.messageQueue.length} queued messages`);
    
    const messages = [...this.messageQueue];
    this.messageQueue = [];
    
    for (const message of messages) {
      this.send(message);
    }
  }

  /**
   * Update connection state and emit event
   */
  private setState(newState: ConnectionState): void {
    const previousState = this.state;
    this.state = newState;
    
    if (previousState !== newState) {
      console.log(`[WebSocketClient] State changed: ${previousState} -> ${newState}`);
      this.emit('stateChange', { state: newState, previousState });
    }
  }

  /**
   * Emit an event to all listeners
   */
  private emit<K extends keyof WebSocketClientEventMap>(
    event: K,
    data: WebSocketClientEventMap[K]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        try {
          listener(data);
        } catch (error) {
          console.error(`[WebSocketClient] Error in ${event} listener:`, error);
        }
      }
    }
  }

  /**
   * Clear connection timeout
   */
  private clearConnectionTimer(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }
  }

  /**
   * Clean up timers and resources
   */
  private cleanup(): void {
    this.clearConnectionTimer();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * Destroy the client and clean up all resources
   */
  destroy(): void {
    this.isManuallyDisconnected = true;
    this.cleanup();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.messageQueue = [];
    this.removeAllListeners();
    this.setState(ConnectionState.DISCONNECTED);
  }
}