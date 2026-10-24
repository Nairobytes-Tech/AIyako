import { loadModel, completion, unloadModel } from '@qvac/sdk';
import { toolDefinitions, executeTool } from './tools/index.js';
import { closeDb } from './db/database.js';

const MODEL_PATH = process.env.QVAC_MODEL_PATH || '/home/lulwanda/projects/kioo-ai/models/qwen3-0.6b-q4_0.gguf';

const SYSTEM_PROMPT = `You are Kioo, a local AI assistant that runs entirely offline. Your job is to help users manage their notes and tasks using the available tools.

When a user asks you to save information, use the save_note tool.
When a user asks you to find something, use the search_notes tool.
When a user asks you to create a task, use the create_task tool.

Always check the tool result to confirm the action was successful before telling the user it was done.`;

export async function runAgent(userInput) {
    const modelId = await loadModel({
        modelSrc: MODEL_PATH,
        modelType: 'llamacpp-completion',
        modelConfig: { ctx_size: 8192, tools: true },
    });

    try {
        const history = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userInput },
        ];

        const maxIterations = 10;
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

            for await (const event of result.events) {
                if (event.type === 'contentDelta') {
                    process.stdout.write(event.text);
                    assistantContent += event.text;
                } else if (event.type === 'thinkingDelta') {
                    // Skip thinking output in visible stream
                } else if (event.type === 'toolCall') {
                    toolCalls.push(event.call);
                    console.log(`\n▸ Tool call: ${event.call.name}(${JSON.stringify(event.call.arguments)})`);
                } else if (event.type === 'completionDone') {
                    if (event.stopReason === 'error' && 'error' in event) {
                        console.log(`\n✖ Completion error: ${event.error?.message}`);
                    }
                }
            }

            const final = await result.final;

            if (toolCalls.length > 0) {
                const content = (final.contentText || assistantContent).trim();
                history.push({ role: 'assistant', content: content || '[tool_calls]' });

                for (const call of toolCalls) {
                    console.log(`\n▸ Executing: ${call.name}`);
                    let toolResult;
                    try {
                        toolResult = await executeTool(call.name, call.arguments);
                    } catch (err) {
                        toolResult = { success: false, error: err.message };
                    }
                    console.log(`▸ Result: ${JSON.stringify(toolResult)}`);

                    history.push({
                        role: 'tool',
                        content: JSON.stringify(toolResult),
                    });
                }
            } else {
                const content = (final.contentText || assistantContent).trim();
                console.log(`\n▸ ${content || assistantContent.trim()}`);
                history.push({ role: 'assistant', content: content });
                break;
            }
        }

        return history;
    } finally {
        await unloadModel({ modelId });
        closeDb();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const userInput = process.argv.slice(2).join(' ') || 'Save a note that my transport budget is KES 4,000. Then find my transport budget and create a task to review it tomorrow.';

    console.log('▸ Kioo AI Agent');
    console.log(`▸ Input: ${userInput}\n`);

    runAgent(userInput).catch(err => {
        console.error('Agent error:', err);
        process.exit(1);
    });
}
