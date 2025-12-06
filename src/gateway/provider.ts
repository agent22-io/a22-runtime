/**
 * Model Provider Abstraction
 *
 * Universal interface for LLM providers (OpenAI, Anthropic, Google, local models, etc.)
 */

import { Provider as IRProvider, ModelProviderConfig, RateLimits } from 'core/dist/ir.js';

// Provider message format (universal)
export interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

// Provider request
export interface ProviderRequest {
    messages: Message[];
    model: string;
    temperature?: number;
    max_tokens?: number;
    stop?: string[];
    stream?: boolean;
    [key: string]: any; // Provider-specific params
}

// Provider response
export interface ProviderResponse {
    content: string;
    model: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    finish_reason?: string;
}

// Base provider interface
export interface IModelProvider {
    readonly name: string;
    readonly type: IRProvider['type'];

    /**
     * Generate completion
     */
    complete(request: ProviderRequest): Promise<ProviderResponse>;

    /**
     * Check if provider is available
     */
    isAvailable(): Promise<boolean>;
}

// Credentials resolver
export interface CredentialResolver {
    /**
     * Resolve environment variable
     */
    getEnv(varName: string): string | undefined;

    /**
     * Resolve secret from secrets manager
     */
    getSecret(secretName: string): Promise<string | undefined>;
}

// Default credential resolver using process.env
export class DefaultCredentialResolver implements CredentialResolver {
    getEnv(varName: string): string | undefined {
        return process.env[varName];
    }

    async getSecret(secretName: string): Promise<string | undefined> {
        // In the future, integrate with secrets managers (AWS Secrets Manager, etc.)
        // For now, fall back to environment variables
        return process.env[secretName];
    }
}

// Provider registry
export class ProviderRegistry {
    private providers = new Map<string, IModelProvider>();

    register(name: string, provider: IModelProvider): void {
        this.providers.set(name, provider);
    }

    get(name: string): IModelProvider | undefined {
        return this.providers.get(name);
    }

    has(name: string): boolean {
        return this.providers.has(name);
    }

    list(): string[] {
        return Array.from(this.providers.keys());
    }
}

// Rate limiter (simple token bucket implementation)
export class RateLimiter {
    private tokens: number;
    private lastRefill: number;

    constructor(
        private limits: RateLimits,
        private maxTokens: number = 60
    ) {
        this.tokens = maxTokens;
        this.lastRefill = Date.now();
    }

    async acquire(): Promise<void> {
        this.refill();

        if (this.tokens < 1) {
            const waitTime = this.getWaitTime();
            await new Promise(resolve => setTimeout(resolve, waitTime));
            this.refill();
        }

        this.tokens--;
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;

        // Refill tokens based on requests_per_minute
        if (this.limits.requests_per_minute) {
            const tokensToAdd = (elapsed / 60000) * this.limits.requests_per_minute;
            this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
            this.lastRefill = now;
        }
    }

    private getWaitTime(): number {
        if (this.limits.requests_per_minute) {
            return (60000 / this.limits.requests_per_minute);
        }
        return 1000; // Default 1 second
    }
}
