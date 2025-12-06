import { Lexer } from 'core/dist/lexer.js';
import { A22Parser } from 'core/dist/parser.js';
import { Validator, Transpiler } from 'core/dist/index.js';
import * as AST from 'core/dist/ast.js';
import * as IR from 'core/dist/ir.js';
import * as fs from 'fs';
import { ModelGateway } from './gateway/index.js';
import { PolicyEnforcer } from './security/index.js';
import { AuditLogger, NoOpAuditLogger } from './security/index.js';

type BlockMap = Map<string, AST.Block>;

export interface RuntimeConfig {
    enableAudit?: boolean;
    auditConfig?: IR.AuditConfig;
}

export class Runtime {
    private blocks: BlockMap = new Map();
    private ir?: IR.A22IR;
    private gateway?: ModelGateway;
    private policies = new Map<string, PolicyEnforcer>();
    private auditLogger: AuditLogger;

    constructor(private config: RuntimeConfig = {}) {
        // Initialize audit logger
        if (config.enableAudit && config.auditConfig) {
            this.auditLogger = new AuditLogger(config.auditConfig);
        } else {
            this.auditLogger = new NoOpAuditLogger();
        }
    }

    async load(filePath: string) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lexer = new Lexer(content);
        const tokens = lexer.tokenize();
        const parser = new A22Parser(tokens);
        const program = parser.parse();

        // Validate AST
        const validator = new Validator();
        const errors = validator.validate(program);
        if (errors.length > 0) {
            throw new Error(`Validation errors:\n${errors.join('\n')}`);
        }

        // Transform to IR
        const transpiler = new Transpiler();
        this.ir = transpiler.toIR(program);

        // Store blocks for backward compatibility
        for (const block of program.blocks) {
            const id = `${block.type}.${block.identifier}`;
            this.blocks.set(id, block);
        }

        // Initialize gateway if providers are defined
        if (this.ir.providers && this.ir.providers.length > 0) {
            this.gateway = new ModelGateway(this.ir.providers);
            this.auditLogger.log({
                event: 'gateway.initialized',
                success: true,
                metadata: { providers: this.ir.providers.map(p => p.id) }
            });
        }

        // Initialize policies
        if (this.ir.policies) {
            for (const policy of this.ir.policies) {
                this.policies.set(policy.id, new PolicyEnforcer(policy));
            }
        }

        console.log(`[Runtime] Loaded ${filePath} successfully`);
        console.log(`[Runtime] Agents: ${this.ir.agents.length}, Tools: ${this.ir.tools.length}, Workflows: ${this.ir.flows.length}`);
        if (this.gateway) {
            console.log(`[Runtime] Providers: ${this.ir.providers?.length || 0}`);
        }
    }

    async emit(eventName: string, payload: any) {
        console.log(`[Runtime] Event '${eventName}' emitted`);

        for (const [id, block] of this.blocks) {
            if (block.type === 'agent') {
                const onBlock = block.children?.find(c =>
                    c.type === 'on' && c.identifier === 'event' && c.label === eventName
                );

                if (onBlock) {
                    console.log(`[Runtime] Agent '${block.identifier}' handling event '${eventName}'`);
                    await this.executeHandler(onBlock, payload);
                }
            }
        }
    }

    async executeHandler(block: AST.Block, payload: any) {
        if (!block.children) return;

        for (const child of block.children) {
            if (child.type === 'call' && child.identifier === 'workflow') {
                const workflowName = child.label;
                if (workflowName) {
                    await this.callWorkflow(workflowName, payload);
                }
            } else if (child.type === 'use' && child.identifier === 'tool') {
                // usage declaration, maybe ignore or setup context
            }
        }
    }

    async callWorkflow(name: string, input: any) {
        const workflowId = `workflow.${name}`;
        const workflowBlock = this.blocks.get(workflowId);
        if (!workflowBlock) {
            console.error(`[Runtime] Workflow '${name}' not found.`);
            return;
        }

        this.auditLogger.log({
            event: 'workflow.start',
            workflow: name,
            success: true
        });

        try {
            const { WorkflowEngine } = await import('./workflow.js');
            const engine = new WorkflowEngine(this);
            await engine.execute(workflowBlock, input);

            this.auditLogger.logWorkflowExecution(name, true);
        } catch (error: any) {
            this.auditLogger.logWorkflowExecution(name, false, error.message);
            throw error;
        }
    }

    /**
     * Execute an agent with the model gateway
     */
    async executeAgent(agentId: string, messages: { role: string; content: string }[], params?: Record<string, any>) {
        const agent = this.ir?.agents.find(a => a.id === agentId);
        if (!agent) {
            throw new Error(`Agent not found: ${agentId}`);
        }

        if (!this.gateway) {
            throw new Error('Model gateway not initialized. No providers configured.');
        }

        // Check policy if specified
        if (agent.policy) {
            const policyId = typeof agent.policy === 'string'
                ? agent.policy.split('.').pop()!
                : agent.policy.id;
            const policy = this.policies.get(policyId);
            if (policy) {
                // Policy checks would go here
                // For now, just log
                this.auditLogger.log({
                    event: 'agent.policy_check',
                    agent: agentId,
                    success: true,
                    metadata: { policy: policyId }
                });
            }
        }

        // Prepend system prompt if specified
        const fullMessages = [...messages];
        if (agent.system_prompt) {
            fullMessages.unshift({
                role: 'system',
                content: agent.system_prompt
            });
        }

        this.auditLogger.log({
            event: 'agent.execute',
            agent: agentId,
            success: true
        });

        try {
            // Use gateway to complete
            // Convert ModelConfig to string format if needed
            let modelConfig: string | IR.AdvancedModelConfig = agent.model! as any;
            if ('provider' in agent.model! && 'name' in agent.model! && !('primary' in agent.model!)) {
                // Simple ModelConfig - convert to string
                const mc = agent.model as IR.ModelConfig;
                modelConfig = `${mc.provider}/${mc.name}`;
            }

            const response = await this.gateway.complete(
                modelConfig,
                fullMessages as any,
                params
            );

            this.auditLogger.log({
                event: 'agent.complete',
                agent: agentId,
                success: true,
                metadata: { tokens: response.usage?.total_tokens }
            });

            return response;
        } catch (error: any) {
            this.auditLogger.log({
                event: 'agent.error',
                agent: agentId,
                success: false,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Get the model gateway
     */
    getGateway(): ModelGateway | undefined {
        return this.gateway;
    }

    /**
     * Get a policy enforcer
     */
    getPolicy(policyId: string): PolicyEnforcer | undefined {
        return this.policies.get(policyId);
    }

    /**
     * Get the IR
     */
    getIR(): IR.A22IR | undefined {
        return this.ir;
    }

    /**
     * Get the audit logger
     */
    getAuditLogger(): AuditLogger {
        return this.auditLogger;
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        this.auditLogger.close();
    }
}
