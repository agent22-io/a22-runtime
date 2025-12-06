import { ToolSandbox } from './security/index.js';
export class WorkflowEngine {
    constructor(runtime) {
        this.runtime = runtime;
    }
    async execute(workflowBlock, input) {
        console.log(`[Workflow] Starting ${workflowBlock.identifier}`);
        const ir = this.runtime.getIR();
        if (!ir) {
            throw new Error('Runtime IR not initialized');
        }
        // Find 'steps' block
        const stepsBlock = workflowBlock.children.find(c => c.type === 'steps');
        if (!stepsBlock) {
            console.log(`[Workflow] ${workflowBlock.identifier} has no steps.`);
            return;
        }
        const scope = { input };
        const startTime = Date.now();
        try {
            // Steps are attributes in the steps block (steps { step1 = tool... })
            for (const attr of stepsBlock.attributes) {
                const stepName = attr.key;
                const expr = attr.value;
                if (expr.kind === 'BlockExpression') {
                    const blockExpr = expr;
                    switch (blockExpr.type) {
                        case 'tool':
                            scope[stepName] = await this.executeTool(blockExpr, scope, ir);
                            break;
                        case 'agent':
                            scope[stepName] = await this.executeAgent(blockExpr, scope);
                            break;
                        case 'capability':
                            scope[stepName] = await this.executeCapability(blockExpr, scope);
                            break;
                        default:
                            console.warn(`[WorkflowStep] ${stepName}: Unknown step type '${blockExpr.type}'`);
                    }
                }
            }
            console.log(`[Workflow] Completed ${workflowBlock.identifier} in ${Date.now() - startTime}ms`);
            return scope;
        }
        catch (error) {
            console.error(`[Workflow] Failed ${workflowBlock.identifier}:`, error.message);
            throw error;
        }
    }
    async executeTool(blockExpr, scope, ir) {
        const toolName = blockExpr.identifier || '';
        // Find tool definition
        const toolDef = ir.tools.find((t) => t.id === toolName);
        if (!toolDef) {
            throw new Error(`Tool not found: ${toolName}`);
        }
        // Evaluate inputs from block attributes
        const inputs = {};
        for (const inputAttr of blockExpr.body.attributes) {
            inputs[inputAttr.key] = this.evaluateExpression(inputAttr.value, scope);
        }
        console.log(`[WorkflowStep] Executing tool '${toolName}' with inputs`, inputs);
        // Apply security sandbox if configured
        const sandbox = new ToolSandbox(toolDef.security);
        // Check policy enforcement
        const auditLogger = this.runtime.getAuditLogger();
        try {
            // Execute tool with sandbox
            const result = await sandbox.execute(async (input) => {
                // In a real implementation, this would call the actual tool handler
                // For now, simulate tool execution
                if (toolDef.handler) {
                    return await this.callToolHandler(toolDef.handler, input);
                }
                return { success: true, data: input };
            }, inputs);
            auditLogger.logToolCall(toolName, 'workflow', true);
            return result;
        }
        catch (error) {
            auditLogger.logToolCall(toolName, 'workflow', false, error.message);
            throw error;
        }
    }
    async executeAgent(blockExpr, scope) {
        const agentId = blockExpr.identifier || '';
        // Evaluate inputs from block attributes
        const inputs = {};
        for (const inputAttr of blockExpr.body.attributes) {
            inputs[inputAttr.key] = this.evaluateExpression(inputAttr.value, scope);
        }
        console.log(`[WorkflowStep] Executing agent '${agentId}' with inputs`, inputs);
        // Build messages from inputs
        const messages = [];
        if (inputs.message) {
            messages.push({ role: 'user', content: inputs.message });
        }
        else if (inputs.messages) {
            messages.push(...inputs.messages);
        }
        // Execute agent via runtime
        const response = await this.runtime.executeAgent(agentId, messages, inputs.params);
        return {
            content: response.content,
            usage: response.usage
        };
    }
    async executeCapability(blockExpr, scope) {
        const capabilityId = blockExpr.identifier || '';
        // Evaluate inputs
        const inputs = {};
        for (const inputAttr of blockExpr.body.attributes) {
            inputs[inputAttr.key] = this.evaluateExpression(inputAttr.value, scope);
        }
        console.log(`[WorkflowStep] Executing capability '${capabilityId}' with inputs`, inputs);
        // In a real implementation, this would invoke the capability
        // For now, just return mock result
        return { success: true, capability: capabilityId };
    }
    async callToolHandler(handler, input) {
        // Parse handler string
        // Format: external("http://...")
        const match = handler.match(/external\("(.+)"\)/);
        if (match) {
            const url = match[1];
            console.log(`[Tool] Calling external handler: ${url}`);
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(input)
                });
                if (!response.ok) {
                    throw new Error(`Tool handler returned ${response.status}`);
                }
                return await response.json();
            }
            catch (error) {
                throw new Error(`Tool handler failed: ${error.message}`);
            }
        }
        // Unknown handler format
        throw new Error(`Unknown tool handler format: ${handler}`);
    }
    evaluateExpression(expr, scope) {
        if (expr.kind === 'Literal') {
            return expr.value;
        }
        if (expr.kind === 'Reference') {
            const ref = expr;
            // Resolve reference from scope
            // e.g., input.text -> scope.input.text
            let value = scope;
            for (const part of ref.path) {
                value = value?.[part];
            }
            return value;
        }
        if (expr.kind === 'List') {
            const list = expr;
            return list.elements.map(e => this.evaluateExpression(e, scope));
        }
        if (expr.kind === 'Map') {
            const map = expr;
            const result = {};
            for (const prop of map.properties) {
                result[prop.key] = this.evaluateExpression(prop.value, scope);
            }
            return result;
        }
        return null;
    }
}
