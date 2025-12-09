/**
 * Policy Enforcement Engine
 */

import {
    Policy,
    PolicyAllow,
    PolicyDeny,
    ResourceLimits,
    Permission
} from 'core/dist/ir.js';

export class PolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PolicyError';
    }
}

export class PolicyEnforcer {
    constructor(private policy: Policy) {}

    /**
     * Check if a tool is allowed
     */
    checkToolAccess(toolId: string): void {
        // Check deny list first (deny takes precedence)
        if (this.policy.deny?.tools?.includes(toolId)) {
            throw new PolicyError(`Tool "${toolId}" is explicitly denied by policy`);
        }

        // Check allow list if it exists
        if (this.policy.allow?.tools) {
            if (!this.policy.allow.tools.includes(toolId)) {
                throw new PolicyError(`Tool "${toolId}" is not in the allowed tools list`);
            }
        }
    }

    /**
     * Check if a workflow is allowed
     */
    checkWorkflowAccess(workflowId: string): void {
        // Check deny list first
        if (this.policy.deny?.workflows?.includes(workflowId)) {
            throw new PolicyError(`Workflow "${workflowId}" is explicitly denied by policy`);
        }

        // Check allow list if it exists
        if (this.policy.allow?.workflows) {
            if (!this.policy.allow.workflows.includes(workflowId)) {
                throw new PolicyError(`Workflow "${workflowId}" is not in the allowed workflows list`);
            }
        }
    }

    /**
     * Check if data access is allowed
     */
    checkDataAccess(dataId: string): void {
        // Check deny list first
        if (this.policy.deny?.data?.includes(dataId)) {
            throw new PolicyError(`Data "${dataId}" is explicitly denied by policy`);
        }

        // Check allow list if it exists
        if (this.policy.allow?.data) {
            if (!this.policy.allow.data.includes(dataId)) {
                throw new PolicyError(`Data "${dataId}" is not in the allowed data list`);
            }
        }
    }

    /**
     * Check if a capability is allowed
     */
    checkCapabilityAccess(capabilityId: string): void {
        // Check allow list if it exists
        if (this.policy.allow?.capabilities) {
            if (!this.policy.allow.capabilities.includes(capabilityId)) {
                throw new PolicyError(`Capability "${capabilityId}" is not in the allowed capabilities list`);
            }
        }
    }

    /**
     * Get resource limits
     */
    getLimits(): ResourceLimits | undefined {
        return this.policy.limits;
    }

    /**
     * Check if memory limit is exceeded
     */
    checkMemoryLimit(usedMemoryMb: number): void {
        const limit = this.policy.limits?.max_memory_mb;
        if (limit && usedMemoryMb > limit) {
            throw new PolicyError(`Memory limit exceeded: ${usedMemoryMb}MB > ${limit}MB`);
        }
    }

    /**
     * Check if execution time limit is exceeded
     */
    checkExecutionTimeLimit(executionTimeMs: number): void {
        const limit = this.policy.limits?.max_execution_time;
        if (limit && executionTimeMs > limit) {
            throw new PolicyError(`Execution time limit exceeded: ${executionTimeMs}ms > ${limit}ms`);
        }
    }

    /**
     * Check if tool calls limit is exceeded
     */
    checkToolCallsLimit(toolCallCount: number): void {
        const limit = this.policy.limits?.max_tool_calls;
        if (limit && toolCallCount > limit) {
            throw new PolicyError(`Tool calls limit exceeded: ${toolCallCount} > ${limit}`);
        }
    }

    /**
     * Check if workflow depth limit is exceeded
     */
    checkWorkflowDepthLimit(depth: number): void {
        const limit = this.policy.limits?.max_workflow_depth;
        if (limit && depth > limit) {
            throw new PolicyError(`Workflow depth limit exceeded: ${depth} > ${limit}`);
        }
    }
}

/**
 * Permission checker for capability requirements
 */
export class PermissionChecker {
    constructor(private grantedPermissions: Permission[]) {}

    /**
     * Check if a permission is granted
     */
    hasPermission(required: Permission): boolean {
        return this.grantedPermissions.some(
            granted =>
                granted.resource === required.resource &&
                (granted.action === required.action || granted.action === 'admin')
        );
    }

    /**
     * Check if all required permissions are granted
     */
    hasAllPermissions(required: Permission[]): boolean {
        return required.every(perm => this.hasPermission(perm));
    }

    /**
     * Check permissions and throw if not granted
     */
    checkPermissions(required: Permission[]): void {
        const missing = required.filter(perm => !this.hasPermission(perm));

        if (missing.length > 0) {
            const missingStr = missing
                .map(p => `${p.resource}:${p.action}`)
                .join(', ');
            throw new PolicyError(`Missing required permissions: ${missingStr}`);
        }
    }
}
