// Action Manager - Central orchestrator for external actions
// Phase 1, Task 1.3: Core action management system

import { 
  ActionType,
  ActionCategory,
  ActionContext,
  ActionResult,
  ActionExecutionLog,
  ActionPermission,
  ActionRateLimit,
  BaseAction,
  FunctionCall,
  ValidationResult,
  ActionValidationError,
  ActionPermissionError,
  ActionRateLimitError,
  ActionExecutionError
} from './types/actions';

export interface ActionManagerConfig {
  enableAuditLogging?: boolean;
  enableRateLimiting?: boolean;
  enablePermissionChecking?: boolean;
  defaultTimeout?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export interface ActionRegistry {
  [key: string]: BaseAction;
}

export class ActionManager {
  private actions: ActionRegistry = {};
  private permissions: Map<string, ActionPermission[]> = new Map();
  private rateLimits: Map<ActionType, ActionRateLimit> = new Map();
  private executionCounts: Map<string, { minute: number; hour: number; day: number; lastReset: number }> = new Map();
  private config: ActionManagerConfig;

  constructor(config: ActionManagerConfig = {}) {
    this.config = {
      enableAuditLogging: true,
      enableRateLimiting: true,
      enablePermissionChecking: true,
      defaultTimeout: 30000,
      logLevel: 'info',
      ...config
    };

    this.initializeDefaultRateLimits();
  }

  private initializeDefaultRateLimits(): void {
    // Set conservative default rate limits
    const defaultLimits: Array<[ActionType, ActionRateLimit]> = [
      [ActionType.SEND_EMAIL, { actionType: ActionType.SEND_EMAIL, maxPerMinute: 5, maxPerHour: 50, maxPerDay: 200 }],
      [ActionType.SEND_SLACK, { actionType: ActionType.SEND_SLACK, maxPerMinute: 10, maxPerHour: 100, maxPerDay: 500 }],
      [ActionType.BOOK_MEETING, { actionType: ActionType.BOOK_MEETING, maxPerMinute: 3, maxPerHour: 20, maxPerDay: 50 }],
      [ActionType.CREATE_NOTE, { actionType: ActionType.CREATE_NOTE, maxPerMinute: 20, maxPerHour: 200, maxPerDay: 1000 }],
      [ActionType.CREATE_CONTACT, { actionType: ActionType.CREATE_CONTACT, maxPerMinute: 5, maxPerHour: 50, maxPerDay: 200 }],
    ];

    defaultLimits.forEach(([actionType, limit]) => {
      this.rateLimits.set(actionType, limit);
    });
  }

  /**
   * Register an action implementation
   */
  registerAction(action: BaseAction): void {
    this.actions[action.name] = action;
    this.log('debug', `Registered action: ${action.name} (${action.category})`);
  }

  /**
   * Register multiple actions at once
   */
  registerActions(actions: BaseAction[]): void {
    actions.forEach(action => this.registerAction(action));
  }

  /**
   * Execute a function call from OpenAI
   */
  async executeAction(functionCall: FunctionCall, context: ActionContext): Promise<ActionResult> {
    const startTime = Date.now();
    const actionType = functionCall.name as ActionType;

    try {
      this.log('debug', `Executing action: ${functionCall.name}`, { context: context.sessionId });

      // 1. Validate the function call
      const validation = this.validateFunctionCall(functionCall);
      if (!validation.valid) {
        throw new ActionValidationError(validation.errors || ['Unknown validation error']);
      }

      // 2. Check permissions
      if (this.config.enablePermissionChecking && !this.hasPermission(context.userId, actionType)) {
        throw new ActionPermissionError(actionType, context.userId);
      }

      // 3. Check rate limits
      if (this.config.enableRateLimiting && !this.checkRateLimit(context.userId, actionType)) {
        const limit = this.rateLimits.get(actionType);
        throw new ActionRateLimitError(actionType, `${limit?.maxPerMinute}/min, ${limit?.maxPerHour}/hour, ${limit?.maxPerDay}/day`);
      }

      // 4. Parse parameters
      const parameters = JSON.parse(functionCall.arguments);
      console.log(`[action-manager] Parsed parameters for ${functionCall.name}:`, JSON.stringify(parameters, null, 2));

      // 5. Get the action implementation
      const action = this.actions[functionCall.name];
      if (!action) {
        throw new ActionExecutionError(functionCall.name, new Error(`Action not implemented: ${functionCall.name}`));
      }

      // 6. Validate parameters against action schema
      const paramValidation = action.validate(parameters);
      if (!paramValidation.valid) {
        throw new ActionValidationError(paramValidation.errors || ['Parameter validation failed']);
      }

      // 7. Execute the action with timeout
      const result = await this.executeWithTimeout(action, parameters, context);

      // 8. Record successful execution
      this.recordExecution(context.userId, actionType);

      // 9. Log execution
      if (this.config.enableAuditLogging) {
        await this.logExecution(functionCall, context, result, Date.now() - startTime);
      }

      this.log('info', `Action completed: ${functionCall.name}`, { 
        success: result.success, 
        executionTimeMs: Date.now() - startTime 
      });

      return result;

    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      
      // Create error result
      const errorResult: ActionResult = {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        executionTimeMs
      };

      // Log error execution
      if (this.config.enableAuditLogging) {
        await this.logExecution(functionCall, context, errorResult, executionTimeMs, error instanceof Error ? error.message : String(error));
      }

      this.log('error', `Action failed: ${functionCall.name}`, { 
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs 
      });

      // Re-throw the error for OpenAI to handle
      throw error;
    }
  }

