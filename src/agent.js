import { loadModel, completion, unloadModel } from '@qvac/sdk';
import { toolDefinitions, executeTool } from './tools/index.js';
import { formatHistoryForModel } from './tools/format.js';
import { closeDb } from './db/database.js';

const DEFAULT_MODEL_PATH = '/home/lulwanda/projects/kioo-ai/models/qwen3-0.6b-q4_0.gguf';
const MODEL_PATH = process.env.QVAC_MODEL_PATH || DEFAULT_MODEL_PATH;

if (MODEL_PATH.startsWith('http') || MODEL_PATH.startsWith('https')) {
    throw new Error(
        'Security: QVAC_MODEL_PATH must be a local file path. ' +
        'Cloud/remote model URLs are not allowed in Kioo AI.'
    );
}

export const SYSTEM_PROMPT = `You are Kioo, a local AI assistant that runs on the user's device. Your job is to help users manage their notes and tasks using the available tools.

Available tools:
- save_note: Save information for future reference
- search_notes: Find previously saved notes
- create_task: Create a task with optional due date
- list_tasks: List all tasks, optionally filtered by completion
- mark_task_done: Mark a task as completed
- web_search: Search the web for current information using a local SearXNG instance

When you need current or time-sensitive information that is not in local notes, use web_search.

After a tool returns results, treat that data as your source of truth:
- Summarize the most relevant findings instead of dumping raw data.
- Cite the URLs you used.
- If the requested name or topic appears in result titles or snippets, treat it as a potential match and explain what you found.
- Do not claim there are no matches when the results contain relevant terms.
- If results are weak or partial, say what was found and what is missing. Never invent facts.
- Always check the tool result to confirm the action was successful before telling the user it was done.`;

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function toolCallKey(name, args) {
    return `${name}:${stableStringify(args === undefined ? null : args)}`;
}

const _models = new Map();

export async function loadAgent(options = {}) {
    const modelPath = options.modelPath || MODEL_PATH;

    if (_models.has(modelPath)) {
        return _models.get(modelPath);
    }

    const modelId = await loadModel({
        modelSrc: modelPath,
        modelType: 'llamacpp-completion',
        modelConfig: { ctx_size: options.ctxSize || 8192, tools: true },
    });
    _models.set(modelPath, modelId);
    return modelId;
}

export async function unloadAgent() {
    for (const modelId of _models.values()) {
        await unloadModel({ modelId });
    }
    _models.clear();
    closeDb();
}

