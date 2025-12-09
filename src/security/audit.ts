/**
 * Audit Logging
 */

import { AuditConfig } from 'core/dist/ir.js';
import * as fs from 'fs';

export interface AuditEvent {
    timestamp: string;
    event: string;
    agent?: string;
    tool?: string;
    workflow?: string;
    user?: string;
    success: boolean;
    error?: string;
    payload?: any;
    metadata?: Record<string, any>;
}

export class AuditLogger {
    private logStream?: fs.WriteStream;

    constructor(private config: AuditConfig) {
        this.initializeLogger();
    }

    private initializeLogger(): void {
        if (!this.config.enabled) return;

        // Parse destination
        const destination = this.config.destination || 'file://./audit.log';

        if (destination.startsWith('file://')) {
            const filePath = destination.replace('file://', '');
            this.logStream = fs.createWriteStream(filePath, { flags: 'a' });
        }
        // In the future, support syslog://, http://, etc.
    }

    /**
     * Log an audit event
     */
    log(event: Partial<AuditEvent>): void {
        if (!this.config.enabled) return;

        // Check if this event type should be logged
        if (this.config.log_events && !this.config.log_events.includes(event.event || '')) {
            return;
        }

        const auditEvent: AuditEvent = {
            timestamp: new Date().toISOString(),
            event: event.event || 'unknown',
            success: event.success ?? true,
            agent: event.agent,
            tool: event.tool,
            workflow: event.workflow,
            user: event.user,
            error: event.error,
            metadata: event.metadata
        };

        // Include payload if configured
        if (this.config.include_payloads && event.payload) {
            auditEvent.payload = event.payload;
        }

        this.writeLog(auditEvent);
    }

    private writeLog(event: AuditEvent): void {
        const format = this.config.format || 'json';

        let logLine: string;
        switch (format) {
            case 'json':
                logLine = JSON.stringify(event);
                break;

            case 'text':
                logLine = this.formatAsText(event);
                break;

            case 'cef':
                logLine = this.formatAsCEF(event);
                break;

            default:
                logLine = JSON.stringify(event);
        }

        if (this.logStream) {
            this.logStream.write(logLine + '\n');
        } else {
            console.log('[AUDIT]', logLine);
        }
    }

    private formatAsText(event: AuditEvent): string {
        const parts = [
            event.timestamp,
            event.event,
            event.success ? 'SUCCESS' : 'FAILURE'
        ];

        if (event.agent) parts.push(`agent=${event.agent}`);
        if (event.tool) parts.push(`tool=${event.tool}`);
        if (event.workflow) parts.push(`workflow=${event.workflow}`);
        if (event.user) parts.push(`user=${event.user}`);
        if (event.error) parts.push(`error="${event.error}"`);

        return parts.join(' | ');
    }

    private formatAsCEF(event: AuditEvent): string {
        // Common Event Format (CEF)
        // CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
        const extension = [];
        if (event.agent) extension.push(`agent=${event.agent}`);
        if (event.tool) extension.push(`tool=${event.tool}`);
        if (event.workflow) extension.push(`workflow=${event.workflow}`);
        if (event.user) extension.push(`suser=${event.user}`);

        const severity = event.success ? '3' : '7'; // 3=Low, 7=High

        return [
            'CEF:1',
            'A22',
            'Runtime',
            '1.0',
            event.event,
            event.event,
            severity,
            extension.join(' ')
        ].join('|');
    }

    /**
     * Log tool execution
     */
    logToolCall(toolId: string, agent: string, success: boolean, error?: string): void {
        this.log({
            event: 'tool.call',
            tool: toolId,
            agent,
            success,
            error
        });
    }

    /**
     * Log permission denial
     */
    logPermissionDenied(resource: string, action: string, agent: string): void {
        this.log({
            event: 'permission.denied',
            agent,
            success: false,
            metadata: { resource, action }
        });
    }

    /**
     * Log credential access
     */
    logCredentialAccess(provider: string, agent?: string): void {
        this.log({
            event: 'credential.access',
            agent,
            success: true,
            metadata: { provider }
        });
    }

    /**
     * Log policy violation
     */
    logPolicyViolation(policyId: string, agent: string, violation: string): void {
        this.log({
            event: 'policy.violation',
            agent,
            success: false,
            metadata: { policyId, violation }
        });
    }

    /**
     * Log workflow execution
     */
    logWorkflowExecution(workflowId: string, success: boolean, error?: string): void {
        this.log({
            event: 'workflow.execution',
            workflow: workflowId,
            success,
            error
        });
    }

    /**
     * Close the logger
     */
    close(): void {
        if (this.logStream) {
            this.logStream.end();
        }
    }
}

/**
 * Create a no-op audit logger for when auditing is disabled
 */
export class NoOpAuditLogger extends AuditLogger {
    constructor() {
        super({ enabled: false });
    }

    log(): void {
        // No-op
    }
}
