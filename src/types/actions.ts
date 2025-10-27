// External Actions Type Definitions
// Phase 1, Task 1.1: Core type definitions for OpenAI function calling integration

import { z } from 'zod';

// ===== ACTION CATEGORIES =====
export enum ActionCategory {
  COMMUNICATION = 'communication',    // Email, Slack, SMS
  SCHEDULING = 'scheduling',          // Calendar, meetings
  DATA = 'data',                     // Notes, CRM updates  
  WORKFLOW = 'workflow',             // Complex multi-step processes
  INTEGRATION = 'integration'        // Third-party service calls
}

// ===== ACTION CONTEXT =====
export interface ActionContext {
  userId: string;
  agentId: string;
  sessionId: string;
  organizationId?: string;
  permissions: string[];
  userEmail?: string;
  userName?: string;
  timestamp: number;
}

// ===== ACTION RESULT =====
export interface ActionResult {
  success: boolean;
  data?: any;
  message: string;
  actionId?: string;
  executionTimeMs?: number;
  metadata?: Record<string, any>;
}

// ===== FUNCTION CALL INTERFACE =====
// Matches OpenAI function call format
export interface FunctionCall {
  name: string;
  arguments: string; // JSON string of parameters
}

// ===== FUNCTION SCHEMA =====
// OpenAI function definition schema
export interface FunctionSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      format?: string;
      minimum?: number;
      maximum?: number;
      minLength?: number;
      maxLength?: number;
      items?: any;
    }>;
    required: string[];
  };
}

// ===== ACTION TYPE ENUM =====
export enum ActionType {
  // Communication Actions
  SEND_EMAIL = 'send_email',
  SEND_SLACK = 'send_slack_message',
  SEND_SMS = 'send_sms',
  
  // Scheduling Actions  
  BOOK_MEETING = 'book_meeting',
  RESCHEDULE_MEETING = 'reschedule_meeting',
  CANCEL_MEETING = 'cancel_meeting',
  CHECK_AVAILABILITY = 'check_availability',
  
  // Data Actions
  CREATE_NOTE = 'create_note',
  UPDATE_NOTE = 'update_note',
  SEARCH_NOTES = 'search_notes',
  
  // CRM Actions
  CREATE_CONTACT = 'create_contact',
  UPDATE_CONTACT = 'update_contact',
  CREATE_LEAD = 'create_lead',
  UPDATE_DEAL = 'update_deal',
  
  // Workflow Actions (via n8n)
  TRIGGER_WORKFLOW = 'trigger_workflow',
  CHECK_WORKFLOW_STATUS = 'check_workflow_status'
}

// ===== PARAMETER VALIDATION SCHEMAS =====

// Email Action Parameters
export const EmailActionSchema = z.object({
  to: z.array(z.string().email()).min(1).max(10),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  attachments: z.array(z.string()).optional()
});

// Slack Message Parameters
export const SlackActionSchema = z.object({
  channel: z.string().min(1),
  message: z.string().min(1).max(4000),
  threadTs: z.string().optional(),
  blocks: z.array(z.any()).optional(),
  attachments: z.array(z.any()).optional()
});

// Meeting Booking Parameters
export const MeetingActionSchema = z.object({
  title: z.string().min(1).max(100),
  startDateTime: z.string().datetime(),
  durationMinutes: z.number().min(15).max(480),
  attendees: z.array(z.string().email()),
  location: z.string().optional(),
  agenda: z.string().max(1000).optional(),
  meetingType: z.enum(['in_person', 'virtual', 'phone']).default('virtual'),
  recurrence: z.object({
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    interval: z.number().min(1).max(30),
    endDate: z.string().datetime().optional()
  }).optional()
});

// Notes Action Parameters
export const NotesActionSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(50000),
  tags: z.array(z.string()).optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  category: z.string().optional(),
  isPrivate: z.boolean().default(false)
});

// Contact Action Parameters
export const ContactActionSchema = z.object({
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
  email: z.string().email(),
  phone: z.string().optional(),
  company: z.string().optional(),
  jobTitle: z.string().optional(),
  notes: z.string().optional()
});

// Workflow Action Parameters
export const WorkflowActionSchema = z.object({
  workflowId: z.string().min(1),
  parameters: z.record(z.any()),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  timeout: z.number().min(1000).max(300000).default(30000)
});

// ===== ACTION PARAMETER TYPES =====
export type EmailActionParams = z.infer<typeof EmailActionSchema>;
export type SlackActionParams = z.infer<typeof SlackActionSchema>;
export type MeetingActionParams = z.infer<typeof MeetingActionSchema>;
export type NotesActionParams = z.infer<typeof NotesActionSchema>;
export type ContactActionParams = z.infer<typeof ContactActionSchema>;
export type WorkflowActionParams = z.infer<typeof WorkflowActionSchema>;

// ===== BASE ACTION INTERFACE =====
export interface BaseAction {
  name: string;
  description: string;
  category: ActionCategory;
  schema: FunctionSchema;
  
  execute(params: any, context: ActionContext): Promise<ActionResult>;
  validate(params: any): { valid: boolean; errors?: string[] };
  getRequiredPermissions(): string[];
}

// ===== ACTION EXECUTION LOG =====
export interface ActionExecutionLog {
  id: string;
  actionType: ActionType;
  userId: string;
  agentId: string;
  sessionId: string;
  parameters: any;
  result: ActionResult;
  timestamp: number;
  executionTimeMs: number;
  error?: string;
}

// ===== ACTION RATE LIMITING =====
export interface ActionRateLimit {
  actionType: ActionType;
  maxPerMinute: number;
  maxPerHour: number;
  maxPerDay: number;
}

// ===== ACTION PERMISSIONS =====
export interface ActionPermission {
  userId: string;
  actionType: ActionType;
  granted: boolean;
  restrictions?: {
    maxPerDay?: number;
    allowedTargets?: string[]; // For email: allowed domains, etc.
    requireApproval?: boolean;
  };
  grantedBy?: string;
  grantedAt: number;
  expiresAt?: number;
}

// ===== VALIDATION RESULT =====
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

// ===== ERROR TYPES =====
export class ActionValidationError extends Error {
  constructor(public errors: string[]) {
    super(`Action validation failed: ${errors.join(', ')}`);
    this.name = 'ActionValidationError';
  }
}

export class ActionPermissionError extends Error {
  constructor(actionType: string, userId: string) {
    super(`User ${userId} does not have permission to execute ${actionType}`);
    this.name = 'ActionPermissionError';
  }
}

export class ActionRateLimitError extends Error {
  constructor(actionType: string, limit: string) {
    super(`Rate limit exceeded for ${actionType}: ${limit}`);
    this.name = 'ActionRateLimitError';
  }
}

export class ActionExecutionError extends Error {
  public cause?: Error;
  
  constructor(actionType: string, originalError: Error) {
    super(`Failed to execute ${actionType}: ${originalError.message}`);
    this.name = 'ActionExecutionError';
    this.cause = originalError;
  }
}