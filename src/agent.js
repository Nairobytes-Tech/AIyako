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

const SYSTEM_PROMPT = `You are Kioo, a local AI assistant that runs entirely offline. Your job is to help users manage their notes and tasks using the available tools.

Available tools:
- save_note: Save information for future reference
- search_notes: Find previously saved notes
- create_task: Create a task with optional due date
- list_tasks: List all tasks, optionally filtered by completion
- mark_task_done: Mark a task as completed

Always check the tool result to confirm the action was successful before telling the user it was done.`;

export async function runAgent(userInput, options = {}) {
    const modelId = await loadModel({
        modelSrc: MODEL_PATH,
        modelType: 'llamacpp-completion',
        modelConfig: { ctx_size: 8192, tools: true },
    });

    const events = [];
    const maxIterations = options.maxIterations || 10;
    const maxToolCallsPerTurn = 5;

    try {
        const history = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userInput },
        ];

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
                if (content) {
                    events.push({ type: 'final', content });
                    history.push({ role: 'assistant', content });
                } else {
                    events.push({ type: 'final', content: 'I am ready to help you with notes and tasks.' });
                    history.push({ role: 'assistant', content: 'I am ready to help you with notes and tasks.' });
                }
                break;
            }
        }

        return { history, events };
    } finally {
        await unloadModel({ modelId });
        closeDb();
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
                console.log(`\n▸ ${event.call.name}(${JSON.stringify(event.call.arguments)})`);
                break;
            case 'toolExecute':
                console.log(`  executing...`);
                break;
            case 'toolResult':
                console.log(`  ${JSON.stringify(event.result)}`);
                break;
            case 'error':
                console.log(`\n✖ Error: ${event.message}`);
                break;
            case 'final':
                if (event.content) {
                    console.log(`\n▸ ${event.content}`);
                }
                break;
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const userInput = process.argv.slice(2).join(' ') || 'Save a note that my transport budget is KES 4,000. Then find my transport budget and create a task to review it tomorrow.';

    console.log('▸ Kioo AI Agent');
    console.log(`▸ Input: ${userInput}\n`);

    runAgent(userInput)
        .then(({ events }) => streamEvents(events))
        .catch(err => {
            console.error('Agent error:', err);
            process.exit(1);
        });
}
