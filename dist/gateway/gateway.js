/**
 * Model Gateway - Provider orchestration with fallback and strategy
 */
import { ProviderRegistry, RateLimiter, DefaultCredentialResolver } from './provider.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
export class ModelGateway {
    constructor(providers, credentialResolver) {
        this.rateLimiters = new Map();
        this.usageStats = new Map();
        this.registry = new ProviderRegistry();
        this.credentialResolver = credentialResolver || new DefaultCredentialResolver();
        // Initialize providers
        this.initializeProviders(providers);
    }
    async initializeProviders(providers) {
        for (const providerConfig of providers) {
            try {
                const provider = await this.createProvider(providerConfig);
                this.registry.register(providerConfig.id, provider);
                // Setup rate limiting
                if (providerConfig.limits) {
                    this.rateLimiters.set(providerConfig.id, new RateLimiter(providerConfig.limits));
                }
                // Initialize usage stats
                this.usageStats.set(providerConfig.id, {
                    requests: 0,
                    tokens: 0,
                    errors: 0
                });
            }
            catch (error) {
                console.error(`Failed to initialize provider ${providerConfig.id}:`, error);
            }
        }
    }
    async createProvider(config) {
        // Resolve credentials
        let apiKey;
        if (config.credentials) {
            if ('type' in config.credentials) {
                // CredentialReference
                const ref = config.credentials;
                if (ref.type === 'env') {
                    apiKey = this.credentialResolver.getEnv(ref.ref);
                }
                else if (ref.type === 'secrets') {
                    apiKey = await this.credentialResolver.getSecret(ref.ref);
                }
            }
            else {
                // CredentialBlock - resolve each key
                for (const [key, value] of Object.entries(config.credentials)) {
                    const credRef = value;
                    if ('type' in credRef && 'ref' in credRef) {
                        if (credRef.type === 'env') {
                            apiKey = this.credentialResolver.getEnv(credRef.ref);
                        }
                        else if (credRef.type === 'secrets') {
                            apiKey = await this.credentialResolver.getSecret(credRef.ref);
                        }
                        break; // Use first credential for now
                    }
                }
            }
        }
        if (!apiKey) {
            throw new Error(`No credentials found for provider ${config.id}`);
        }
        // Create provider instance based on type
        const endpoint = config.config?.endpoint;
        const timeout = config.config?.timeout;
        switch (config.type) {
            case 'llm':
                // Detect provider type from id or name
                const providerName = config.name.toLowerCase();
                if (providerName.includes('openai') || config.id.includes('openai')) {
                    return new OpenAIProvider(apiKey, endpoint, timeout);
                }
                else if (providerName.includes('anthropic') || config.id.includes('anthropic')) {
                    return new AnthropicProvider(apiKey, endpoint, timeout);
                }
                else {
                    throw new Error(`Unknown LLM provider: ${config.name}`);
                }
            default:
                throw new Error(`Unsupported provider type: ${config.type}`);
        }
    }
    /**
     * Complete a request using the specified model configuration
     */
    async complete(modelConfig, messages, params) {
        // Simple string model (backward compatibility)
        if (typeof modelConfig === 'string') {
            const [providerId, modelName] = modelConfig.split('/');
            return this.completeWithProvider(providerId, modelName, messages, params);
        }
        // Advanced model config with fallback
        const strategy = modelConfig.strategy || 'failover';
        const providers = [modelConfig.primary, ...(modelConfig.fallback || [])];
        return this.completeWithStrategy(strategy, providers, messages, params);
    }
    async completeWithStrategy(strategy, providers, messages, params) {
        switch (strategy) {
            case 'failover':
                return this.failoverStrategy(providers, messages, params);
            case 'cost_optimized':
                return this.costOptimizedStrategy(providers, messages, params);
            case 'latency_optimized':
                return this.latencyOptimizedStrategy(providers, messages, params);
            case 'round_robin':
                return this.roundRobinStrategy(providers, messages, params);
            default:
                return this.failoverStrategy(providers, messages, params);
        }
    }
    async failoverStrategy(providers, messages, params) {
        let lastError;
        for (const providerConfig of providers) {
            try {
                const providerId = this.extractProviderId(providerConfig.provider);
                return await this.completeWithProvider(providerId, providerConfig.name, messages, { ...params, ...providerConfig.params });
            }
            catch (error) {
                lastError = error;
                console.warn(`Provider ${providerConfig.provider} failed, trying next...`);
            }
        }
        throw new Error(`All providers failed. Last error: ${lastError?.message}`);
    }
    async costOptimizedStrategy(providers, messages, params) {
        // Sort by cost (simple heuristic: smaller models are cheaper)
        // In production, use actual pricing data
        const sorted = [...providers].sort((a, b) => {
            const aCost = this.estimateCost(a.name);
            const bCost = this.estimateCost(b.name);
            return aCost - bCost;
        });
        return this.failoverStrategy(sorted, messages, params);
    }
    async latencyOptimizedStrategy(providers, messages, params) {
        // In production, track latency stats and sort by historical performance
        // For now, just use failover
        return this.failoverStrategy(providers, messages, params);
    }
    async roundRobinStrategy(providers, messages, params) {
        // Simple round-robin: use index based on request count
        const totalRequests = Array.from(this.usageStats.values())
            .reduce((sum, stats) => sum + stats.requests, 0);
        const index = totalRequests % providers.length;
        const providerConfig = providers[index];
        const providerId = this.extractProviderId(providerConfig.provider);
        return this.completeWithProvider(providerId, providerConfig.name, messages, { ...params, ...providerConfig.params });
    }
    async completeWithProvider(providerId, modelName, messages, params) {
        const provider = this.registry.get(providerId);
        if (!provider) {
            throw new Error(`Provider not found: ${providerId}`);
        }
        // Apply rate limiting
        const limiter = this.rateLimiters.get(providerId);
        if (limiter) {
            await limiter.acquire();
        }
        // Track usage
        const stats = this.usageStats.get(providerId);
        stats.requests++;
        try {
            const request = {
                messages,
                model: modelName,
                ...params
            };
            const response = await provider.complete(request);
            // Track token usage
            if (response.usage) {
                stats.tokens += response.usage.total_tokens;
            }
            return response;
        }
        catch (error) {
            stats.errors++;
            throw error;
        }
    }
    extractProviderId(providerRef) {
        // Extract ID from reference like "provider.openai"
        const parts = providerRef.split('.');
        return parts[parts.length - 1];
    }
    estimateCost(modelName) {
        // Simple cost heuristic (lower is cheaper)
        // In production, use actual pricing data
        const name = modelName.toLowerCase();
        if (name.includes('gpt-4'))
            return 100;
        if (name.includes('gpt-3.5'))
            return 10;
        if (name.includes('claude-3-opus'))
            return 100;
        if (name.includes('claude-3-sonnet'))
            return 50;
        if (name.includes('claude-3-haiku'))
            return 10;
        return 50; // Default mid-range
    }
    /**
     * Get usage statistics
     */
    getUsageStats() {
        return Object.fromEntries(this.usageStats);
    }
    /**
     * Check provider availability
     */
    async checkProviders() {
        const results = {};
        for (const providerId of this.registry.list()) {
            const provider = this.registry.get(providerId);
            results[providerId] = await provider.isAvailable();
        }
        return results;
    }
}
