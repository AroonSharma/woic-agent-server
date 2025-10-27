import type { ChatMessage } from './types';

// Alias for backward compatibility - use ChatMessage from types.ts
export type ConversationMessage = ChatMessage;

export interface ConversationMemory {
  messages: ConversationMessage[];
  sessionId: string;
  created: number;
  lastUpdated: number;
}

const MAX_MESSAGES = 17; // Keep 1 system + 16 conversation messages
const MAX_CONVERSATIONS = Number(process.env.CONVERSATION_MAX || 100);
const MEMORY_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MEMORY_TTL = 30 * 60 * 1000; // 30 minutes

class ConversationMemoryManager {
  private conversations: Map<string, ConversationMemory> = new Map();
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), MEMORY_CLEANUP_INTERVAL);
  }

  createConversation(sessionId: string, systemPrompt: string, initialAssistantMessage?: string): ConversationMemory {
    // Enforce cap: evict oldest conversations by lastUpdated
    if (this.conversations.size >= MAX_CONVERSATIONS) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [sid, memory] of this.conversations.entries()) {
        if (memory.lastUpdated < oldestAt) {
          oldestAt = memory.lastUpdated;
          oldestKey = sid;
        }
      }
      if (oldestKey) {
        this.conversations.delete(oldestKey);
        console.log(`[memory] Evicted oldest conversation ${oldestKey} to enforce cap ${MAX_CONVERSATIONS}`);
      }
    }
    const now = Date.now();
    
    const messages: ConversationMessage[] = [{ role: 'system', content: systemPrompt }];
    
    // Add initial assistant message if provided
    if (initialAssistantMessage) {
      messages.push({ role: 'assistant', content: initialAssistantMessage });
      console.log(`[memory] Added initial assistant message to session ${sessionId}: "${initialAssistantMessage}"`);
    }
    
    const memory: ConversationMemory = {
      messages,
      sessionId,
      created: now,
      lastUpdated: now
    };
    
    this.conversations.set(sessionId, memory);
    console.log(`[memory] Created new conversation for session ${sessionId}`);
    return memory;
  }

  getConversation(sessionId: string): ConversationMemory | null {
    const memory = this.conversations.get(sessionId);
    if (memory) {
      memory.lastUpdated = Date.now();
    }
    return memory || null;
  }

  addMessage(sessionId: string, message: ConversationMessage): boolean {
    const memory = this.conversations.get(sessionId);
    if (!memory) {
      console.warn(`[memory] Attempted to add message to unknown session ${sessionId}`);
      return false;
    }

    memory.messages.push(message);
    memory.lastUpdated = Date.now();

    // Trim messages if we exceed the limit
    if (memory.messages.length > MAX_MESSAGES) {
      const systemMsg = memory.messages[0];
      memory.messages = [systemMsg, ...memory.messages.slice(-16)];
      console.log(`[memory] Trimmed conversation history for session ${sessionId} to ${memory.messages.length} messages`);
    }

    return true;
  }

  addUserMessage(sessionId: string, content: string): boolean {
    return this.addMessage(sessionId, { role: 'user', content });
  }

  addAssistantMessage(sessionId: string, content: string): boolean {
    return this.addMessage(sessionId, { role: 'assistant', content });
  }

  updateSystemPrompt(sessionId: string, systemPrompt: string): boolean {
    const memory = this.conversations.get(sessionId);
    if (!memory) {
      console.warn(`[memory] Attempted to update system prompt for unknown session ${sessionId}`);
      return false;
    }

    if (memory.messages.length > 0 && memory.messages[0].role === 'system') {
      memory.messages[0].content = systemPrompt;
      memory.lastUpdated = Date.now();
      console.log(`[memory] Updated system prompt for session ${sessionId}`);
      return true;
    }

    return false;
  }

  getMessages(sessionId: string): ConversationMessage[] {
    const memory = this.conversations.get(sessionId);
    return memory ? [...memory.messages] : [];
  }

  getMessageCount(sessionId: string): number {
    const memory = this.conversations.get(sessionId);
    return memory ? memory.messages.length : 0;
  }

  removeConversation(sessionId: string): boolean {
    const removed = this.conversations.delete(sessionId);
    if (removed) {
      console.log(`[memory] Removed conversation for session ${sessionId}`);
    }
    return removed;
  }

  private cleanup(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [sessionId, memory] of this.conversations.entries()) {
      if (now - memory.lastUpdated > MEMORY_TTL) {
        expired.push(sessionId);
      }
    }

    for (const sessionId of expired) {
      this.removeConversation(sessionId);
    }

    if (expired.length > 0) {
      console.log(`[memory] Cleaned up ${expired.length} expired conversations`);
    }
  }

  getStats(): { totalConversations: number; totalMessages: number } {
    let totalMessages = 0;
    for (const memory of this.conversations.values()) {
      totalMessages += memory.messages.length;
    }

    return {
      totalConversations: this.conversations.size,
      totalMessages
    };
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.conversations.clear();
  }
}

// Export singleton instance
export const conversationMemory = new ConversationMemoryManager();

// Export class for testing
export { ConversationMemoryManager };