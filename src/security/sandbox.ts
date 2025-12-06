/**
 * Tool Sandbox - Secure tool execution with validation and resource limits
 */

import {
    ToolSecurityConfig,
    ValidationRules,
    FieldValidation,
    SandboxConfig,
    OutputValidation
} from 'core/dist/ir.js';

export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValidationError';
    }
}

export class SandboxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SandboxError';
    }
}

/**
 * Input validator
 */
export class InputValidator {
    constructor(private rules?: ValidationRules) {}

    /**
     * Validate input against rules
     */
    validate(input: Record<string, any>): void {
        if (!this.rules) return;

        for (const [fieldName, value] of Object.entries(input)) {
            const fieldRules = this.rules[fieldName];
            if (!fieldRules) continue;

            this.validateField(fieldName, value, fieldRules);
        }
    }

    private validateField(fieldName: string, value: any, rules: FieldValidation): void {
        // String validations
        if (typeof value === 'string') {
            if (rules.max_length && value.length > rules.max_length) {
                throw new ValidationError(
                    `Field "${fieldName}" exceeds max length: ${value.length} > ${rules.max_length}`
                );
            }

            if (rules.min_length && value.length < rules.min_length) {
                throw new ValidationError(
                    `Field "${fieldName}" below min length: ${value.length} < ${rules.min_length}`
                );
            }

            if (rules.pattern) {
                const regex = new RegExp(rules.pattern);
                if (!regex.test(value)) {
                    throw new ValidationError(
                        `Field "${fieldName}" does not match pattern: ${rules.pattern}`
                    );
                }
            }

            if (rules.deny_patterns) {
                for (const pattern of rules.deny_patterns) {
                    const regex = new RegExp(pattern);
                    if (regex.test(value)) {
                        throw new ValidationError(
                            `Field "${fieldName}" matches denied pattern: ${pattern}`
                        );
                    }
                }
            }
        }

        // Number validations
        if (typeof value === 'number') {
            if (rules.min !== undefined && value < rules.min) {
                throw new ValidationError(
                    `Field "${fieldName}" below minimum: ${value} < ${rules.min}`
                );
            }

            if (rules.max !== undefined && value > rules.max) {
                throw new ValidationError(
                    `Field "${fieldName}" exceeds maximum: ${value} > ${rules.max}`
                );
            }
        }
    }
}

/**
 * Output validator
 */
export class OutputValidator {
    constructor(private config?: OutputValidation) {}

    /**
     * Validate output
     */
    validate(output: any): void {
        if (!this.config) return;

        // Check output size
        if (this.config.max_size_kb) {
            const outputStr = JSON.stringify(output);
            const sizeKb = new Blob([outputStr]).size / 1024;

            if (sizeKb > this.config.max_size_kb) {
                throw new ValidationError(
                    `Output size exceeds limit: ${sizeKb.toFixed(2)}KB > ${this.config.max_size_kb}KB`
                );
            }
        }

        // Schema validation would go here if config.schema is set
        // For now, just pass through
    }
}

/**
 * Sandboxed tool executor
 */
export class ToolSandbox {
    private inputValidator: InputValidator;
    private outputValidator: OutputValidator;

    constructor(private securityConfig?: ToolSecurityConfig) {
        this.inputValidator = new InputValidator(securityConfig?.validate);
        this.outputValidator = new OutputValidator(securityConfig?.output);
    }

    /**
     * Execute a tool function in a sandbox
     */
    async execute<T = any>(
        toolFn: (input: any) => Promise<T>,
        input: Record<string, any>
    ): Promise<T> {
        // 1. Validate input
        this.inputValidator.validate(input);

        // 2. Apply sandbox configuration
        const config = this.securityConfig?.sandbox;
        if (!config) {
            // No sandbox config, execute directly
            const output = await toolFn(input);
            this.outputValidator.validate(output);
            return output;
        }

        // 3. Execute with timeout
        const timeout = config.timeout_ms || 30000;
        const output = await this.executeWithTimeout(toolFn, input, timeout);

        // 4. Validate output
        this.outputValidator.validate(output);

        return output;
    }

    private async executeWithTimeout<T>(
        fn: (input: any) => Promise<T>,
        input: any,
        timeoutMs: number
    ): Promise<T> {
        return Promise.race([
            fn(input),
            new Promise<T>((_, reject) =>
                setTimeout(
                    () => reject(new SandboxError(`Tool execution timeout after ${timeoutMs}ms`)),
                    timeoutMs
                )
            )
        ]);
    }

    /**
     * Check network access
     */
    checkNetworkAccess(host: string): void {
        const config = this.securityConfig?.sandbox;
        if (!config) return;

        if (!config.network_allowed) {
            throw new SandboxError('Network access is not allowed by sandbox policy');
        }

        if (config.network_hosts && config.network_hosts.length > 0) {
            const allowed = config.network_hosts.some((allowedHost: string) => {
                // Simple host matching (could be enhanced with wildcard support)
                return host === allowedHost || host.endsWith(`.${allowedHost}`);
            });

            if (!allowed) {
                throw new SandboxError(
                    `Network access to "${host}" is not allowed. Allowed hosts: ${config.network_hosts.join(', ')}`
                );
            }
        }
    }

    /**
     * Check filesystem access
     */
    checkFilesystemAccess(path: string, write: boolean = false): void {
        const config = this.securityConfig?.sandbox;
        if (!config) return;

        if (!config.filesystem_allowed) {
            throw new SandboxError('Filesystem access is not allowed by sandbox policy');
        }

        if (write && config.filesystem_mode === 'readonly') {
            throw new SandboxError('Filesystem is in readonly mode, write access denied');
        }

        if (config.filesystem_paths && config.filesystem_paths.length > 0) {
            const allowed = config.filesystem_paths.some((allowedPath: string) => {
                return path.startsWith(allowedPath);
            });

            if (!allowed) {
                throw new SandboxError(
                    `Filesystem access to "${path}" is not allowed. Allowed paths: ${config.filesystem_paths.join(', ')}`
                );
            }
        }
    }

    /**
     * Get sandbox configuration
     */
    getConfig(): SandboxConfig | undefined {
        return this.securityConfig?.sandbox;
    }
}
