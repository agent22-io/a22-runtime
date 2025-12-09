/**
 * OpenAI Provider Implementation
 */

import { IModelProvider, ProviderRequest, ProviderResponse, Message } from './provider.js';

export class OpenAIProvider implements IModelProvider {
    readonly name = 'openai';
    readonly type = 'llm' as const;

    constructor(
        private apiKey: string,
        private endpoint: string = 'https://api.openai.com/v1',
        private timeout: number = 30000
    ) {}

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
        const openaiRequest = this.transformRequest(request);

        const response = await fetch(`${this.endpoint}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(openaiRequest),
            signal: AbortSignal.timeout(this.timeout)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} - ${error}`);
        }

        const data = await response.json();
        return this.transformResponse(data);
    }

    async isAvailable(): Promise<boolean> {
        try {
            const response = await fetch(`${this.endpoint}/models`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`
                },
                signal: AbortSignal.timeout(5000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    private transformRequest(request: ProviderRequest): any {
        return {
            model: request.model,
            messages: request.messages.map(msg => ({
                role: msg.role,
                content: msg.content
            })),
            temperature: request.temperature ?? 0.7,
            max_tokens: request.max_tokens,
            stop: request.stop,
            stream: request.stream ?? false
        };
    }

    private transformResponse(data: any): ProviderResponse {
        const choice = data.choices?.[0];

        return {
            content: choice?.message?.content || '',
            model: data.model,
            usage: data.usage ? {
                prompt_tokens: data.usage.prompt_tokens,
                completion_tokens: data.usage.completion_tokens,
                total_tokens: data.usage.total_tokens
            } : undefined,
            finish_reason: choice?.finish_reason
        };
    }
}