  /**
   * Execute action with timeout wrapper
   */
  private async executeWithTimeout(action: BaseAction, parameters: any, context: ActionContext): Promise<ActionResult> {
    const timeout = this.config.defaultTimeout || 30000;

    return new Promise<ActionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ActionExecutionError(action.name, new Error(`Action timeout after ${timeout}ms`)));
      }, timeout);

      action.execute(parameters, context)
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(new ActionExecutionError(action.name, error));
        });
    });
  }

  /**
   * Validate function call structure and arguments
   */
  private validateFunctionCall(functionCall: FunctionCall): ValidationResult {
    const errors: string[] = [];

    // Check if function exists
    if (!this.actions[functionCall.name]) {
      errors.push(`Unknown action: ${functionCall.name}`);
      return { valid: false, errors };
    }

    // Check if arguments is valid JSON
    try {
      JSON.parse(functionCall.arguments);
    } catch (error) {
      errors.push('Invalid JSON in function arguments');
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  /**
   * Check if user has permission to execute action
   */
  private hasPermission(userId: string, actionType: ActionType): boolean {
    const userPermissions = this.permissions.get(userId) || [];
    
    // If no specific permissions set, allow all actions (default behavior)
    if (userPermissions.length === 0) {
      return true;
    }

    const permission = userPermissions.find(p => p.actionType === actionType);
    if (!permission) {
      return false;
    }

    // Check if permission has expired
    if (permission.expiresAt && permission.expiresAt < Date.now()) {
      return false;
    }

    return permission.granted;
  }

  /**
   * Check rate limits for user and action
   */
  private checkRateLimit(userId: string, actionType: ActionType): boolean {
    const limit = this.rateLimits.get(actionType);
    if (!limit) {
      return true; // No limit set
    }

    const key = `${userId}:${actionType}`;
    let counts = this.executionCounts.get(key);
    const now = Date.now();

    if (!counts) {
      counts = { minute: 0, hour: 0, day: 0, lastReset: now };
      this.executionCounts.set(key, counts);
    }

    // Reset counters based on time elapsed
    const minutesElapsed = Math.floor((now - counts.lastReset) / (60 * 1000));
    const hoursElapsed = Math.floor((now - counts.lastReset) / (60 * 60 * 1000));
    const daysElapsed = Math.floor((now - counts.lastReset) / (24 * 60 * 60 * 1000));

    if (minutesElapsed >= 1) {
      counts.minute = 0;
    }
    if (hoursElapsed >= 1) {
      counts.hour = 0;
    }
    if (daysElapsed >= 1) {
      counts.day = 0;
    }

    // Check limits
    if (counts.minute >= limit.maxPerMinute) return false;
    if (counts.hour >= limit.maxPerHour) return false;
    if (counts.day >= limit.maxPerDay) return false;

    return true;
  }

  /**
   * Record successful execution for rate limiting
   */
  private recordExecution(userId: string, actionType: ActionType): void {
    const key = `${userId}:${actionType}`;
    const counts = this.executionCounts.get(key) || { minute: 0, hour: 0, day: 0, lastReset: Date.now() };
    
    counts.minute += 1;
    counts.hour += 1;
    counts.day += 1;
    counts.lastReset = Date.now();
    
    this.executionCounts.set(key, counts);
  }

  /**
   * Log action execution (will be enhanced to write to database)
   */
  private async logExecution(
    functionCall: FunctionCall,
    context: ActionContext,
    result: ActionResult,
    executionTimeMs: number,
    error?: string
  ): Promise<void> {
    const log: ActionExecutionLog = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      actionType: functionCall.name as ActionType,
      userId: context.userId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      parameters: JSON.parse(functionCall.arguments),
      result,
      timestamp: Date.now(),
      executionTimeMs,
      error
    };

    // For now, just log to console. In production, save to database
    this.log('info', 'Action execution logged', { 
      actionType: log.actionType, 
      success: log.result.success,
      executionTimeMs: log.executionTimeMs 
    });

    // TODO: Save to Supabase database
    // await this.saveExecutionLog(log);
  }

  /**
   * Grant permission to user for specific action
   */
  grantPermission(permission: ActionPermission): void {
    const userPermissions = this.permissions.get(permission.userId) || [];
    
    // Remove existing permission for this action type
    const filteredPermissions = userPermissions.filter(p => p.actionType !== permission.actionType);
    filteredPermissions.push(permission);
    
    this.permissions.set(permission.userId, filteredPermissions);
    
    this.log('info', `Permission granted: ${permission.actionType} for user ${permission.userId}`);
  }

  /**
   * Revoke permission from user for specific action
   */
  revokePermission(userId: string, actionType: ActionType): void {
    const userPermissions = this.permissions.get(userId) || [];
    const filteredPermissions = userPermissions.filter(p => p.actionType !== actionType);
    
    this.permissions.set(userId, filteredPermissions);
    
    this.log('info', `Permission revoked: ${actionType} for user ${userId}`);
  }

  /**
   * Update rate limit for action type
   */
  updateRateLimit(limit: ActionRateLimit): void {
    this.rateLimits.set(limit.actionType, limit);
    this.log('info', `Rate limit updated for ${limit.actionType}`, limit);
  }

  /**
   * Get current rate limit usage for user and action
   */
  getRateLimitUsage(userId: string, actionType: ActionType): { minute: number; hour: number; day: number; limits: ActionRateLimit | null } {
    const key = `${userId}:${actionType}`;
    const counts = this.executionCounts.get(key) || { minute: 0, hour: 0, day: 0, lastReset: Date.now() };
    const limits = this.rateLimits.get(actionType) || null;
    
    return { ...counts, limits };
  }

  /**
   * Get available actions for agent/user
   */
  getAvailableActions(context: Partial<ActionContext>): string[] {
    return Object.keys(this.actions).filter(actionName => {
      if (!context.userId) return true;
      return this.hasPermission(context.userId, actionName as ActionType);
    });
  }

  /**
   * Get action by name
   */
  getAction(name: string): BaseAction | undefined {
    return this.actions[name];
  }

  /**
   * Check if action exists
   */
  hasAction(name: string): boolean {
    return name in this.actions;
  }

  /**
   * Internal logging method
   */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: any): void {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const currentLevel = levels[this.config.logLevel || 'info'];
    
    if (levels[level] >= currentLevel) {
      const timestamp = new Date().toISOString();
      const logData = data ? ` ${JSON.stringify(data)}` : '';
      console.log(`[${timestamp}] [action-manager] [${level.toUpperCase()}] ${message}${logData}`);
    }
  }

  /**
   * Get execution statistics
   */
  getExecutionStats(): { totalActions: number; actionTypes: string[]; totalExecutions: number } {
    const totalExecutions = Array.from(this.executionCounts.values())
      .reduce((sum, counts) => sum + counts.day, 0);
    
    return {
      totalActions: Object.keys(this.actions).length,
      actionTypes: Object.keys(this.actions),
      totalExecutions
    };
  }

  /**
   * Reset rate limiting counters (useful for testing)
   */
  resetRateLimits(): void {
    this.executionCounts.clear();
    this.log('info', 'Rate limit counters reset');
  }

  /**
   * Enable/disable specific features
   */
  updateConfig(config: Partial<ActionManagerConfig>): void {
    this.config = { ...this.config, ...config };
    this.log('info', 'Configuration updated', config);
  }
}