export async function createCompletion(modelId, history, options = {}) {
    const events = [];
    const maxIterations = 10;
    const maxToolCallsPerTurn = 5;
    const approvalGate = typeof options.approvalGate === 'function' ? options.approvalGate : null;
    const repeatResults = options.repeatResults instanceof Map ? options.repeatResults : null;
    const onToolCall = typeof options.onToolCall === 'function' ? options.onToolCall : null;
    const onToolResult = typeof options.onToolResult === 'function' ? options.onToolResult : null;
    const executedCalls = new Map();

    for (let i = 0; i < maxIterations; i++) {
        const result = completion({
            modelId,
            history: formatHistoryForModel(history),
            stream: true,
            captureThinking: true,
            tools: toolDefinitions,
            generationParams: { temp: 0.2, predict: 512 },
        });

        let assistantContent = '';
        const toolCalls = [];
        let completionError = null;

        for await (const event of result.events) {
            if (event.type === 'contentDelta' && event.text) {
                assistantContent += event.text;
                events.push({ type: 'content', text: event.text });
            } else if (event.type === 'thinkingDelta') {
                events.push({ type: 'thinking', text: event.text });
            } else if (event.type === 'toolCall') {
                if (toolCalls.length < maxToolCallsPerTurn) {
                    toolCalls.push(event.call);
                    events.push({ type: 'toolCall', call: event.call });
                }
            } else if (event.type === 'completionDone') {
                if (event.stopReason === 'error' && 'error' in event) {
                    completionError = event.error?.message || 'Unknown completion error';
                    events.push({ type: 'error', message: completionError });
                }
            }
        }

        const final = await result.final;

        if (completionError) {
            events.push({ type: 'error', message: completionError });
            history.push({ role: 'assistant', content: 'Sorry, I encountered an error processing your request.' });
            break;
        }

        if (toolCalls.length > 0) {
            const content = (final.contentText || assistantContent).trim();
            history.push({
                role: 'assistant',
                content: content || '',
                tool_calls: toolCalls.map(call => ({
                    id: call.id,
                    name: call.name,
                    arguments: call.arguments,
                })),
            });

            const requiresApproval = approvalGate
                ? toolCalls.some(call => approvalGate(call))
                : false;

            if (requiresApproval) {
                return { history, events, pendingToolCalls: toolCalls };
            }

            let repeatedCount = 0;

            for (const call of toolCalls) {
                const key = toolCallKey(call.name, call.arguments);
                let toolResult;
                let repeated = false;

                if (executedCalls.has(key)) {
                    toolResult = executedCalls.get(key);
                    repeated = true;
                } else if (repeatResults && repeatResults.has(key)) {
                    toolResult = repeatResults.get(key);
                    repeated = true;
                } else {
                    if (onToolCall) onToolCall(call);
                    try {
                        toolResult = await executeTool(call.name, call.arguments);
                    } catch (err) {
                        toolResult = { success: false, error: err.message };
                    }
                    if (onToolResult) onToolResult(call);
                    executedCalls.set(key, toolResult);
                }

                if (repeated) repeatedCount += 1;

                const toolEvent = { type: 'toolExecute', name: call.name, arguments: call.arguments };
                if (repeated) toolEvent.repeated = true;
                if (!toolResult.success) {
                    toolEvent.error = toolResult.error;
                }

                events.push(toolEvent);
                events.push({ type: 'toolResult', result: toolResult });

                history.push({
                    role: 'tool',
                    content: JSON.stringify(toolResult),
                    tool_call_id: call.id,
                    name: call.name,
                });
            }

            if (repeatedCount === toolCalls.length) {
                const finalContent = 'That action was already completed.';
                events.push({ type: 'final', content: finalContent });
                history.push({ role: 'assistant', content: finalContent });
                break;
            }
        } else {
            const content = (final.contentText || assistantContent).trim();
            let finalContent = content;

            if (!finalContent || finalContent.startsWith('{') && finalContent.includes('"success"')) {
                finalContent = 'I have completed your request.';
            }

            events.push({ type: 'final', content: finalContent });
            history.push({ role: 'assistant', content: finalContent });
            break;
        }
    }

    return { history, events, pendingToolCalls: [] };
}

export async function runAgent(userInput, options = {}) {
    const modelId = options.modelId || await loadAgent(options);
    const managedModel = !options.modelId;

    const history = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userInput },
    ];

    try {
        return await createCompletion(modelId, history);
    } finally {
        if (managedModel) {
            await unloadAgent();
        }
    }
}

export function streamEvents(events) {
    for (const event of events) {
        switch (event.type) {
            case 'content':
                process.stdout.write(event.text);
                break;
            case 'thinking':
                break;
            case 'toolCall':
                console.log(`\n\u25b8 ${event.call.name}(${JSON.stringify(event.call.arguments)})`);
                break;
            case 'toolExecute':
                console.log(`  executing...`);
                break;
            case 'toolResult':
                console.log(`  ${JSON.stringify(event.result)}`);
                break;
            case 'error':
                console.log(`\n\u2716 Error: ${event.message}`);
                break;
            case 'final':
                if (event.content) {
                    console.log(`\n\u25b8 ${event.content}`);
                }
                break;
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const userInput = process.argv.slice(2).join(' ') || 'Save a note that my transport budget is KES 4,000. Then find my transport budget and create a task to review it tomorrow.';

    console.log('\u25b8 Kioo AI Agent');
    console.log(`\u25b8 Input: ${userInput}\n`);

    runAgent(userInput)
        .then(({ events }) => streamEvents(events))
        .catch(err => {
            console.error('\u25b8 Agent error:', err);
            process.exit(1);
        });
}
