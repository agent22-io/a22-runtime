# A22 Local-First Runtime (Node.js)

The `runtime-js` package is the reference runtime implementation for executing A22 agents locally using Node.js.

## Features
- **File Loading**: Loads and parses `.a22` files.
- **Agent Resolution**: Resolves agent definitions and capabilities.
- **Event Bus**: Handles event emission and routing to agent `on event` handlers.
- **Workflow Engine**: Executes imperative workflows (steps) triggered by agents.

## Installation
```bash
npm install
npm run build
```

## Usage
Run the runtime CLI to load an A22 file and trigger an event:

```bash
# General Syntax
node dist/index.js <file.a22> <event_name> [json_payload]

# Example
node dist/index.js test_runtime.a22 ping
```

## Architecture
- `src/runtime.ts`: Main `Runtime` class managing state and event dispatch.
- `src/workflow.ts`: `WorkflowEngine` for executing steps sequentially.
