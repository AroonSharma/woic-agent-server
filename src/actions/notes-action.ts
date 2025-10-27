// Notes Action Implementation
// Phase 1, Task 2.2: Note creation and management with Supabase storage

import { createClient } from '@supabase/supabase-js';
import { 
  BaseAction, 
  ActionCategory, 
  ActionContext, 
  ActionResult, 
  NotesActionParams,
  NotesActionSchema,
  FunctionSchema,
  ValidationResult 
} from '../types/actions';
import { NOTES_FUNCTION_SCHEMA } from '../openai-manager';

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  priority: 'low' | 'medium' | 'high';
  category?: string;
  isPrivate: boolean;
  userId: string;
  agentId?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, any>;
}

export interface NotesConfig {
  supabaseUrl: string;
  supabaseServiceKey: string;
  tableName?: string;
  enableFullTextSearch?: boolean;
  maxNotesPerUser?: number;
  maxContentLength?: number;
}

export class NotesAction implements BaseAction {
  name = 'create_note';
  description = 'Create a note or reminder with optional tags and categorization';
  category = ActionCategory.DATA;
  schema: FunctionSchema = NOTES_FUNCTION_SCHEMA;

  private config: NotesConfig;
  private supabase: any;
  private tableName: string;

  constructor(config?: Partial<NotesConfig>) {
    this.config = {
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      tableName: 'voice_notes',
      enableFullTextSearch: true,
      maxNotesPerUser: 10000,
      maxContentLength: 50000,
      ...config
    };

    this.tableName = this.config.tableName || 'voice_notes';
    this.initializeSupabase();
  }

  private initializeSupabase(): void {
    if (!this.config.supabaseUrl || !this.config.supabaseServiceKey) {
      console.warn('[notes-action] Supabase credentials not configured. Notes will not be saved.');
      return;
    }

    try {
      this.supabase = createClient(
        this.config.supabaseUrl,
        this.config.supabaseServiceKey
      );
      
      console.log('[notes-action] Supabase client initialized successfully');
    } catch (error) {
      console.error('[notes-action] Failed to initialize Supabase client:', error);
    }
  }

