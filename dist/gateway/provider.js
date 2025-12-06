/**
 * Model Provider Abstraction
 *
 * Universal interface for LLM providers (OpenAI, Anthropic, Google, local models, etc.)
 */
// Default credential resolver using process.env
export class DefaultCredentialResolver {
    getEnv(varName) {
        return process.env[varName];
    }
    async getSecret(secretName) {
        // In the future, integrate with secrets managers (AWS Secrets Manager, etc.)
        // For now, fall back to environment variables
        return process.env[secretName];
    }
}
// Provider registry
export class ProviderRegistry {
    constructor() {
        this.providers = new Map();
    }
    register(name, provider) {
        this.providers.set(name, provider);
    }
    get(name) {
        return this.providers.get(name);
    }
    has(name) {
        return this.providers.has(name);
    }
    list() {
        return Array.from(this.providers.keys());
    }
}
// Rate limiter (simple token bucket implementation)
export class RateLimiter {
    constructor(limits, maxTokens = 60) {
        this.limits = limits;
        this.maxTokens = maxTokens;
        this.tokens = maxTokens;
        this.lastRefill = Date.now();
    }
    async acquire() {
        this.refill();
        if (this.tokens < 1) {
            const waitTime = this.getWaitTime();
            await new Promise(resolve => setTimeout(resolve, waitTime));
            this.refill();
        }
        this.tokens--;
    }
    refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        // Refill tokens based on requests_per_minute
        if (this.limits.requests_per_minute) {
            const tokensToAdd = (elapsed / 60000) * this.limits.requests_per_minute;
            this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
            this.lastRefill = now;
        }
    }
    getWaitTime() {
        if (this.limits.requests_per_minute) {
            return (60000 / this.limits.requests_per_minute);
        }
        return 1000; // Default 1 second
    }
}
