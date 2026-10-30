import { loadModel, completion, unloadModel } from '@qvac/sdk';
import { toolDefinitions, executeTool } from './tools/index.js';
import { closeDb } from './db/database.js';

const DEFAULT_MODEL_PATH = '/home/lulwanda/projects/kioo-ai/models/qwen3-0.6b-q4_0.gguf';
const MODEL_PATH = process.env.QVAC_MODEL_PATH || DEFAULT_MODEL_PATH;

if (MODEL_PATH.startsWith('http') || MODEL_PATH.startsWith('https')) {
    throw new Error(
        'Security: QVAC_MODEL_PATH must be a local file path. ' +
        'Cloud/remote model URLs are not allowed in Kioo AI.'
    );
}

export const SYSTEM_PROMPT = `You are Kioo, a local AI assistant that runs entirely offline. Your job is to help users manage their notes and tasks using the available tools.

Available tools:
- save_note: Save information for future reference
- search_notes: Find previously saved notes
- create_task: Create a task with optional due date
- list_tasks: List all tasks, optionally filtered by completion
- mark_task_done: Mark a task as completed

Always check the tool result to confirm the action was successful before telling the user it was done.`;

let _modelId = null;

export async function loadAgent(options = {}) {
    if (_modelId) {
        return _modelId;
    }
    _modelId = await loadModel({
        modelSrc: MODEL_PATH,
        modelType: 'llamacpp-completion',
        modelConfig: { ctx_size: options.ctxSize || 8192, tools: true },
    });
    return _modelId;
}

export async function unloadAgent() {
    if (_modelId) {
        await unloadModel({ modelId: _modelId });
        _modelId = null;
    }
    closeDb();
}

export async function createCompletion(modelId, history) {
    const events = [];
    const maxIterations = 10;
    const maxToolCallsPerTurn = 5;

    for (let i = 0; i < maxIterations; i++) {
        const result = completion({
            modelId,
            history,
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
            history.push({ role: 'assistant', content: content || '[tool_calls]' });

            for (const call of toolCalls) {
                const toolEvent = { type: 'toolExecute', name: call.name, arguments: call.arguments };

                let toolResult;
                try {
                    toolResult = await executeTool(call.name, call.arguments);
                } catch (err) {
                    toolResult = { success: false, error: err.message };
                }

                if (!toolResult.success) {
                    toolEvent.error = toolResult.error;
                }

                events.push(toolEvent);
                events.push({ type: 'toolResult', result: toolResult });

                history.push({
                    role: 'tool',
                    content: JSON.stringify(toolResult),
                });
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

    return { history, events };
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
