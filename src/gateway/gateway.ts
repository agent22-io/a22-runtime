/**
 * Model Gateway - Provider orchestration with fallback and strategy
 */

import {
    Provider as IRProvider,
    AdvancedModelConfig,
    ModelProviderConfig,
    CredentialReference
} from 'core/dist/ir.js';
import {
    IModelProvider,
    ProviderRequest,
    ProviderResponse,
    ProviderRegistry,
    RateLimiter,
    CredentialResolver,
    DefaultCredentialResolver
} from './provider.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';

export class ModelGateway {
    private registry: ProviderRegistry;
    private rateLimiters = new Map<string, RateLimiter>();
    private credentialResolver: CredentialResolver;
    private usageStats = new Map<string, {
        requests: number;
        tokens: number;
        errors: number;
    }>();

    constructor(
        providers: IRProvider[],
        credentialResolver?: CredentialResolver
    ) {
        this.registry = new ProviderRegistry();
        this.credentialResolver = credentialResolver || new DefaultCredentialResolver();

        // Initialize providers
        this.initializeProviders(providers);
    }

    private async initializeProviders(providers: IRProvider[]): Promise<void> {
        for (const providerConfig of providers) {
            try {
                const provider = await this.createProvider(providerConfig);
                this.registry.register(providerConfig.id, provider);

                // Setup rate limiting
                if (providerConfig.limits) {
                    this.rateLimiters.set(
                        providerConfig.id,
                        new RateLimiter(providerConfig.limits)
                    );
                }

                // Initialize usage stats
                this.usageStats.set(providerConfig.id, {
                    requests: 0,
                    tokens: 0,
                    errors: 0
                });
            } catch (error) {
                console.error(`Failed to initialize provider ${providerConfig.id}:`, error);
            }
        }
    }

    private async createProvider(config: IRProvider): Promise<IModelProvider> {
        // Resolve credentials
        let apiKey: string | undefined;

        if (config.credentials) {
            if ('type' in config.credentials) {
                // CredentialReference
                const ref = config.credentials as CredentialReference;
                if (ref.type === 'env') {
                    apiKey = this.credentialResolver.getEnv(ref.ref);
                } else if (ref.type === 'secrets') {
                    apiKey = await this.credentialResolver.getSecret(ref.ref);
                }
            } else {
                // CredentialBlock - resolve each key
                for (const [key, value] of Object.entries(config.credentials)) {
                    const credRef = value as CredentialReference;
                    if ('type' in credRef && 'ref' in credRef) {
                        if (credRef.type === 'env') {
                            apiKey = this.credentialResolver.getEnv(credRef.ref);
                        } else if (credRef.type === 'secrets') {
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
        const endpoint = config.config?.endpoint as string | undefined;
        const timeout = config.config?.timeout as number | undefined;

        switch (config.type) {
            case 'llm':
                // Detect provider type from id or name
                const providerName = config.name.toLowerCase();
                if (providerName.includes('openai') || config.id.includes('openai')) {
                    return new OpenAIProvider(apiKey, endpoint, timeout);
                } else if (providerName.includes('anthropic') || config.id.includes('anthropic')) {
                    return new AnthropicProvider(apiKey, endpoint, timeout);
                } else {
                    throw new Error(`Unknown LLM provider: ${config.name}`);
                }

            default:
                throw new Error(`Unsupported provider type: ${config.type}`);
        }
    }

    /**
     * Complete a request using the specified model configuration
     */
    async complete(
        modelConfig: AdvancedModelConfig | string,
        messages: ProviderRequest['messages'],
        params?: Record<string, any>
    ): Promise<ProviderResponse> {
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

    private async completeWithStrategy(
        strategy: string,
        providers: ModelProviderConfig[],
        messages: ProviderRequest['messages'],
        params?: Record<string, any>
    ): Promise<ProviderResponse> {
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

    private async failoverStrategy(
        providers: ModelProviderConfig[],
        messages: ProviderRequest['messages'],
        params?: Record<string, any>
    ): Promise<ProviderResponse> {
        let lastError: Error | undefined;

        for (const providerConfig of providers) {
            try {
                const providerId = this.extractProviderId(providerConfig.provider);
                return await this.completeWithProvider(
                    providerId,
                    providerConfig.name,
                    messages,
                    { ...params, ...providerConfig.params }
                );
            } catch (error) {
                lastError = error as Error;
                console.warn(`Provider ${providerConfig.provider} failed, trying next...`);
            }
        }

        throw new Error(`All providers failed. Last error: ${lastError?.message}`);
    }

    private async costOptimizedStrategy(
        providers: ModelProviderConfig[],
        messages: ProviderRequest['messages'],
        params?: Record<string, any>
    ): Promise<ProviderResponse> {
        // Sort by cost (simple heuristic: smaller models are cheaper)
        // In production, use actual pricing data
        const sorted = [...providers].sort((a, b) => {
            const aCost = this.estimateCost(a.name);
            const bCost = this.estimateCost(b.name);
            return aCost - bCost;
        });

        return this.failoverStrategy(sorted, messages, params);
    }

    private async latencyOptimizedStrategy(
        providers: ModelProviderConfig[],
        messages: ProviderRequest['messages'],
        params?: Record<string, any>
    ): Promise<ProviderResponse> {
        // In production, track latency stats and sort by historical performance
        // For now, just use failover
        return this.failoverStrategy(providers, messages, params);
    }

    private async roundRobinStrategy(
        providers: ModelProviderConfig[],
        messages: ProviderRequest['messages'],
        params?: Record<string, any>
    ): Promise<ProviderResponse> {
        // Simple round-robin: use index based on request count
        const totalRequests = Array.from(this.usageStats.values())
            .reduce((sum, stats) => sum + stats.requests, 0);
        const index = totalRequests % providers.length;
        const providerConfig = providers[index];

        const providerId = this.extractProviderId(providerConfig.provider);
        return this.completeWithProvider(
            providerId,
            providerConfig.name,
            messages,
            { ...params, ...providerConfig.params }
        );
    }

    private async completeWithProvider(
        providerId: string,
        modelName: string,
        messages: ProviderRequest['messages'],
        params?: Record<string, any>
    ): Promise<ProviderResponse> {
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
        const stats = this.usageStats.get(providerId)!;
        stats.requests++;

        try {
            const request: ProviderRequest = {
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
        } catch (error) {
            stats.errors++;
            throw error;
        }
    }

    private extractProviderId(providerRef: string): string {
        // Extract ID from reference like "provider.openai"
        const parts = providerRef.split('.');
        return parts[parts.length - 1];
    }

    private estimateCost(modelName: string): number {
        // Simple cost heuristic (lower is cheaper)
        // In production, use actual pricing data
        const name = modelName.toLowerCase();
        if (name.includes('gpt-4')) return 100;
        if (name.includes('gpt-3.5')) return 10;
        if (name.includes('claude-3-opus')) return 100;
        if (name.includes('claude-3-sonnet')) return 50;
        if (name.includes('claude-3-haiku')) return 10;
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
    async checkProviders(): Promise<Record<string, boolean>> {
        const results: Record<string, boolean> = {};

        for (const providerId of this.registry.list()) {
            const provider = this.registry.get(providerId)!;
            results[providerId] = await provider.isAvailable();
        }

        return results;
    }
}