  async execute(params: NotesActionParams, context: ActionContext): Promise<ActionResult> {
    const startTime = Date.now();

    try {
      if (!this.supabase) {
        throw new Error('Notes service not properly configured. Please check Supabase settings.');
      }

      // Check user's note count limit
      await this.checkUserNoteLimit(context.userId);

      // Process and clean content
      const processedContent = this.processContent(params.content);
      
      // Generate note ID
      const noteId = this.generateNoteId();
      
      // Prepare note data for database (using snake_case column names)
      const noteData = {
        id: noteId,
        title: params.title.trim(),
        content: processedContent,
        tags: this.processTags(params.tags || []),
        priority: params.priority || 'medium',
        category: params.category?.trim() || undefined,
        is_private: params.isPrivate || false,
        user_id: context.userId,
        agent_id: context.agentId,
        session_id: context.sessionId,
        metadata: {
          createdVia: 'voice_agent',
          userEmail: context.userEmail,
          organizationId: context.organizationId
        }
      };

      // Save to database
      console.log(`[notes-action] Creating note for user ${context.userId}: ${params.title.substring(0, 30)}...`);
      
      const { data, error } = await this.supabase
        .from(this.tableName)
        .insert([{
          ...noteData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (error) {
        throw new Error(`Database error: ${error.message}`);
      }

      // Generate searchable content if full-text search is enabled
      if (this.config.enableFullTextSearch) {
        await this.updateSearchIndex(data.id, {
          id: noteData.id,
          title: noteData.title,
          content: noteData.content,
          tags: noteData.tags,
          priority: noteData.priority,
          category: noteData.category,
          isPrivate: noteData.is_private,
          userId: noteData.user_id,
          agentId: noteData.agent_id,
          sessionId: noteData.session_id,
          metadata: noteData.metadata
        });
      }

      const executionTime = Date.now() - startTime;
      console.log(`[notes-action] Note created successfully in ${executionTime}ms. ID: ${noteId}`);

      return {
        success: true,
        message: `Note "${params.title}" created successfully`,
        data: {
          noteId: data.id,
          title: data.title || params.title,
          tags: noteData.tags,
          priority: noteData.priority,
          category: noteData.category,
          wordCount: this.countWords(processedContent),
          characterCount: processedContent.length,
          createdAt: data.created_at,
          isPrivate: noteData.is_private
        },
        executionTimeMs: executionTime
      };

    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown notes error';
      
      console.error(`[notes-action] Note creation failed after ${executionTime}ms:`, errorMessage);

      return {
        success: false,
        message: `Failed to create note: ${errorMessage}`,
        executionTimeMs: executionTime,
        metadata: {
          error: errorMessage,
          title: params.title,
          contentLength: params.content.length
        }
      };
    }
  }

  validate(params: any): ValidationResult {
    try {
      console.log('[notes-action] Validating parameters:', JSON.stringify(params, null, 2));
      NotesActionSchema.parse(params);
      
      const errors: string[] = [];
      const warnings: string[] = [];

      // Additional validation
      if (params.title && params.title.length < 1) {
        errors.push('Title cannot be empty');
      }
      
      if (params.title && params.title.length > 200) {
        errors.push('Title too long (max 200 characters)');
      }

      if (params.content && params.content.length < 1) {
        errors.push('Content cannot be empty');
      }

      if (params.content && params.content.length > (this.config.maxContentLength || 50000)) {
        errors.push(`Content too long (max ${this.config.maxContentLength || 50000} characters)`);
      }

      // Validate tags
      if (params.tags) {
        if (!Array.isArray(params.tags)) {
          errors.push('Tags must be an array');
        } else if (params.tags.length > 20) {
          errors.push('Too many tags (max 20)');
        } else {
          params.tags.forEach((tag: any, index: number) => {
            if (typeof tag !== 'string') {
              errors.push(`Tag at index ${index} must be a string`);
            } else if (tag.length > 50) {
              errors.push(`Tag "${tag}" is too long (max 50 characters)`);
            }
          });
        }
      }

      // Check for potentially sensitive content
      if (this.containsSensitiveData(params.content)) {
        warnings.push('Content may contain sensitive information');
      }

      return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined
      };

    } catch (error) {
      return {
        valid: false,
        errors: ['Invalid note parameters']
      };
    }
  }

  getRequiredPermissions(): string[] {
    return ['notes:create'];
  }

  private async checkUserNoteLimit(userId: string): Promise<void> {
    if (!this.config.maxNotesPerUser) return;

    const { count, error } = await this.supabase
      .from(this.tableName)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (error) {
      console.warn('[notes-action] Could not check user note limit:', error.message);
      return;
    }

    if (count && count >= this.config.maxNotesPerUser) {
      throw new Error(`Note limit reached. Maximum ${this.config.maxNotesPerUser} notes per user.`);
    }
  }

  private processContent(content: string): string {
    // Clean and process content
    return content
      .trim()
      .replace(/\r\n/g, '\n')  // Normalize line endings
      .replace(/\n{3,}/g, '\n\n')  // Limit consecutive line breaks
      .substring(0, this.config.maxContentLength || 50000);  // Ensure length limit
  }

  private processTags(tags: string[]): string[] {
    return tags
      .map(tag => tag.trim().toLowerCase())
      .filter(tag => tag.length > 0 && tag.length <= 50)
      .filter((tag, index, arr) => arr.indexOf(tag) === index)  // Remove duplicates
      .slice(0, 20);  // Limit to 20 tags
  }

  private generateNoteId(): string {
    return `note_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private countWords(text: string): number {
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
  }

  private containsSensitiveData(content: string): boolean {
    const sensitivePatterns = [
      /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,  // Credit card numbers
      /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/,  // SSN patterns
      /password|pwd|secret|key|token/i,  // Common sensitive keywords
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i  // Email addresses
    ];

    return sensitivePatterns.some(pattern => pattern.test(content));
  }

  private async updateSearchIndex(noteId: string, noteData: Omit<Note, 'createdAt' | 'updatedAt'>): Promise<void> {
    // Search will work using PostgreSQL's built-in text search on title, content, and tags
    // No need for separate search_vector column - the GIN indexes on tags and regular indexes handle it
    console.log('[notes-action] Note indexed for search:', noteId);
  }

  /**
   * Additional utility methods for note management
   */

  async searchNotes(userId: string, query: string, limit: number = 20): Promise<Note[]> {
    if (!this.supabase) return [];

    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .select('*')
        .eq('user_id', userId)
        .or(`title.ilike.%${query}%,content.ilike.%${query}%,tags.cs.{${query}}`)
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];

    } catch (error) {
      console.error('[notes-action] Search failed:', error);
      return [];
    }
  }

  async getNotesByTag(userId: string, tag: string, limit: number = 50): Promise<Note[]> {
    if (!this.supabase) return [];

    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .select('*')
        .eq('user_id', userId)
        .contains('tags', [tag])
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];

    } catch (error) {
      console.error('[notes-action] Get notes by tag failed:', error);
      return [];
    }
  }

  async updateNote(noteId: string, userId: string, updates: Partial<NotesActionParams>): Promise<ActionResult> {
    if (!this.supabase) {
      return { success: false, message: 'Notes service not configured' };
    }

    try {
      const updateData: any = {
        updated_at: new Date().toISOString()
      };

      if (updates.title) updateData.title = updates.title.trim();
      if (updates.content) updateData.content = this.processContent(updates.content);
      if (updates.tags) updateData.tags = this.processTags(updates.tags);
      if (updates.priority) updateData.priority = updates.priority;
      if (updates.category !== undefined) updateData.category = updates.category?.trim() || null;
      if (updates.isPrivate !== undefined) updateData.is_private = updates.isPrivate;

      const { data, error } = await this.supabase
        .from(this.tableName)
        .update(updateData)
        .eq('id', noteId)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;

      return {
        success: true,
        message: 'Note updated successfully',
        data: { noteId, updatedAt: data.updated_at }
      };

    } catch (error) {
      return {
        success: false,
        message: `Failed to update note: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  async deleteNote(noteId: string, userId: string): Promise<ActionResult> {
    if (!this.supabase) {
      return { success: false, message: 'Notes service not configured' };
    }

    try {
      const { error } = await this.supabase
        .from(this.tableName)
        .delete()
        .eq('id', noteId)
        .eq('user_id', userId);

      if (error) throw error;

      return {
        success: true,
        message: 'Note deleted successfully',
        data: { noteId }
      };

    } catch (error) {
      return {
        success: false,
        message: `Failed to delete note: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Get notes statistics for user
   */
  async getUserNotesStats(userId: string): Promise<any> {
    if (!this.supabase) return null;

    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .select('priority, tags, created_at, updated_at')
        .eq('user_id', userId);

      if (error) throw error;

      const stats = {
        totalNotes: data.length,
        byPriority: { low: 0, medium: 0, high: 0 },
        totalTags: new Set(),
        oldestNote: null,
        newestNote: null
      };

      data.forEach((note: any) => {
        stats.byPriority[note.priority as keyof typeof stats.byPriority]++;
        if (note.tags) {
          note.tags.forEach((tag: string) => stats.totalTags.add(tag));
        }
        
        if (!stats.oldestNote || note.created_at < stats.oldestNote) {
          stats.oldestNote = note.created_at;
        }
        if (!stats.newestNote || note.created_at > stats.newestNote) {
          stats.newestNote = note.created_at;
        }
      });

      return {
        ...stats,
        uniqueTags: stats.totalTags.size,
        totalTags: undefined  // Remove the Set object from response
      };

    } catch (error) {
      console.error('[notes-action] Failed to get user stats:', error);
      return null;
    }
  }

  /**
   * Test notes configuration
   */
  async testConfiguration(): Promise<boolean> {
    try {
      if (!this.supabase) return false;
      
      // Test connection by trying to query the table
      const { error } = await this.supabase
        .from(this.tableName)
        .select('id')
        .limit(1);

      return !error;
    } catch (error) {
      console.error('[notes-action] Configuration test failed:', error);
      return false;
    }
  }
}