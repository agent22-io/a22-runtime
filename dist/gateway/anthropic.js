/**
 * Anthropic Provider Implementation
 */
export class AnthropicProvider {
    constructor(apiKey, endpoint = 'https://api.anthropic.com', timeout = 30000) {
        this.apiKey = apiKey;
        this.endpoint = endpoint;
        this.timeout = timeout;
        this.name = 'anthropic';
        this.type = 'llm';
    }
    async complete(request) {
        const anthropicRequest = this.transformRequest(request);
        const response = await fetch(`${this.endpoint}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(anthropicRequest),
            signal: AbortSignal.timeout(this.timeout)
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Anthropic API error: ${response.status} - ${error}`);
        }
        const data = await response.json();
        return this.transformResponse(data);
    }
    async isAvailable() {
        try {
            // Anthropic doesn't have a models endpoint, so just check if we can make a minimal request
            const response = await fetch(`${this.endpoint}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-haiku-20240307',
                    messages: [{ role: 'user', content: 'test' }],
                    max_tokens: 1
                }),
                signal: AbortSignal.timeout(5000)
            });
            return response.ok || response.status === 400; // 400 is ok, means auth worked
        }
        catch {
            return false;
        }
    }
    transformRequest(request) {
        // Extract system message if present
        const messages = request.messages.filter(m => m.role !== 'system');
        const systemMessage = request.messages.find(m => m.role === 'system');
        return {
            model: request.model,
            messages: messages.map(msg => ({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content
            })),
            system: systemMessage?.content,
            temperature: request.temperature ?? 0.7,
            max_tokens: request.max_tokens ?? 4096,
            stop_sequences: request.stop,
            stream: request.stream ?? false
        };
    }
    transformResponse(data) {
        const content = data.content?.[0];
        return {
            content: content?.text || '',
            model: data.model,
            usage: data.usage ? {
                prompt_tokens: data.usage.input_tokens,
                completion_tokens: data.usage.output_tokens,
                total_tokens: data.usage.input_tokens + data.usage.output_tokens
            } : undefined,
            finish_reason: data.stop_reason
        };
    }
}
