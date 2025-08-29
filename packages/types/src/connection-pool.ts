/**
 * WebSocket Connection Pool Manager
 * 
 * Provides connection pooling, lifecycle management, and resource monitoring
 * for the Vapi Voice AI agent server.
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { nowTs } from '@vapi/types';

export interface ConnectionMetrics {
  totalConnections: number;
  activeConnections: number;
  maxConcurrentConnections: number;
  connectionsPerSecond: number;
  averageConnectionDuration: number;
  reconnectAttempts: number;
  failedConnections: number;
}

export interface PoolOptions {
  maxConnections: number;
  heartbeatInterval: number; // ms
  connectionTimeout: number; // ms
  maxReconnectAttempts: number;
  reconnectBackoffBase: number; // ms
  reconnectBackoffMax: number; // ms
  resourceCleanupInterval: number; // ms
}

export interface PooledConnection {
  id: string;
  ws: WebSocket;
  sessionId?: string;
  createdAt: number;
  lastActivityAt: number;
  reconnectAttempts: number;
  isAlive: boolean;
  metadata: Record<string, any>;
}

export class ConnectionPool extends EventEmitter {
  private connections = new Map<string, PooledConnection>();
  private metrics: ConnectionMetrics;
  private options: PoolOptions;
  private heartbeatTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private connectionCounter = 0;
  
  // Rate limiting for connection tracking
  private connectionTimestamps: number[] = [];

  constructor(options: Partial<PoolOptions> = {}) {
    super();
    
    this.options = {
      maxConnections: 100,
      heartbeatInterval: 30000, // 30 seconds
      connectionTimeout: 60000, // 60 seconds
      maxReconnectAttempts: 3,
      reconnectBackoffBase: 1000, // 1 second
      reconnectBackoffMax: 30000, // 30 seconds max
      resourceCleanupInterval: 60000, // 1 minute
      ...options
    };

    this.metrics = {
      totalConnections: 0,
      activeConnections: 0,
      maxConcurrentConnections: 0,
      connectionsPerSecond: 0,
      averageConnectionDuration: 0,
      reconnectAttempts: 0,
      failedConnections: 0
    };

    this.startHeartbeat();
    this.startCleanup();
  }

  /**
   * Add a new connection to the pool
   */
  addConnection(ws: WebSocket, metadata: Record<string, any> = {}): string | null {
    // Check connection limits
    if (this.connections.size >= this.options.maxConnections) {
      console.warn(`[ConnectionPool] Max connections reached (${this.options.maxConnections}), rejecting new connection`);
      this.metrics.failedConnections++;
      return null;
    }

    // Rate limiting check - max 10 connections per second
    const now = Date.now();
    this.connectionTimestamps = this.connectionTimestamps.filter(ts => now - ts < 1000);
    if (this.connectionTimestamps.length >= 10) {
      console.warn('[ConnectionPool] Connection rate limit exceeded (10/sec)');
      this.metrics.failedConnections++;
      return null;
    }

    const connectionId = `conn_${++this.connectionCounter}_${Date.now()}`;
    const connection: PooledConnection = {
      id: connectionId,
      ws,
      createdAt: now,
      lastActivityAt: now,
      reconnectAttempts: 0,
      isAlive: true,
      metadata
    };

    this.connections.set(connectionId, connection);
    this.connectionTimestamps.push(now);

    // Update metrics
    this.metrics.totalConnections++;
    this.metrics.activeConnections = this.connections.size;
    this.metrics.maxConcurrentConnections = Math.max(
      this.metrics.maxConcurrentConnections,
      this.metrics.activeConnections
    );

    // Set up connection event handlers
    this.setupConnectionHandlers(connection);

    this.emit('connectionAdded', connection);
    console.log(`[ConnectionPool] Added connection ${connectionId} (${this.connections.size}/${this.options.maxConnections})`);

    return connectionId;
  }

  /**
   * Remove a connection from the pool
   */
  removeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    // Calculate connection duration for metrics
    const duration = Date.now() - connection.createdAt;
    const totalDuration = this.metrics.averageConnectionDuration * (this.metrics.totalConnections - 1) + duration;
    this.metrics.averageConnectionDuration = totalDuration / this.metrics.totalConnections;

    // Clean up WebSocket
    try {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close(1000, 'Pool cleanup');
      }
    } catch (error) {
      console.error(`[ConnectionPool] Error closing connection ${connectionId}:`, error instanceof Error ? error.message : String(error));
    }

    this.connections.delete(connectionId);
    this.metrics.activeConnections = this.connections.size;

    this.emit('connectionRemoved', connection);
    console.log(`[ConnectionPool] Removed connection ${connectionId} (${this.connections.size} remaining)`);
  }

  /**
   * Get connection by ID
   */
  getConnection(connectionId: string): PooledConnection | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Update connection activity timestamp
   */
  updateActivity(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.lastActivityAt = Date.now();
    }
  }

  /**
   * Associate a session with a connection
   */
  setSessionId(connectionId: string, sessionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.sessionId = sessionId;
      this.emit('sessionAssociated', connection, sessionId);
    }
  }

  /**
   * Get all connections
   */
  getAllConnections(): PooledConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get connections by session ID
   */
  getConnectionsBySession(sessionId: string): PooledConnection[] {
    return this.getAllConnections().filter(conn => conn.sessionId === sessionId);
  }

  /**
   * Get current metrics
   */
  getMetrics(): ConnectionMetrics {
    // Calculate connections per second over last minute
    const now = Date.now();
    const recentConnections = this.connectionTimestamps.filter(ts => now - ts < 60000);
    this.metrics.connectionsPerSecond = recentConnections.length / 60;

    return { ...this.metrics };
  }

  /**
   * Setup event handlers for a connection
   */
  private setupConnectionHandlers(connection: PooledConnection): void {
    const { ws, id } = connection;

    // Handle pong responses for heartbeat
    ws.on('pong', () => {
      connection.isAlive = true;
      connection.lastActivityAt = Date.now();
      console.log(`[ConnectionPool] Received pong from ${id}`);
    });

    // Handle connection close
    ws.on('close', (code, reason) => {
      console.log(`[ConnectionPool] Connection ${id} closed: ${code} ${reason}`);
      this.removeConnection(id);
    });

    // Handle connection errors
    ws.on('error', (error) => {
      console.error(`[ConnectionPool] Connection ${id} error:`, error instanceof Error ? error.message : String(error));
      this.metrics.failedConnections++;
      // Don't automatically remove on error - let close handler handle it
    });

    // Update activity on any message
    ws.on('message', () => {
      this.updateActivity(id);
    });
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.performHeartbeat();
    }, this.options.heartbeatInterval);

    console.log(`[ConnectionPool] Started heartbeat monitoring (${this.options.heartbeatInterval}ms interval)`);
  }

  /**
   * Perform heartbeat check on all connections
   */
  private performHeartbeat(): void {
    const deadConnections: string[] = [];
    const now = Date.now();

    for (const [id, connection] of this.connections) {
      // Check if connection hasn't responded to previous ping
      if (!connection.isAlive) {
        console.warn(`[ConnectionPool] Connection ${id} failed heartbeat, marking for removal`);
        deadConnections.push(id);
        continue;
      }

      // Check for inactive connections
      if (now - connection.lastActivityAt > this.options.connectionTimeout) {
        console.warn(`[ConnectionPool] Connection ${id} inactive for ${now - connection.lastActivityAt}ms, marking for removal`);
        deadConnections.push(id);
        continue;
      }

      // Send ping
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.isAlive = false; // Will be set to true on pong
        try {
          connection.ws.ping();
          console.log(`[ConnectionPool] Sent ping to ${id}`);
        } catch (error) {
          console.error(`[ConnectionPool] Failed to ping ${id}:`, error instanceof Error ? error.message : String(error));
          deadConnections.push(id);
        }
      } else {
        deadConnections.push(id);
      }
    }

    // Remove dead connections
    deadConnections.forEach(id => this.removeConnection(id));

    if (deadConnections.length > 0) {
      console.log(`[ConnectionPool] Removed ${deadConnections.length} dead connections during heartbeat`);
    }
  }

  /**
   * Start resource cleanup
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.options.resourceCleanupInterval);

    console.log(`[ConnectionPool] Started resource cleanup (${this.options.resourceCleanupInterval}ms interval)`);
  }

  /**
   * Perform resource cleanup
   */
  private performCleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    // Clean up old connection timestamps
    const oldTimestampCount = this.connectionTimestamps.length;
    this.connectionTimestamps = this.connectionTimestamps.filter(ts => now - ts < 300000); // Keep 5 minutes
    cleaned += oldTimestampCount - this.connectionTimestamps.length;

    if (cleaned > 0) {
      console.log(`[ConnectionPool] Cleaned up ${cleaned} old resources`);
    }

    // Log current pool status
    console.log(`[ConnectionPool] Status: ${this.connections.size}/${this.options.maxConnections} connections, ${this.metrics.connectionsPerSecond.toFixed(2)}/sec rate`);
  }

  /**
   * Shutdown the connection pool
   */
  shutdown(): void {
    console.log(`[ConnectionPool] Shutting down with ${this.connections.size} active connections`);

    // Clear timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Close all connections
    for (const [id, connection] of this.connections) {
      try {
        if (connection.ws.readyState === WebSocket.OPEN) {
          connection.ws.close(1001, 'Server shutting down');
        }
      } catch (error) {
        console.error(`[ConnectionPool] Error closing connection ${id} during shutdown:`, error instanceof Error ? error.message : String(error));
      }
    }

    this.connections.clear();
    this.metrics.activeConnections = 0;

    this.emit('shutdown');
    console.log('[ConnectionPool] Shutdown complete');
  }

  /**
   * Get pool statistics for monitoring
   */
  getStats() {
    return {
      ...this.getMetrics(),
      poolSize: this.connections.size,
      maxPoolSize: this.options.maxConnections,
      utilizationPercent: (this.connections.size / this.options.maxConnections) * 100,
      heartbeatInterval: this.options.heartbeatInterval,
      connectionTimeout: this.options.connectionTimeout,
    };
  }
}

// Export singleton instance
export const connectionPool = new ConnectionPool({
  maxConnections: parseInt(process.env.MAX_WS_CONNECTIONS || '100'),
  heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000'),
  connectionTimeout: parseInt(process.env.WS_CONNECTION_TIMEOUT || '60000'),
  maxReconnectAttempts: parseInt(process.env.WS_MAX_RECONNECT_ATTEMPTS || '3'),
});

// Graceful shutdown handler
process.on('SIGINT', () => {
  console.log('[ConnectionPool] Received SIGINT, shutting down gracefully...');
  connectionPool.shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[ConnectionPool] Received SIGTERM, shutting down gracefully...');
  connectionPool.shutdown();
  process.exit(0);
});