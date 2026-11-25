import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, completion } from '@qvac/sdk';
import { buildSystemPrompt } from '../../src/systemPrompt.js';

const DEFAULT_MODEL_PATH = fileURLToPath(new URL('../../models/Qwen3.5-4B-Q4_K_M.gguf', import.meta.url));
const DEFAULT_FALLBACK_PATH = fileURLToPath(new URL('../../models/qwen3-0.6b-q4_0.gguf', import.meta.url));

export const config = {
    port: Number(process.env.PORT || 8000),
    modelPath: path.resolve(process.env.MODEL_PATH || process.env.QVAC_MODEL_PATH || DEFAULT_MODEL_PATH),
    modelName: process.env.MODEL_NAME || 'qwen3.5-4b-local',
    fallbackPath: path.resolve(process.env.FALLBACK_MODEL_PATH || DEFAULT_FALLBACK_PATH),
    fallbackName: process.env.FALLBACK_MODEL || 'qwen3-0.6b-local',
};

const modelIds = new Map();
let primaryId = null;
let fallbackId = null;

export function openAIToolsToQvac(tools) {
    if (!Array.isArray(tools)) {
        return [];
    }
    return tools.map(tool => {
        const fn = tool.function || tool;
        return {
            type: 'function',
            name: fn.name,
            description: fn.description || '',
            parameters: fn.parameters || { type: 'object', properties: {} },
        };
    });
}

function parseArguments(value) {
    if (typeof value !== 'string') {
        return value && typeof value === 'object' ? value : {};
    }
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
}

export function openAIMessagesToQvac(messages) {
    const namesById = new Map();
    for (const message of messages) {
        if (!Array.isArray(message.tool_calls)) {
            continue;
        }
        for (const call of message.tool_calls) {
            const fn = call.function || call;
            namesById.set(call.id, fn.name);
        }
    }

    return messages.map(message => {
        if (message.role === 'tool') {
            return {
                role: 'tool',
                content: typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content),
                tool_call_id: message.tool_call_id,
                name: message.name || namesById.get(message.tool_call_id) || 'unknown',
            };
        }

        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
            return {
                role: 'assistant',
                content: typeof message.content === 'string' ? message.content : '',
                tool_calls: message.tool_calls.map(call => {
                    const fn = call.function || call;
                    return { id: call.id, name: fn.name, arguments: parseArguments(fn.arguments) };
                }),
            };
        }

        return {
            role: message.role,
            content: typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content),
        };
    });
}

export function qvacCallsToOpenAI(calls) {
    return calls.map(call => ({
        id: call.id,
        type: 'function',
        function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments || {}),
        },
    }));
}

async function loadModelById(modelPath) {
    if (modelIds.has(modelPath)) {
        return modelIds.get(modelPath);
    }
    const modelId = await loadModel({
        modelSrc: modelPath,
        modelType: 'llamacpp-completion',
        modelConfig: { ctx_size: 8192, tools: true },
    });
    modelIds.set(modelPath, modelId);
    return modelId;
}

async function runCompletion(modelId, history, tools, params) {
    const result = completion({
        modelId,
        history,
        stream: true,
        captureThinking: true,
        tools,
        generationParams: {
            temp: typeof params.temperature === 'number' ? params.temperature : 0.2,
            predict: Number(params.max_tokens) || 1024,
        },
    });

    let content = '';
    const calls = [];
    for await (const event of result.events) {
        if (event.type === 'contentDelta' && event.text) {
            content += event.text;
        } else if (event.type === 'toolCall' && event.call) {
            calls.push(event.call);
        }
    }
    await result.final;
    return { content, calls };
}

function completionResponse(modelName, content, calls) {
    return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content,
                ...(calls.length ? { tool_calls: qvacCallsToOpenAI(calls) } : {}),
            },
            finish_reason: calls.length ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

function send(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function sendStream(res, response) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });
    const message = response.choices[0].message;
    const chunk = {
        id: response.id,
        object: 'chat.completion.chunk',
        created: response.created,
        model: response.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: message.content }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (message.tool_calls) {
        const toolChunk = {
            id: response.id,
            object: 'chat.completion.chunk',
            created: response.created,
            model: response.model,
            choices: [{ index: 0, delta: { tool_calls: message.tool_calls }, finish_reason: 'tool_calls' }],
        };
        res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
}

export async function handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${config.port}`);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
            status: 'ok',
            model: config.modelName,
            primaryLoaded: Boolean(primaryId),
            fallbackLoaded: Boolean(fallbackId),
        });
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
        return send(res, 200, {
            object: 'list',
            data: [
                { id: config.modelName, object: 'model', created: 0, owned_by: 'kioo' },
                ...(config.fallbackPath
                    ? [{ id: config.fallbackName, object: 'model', created: 0, owned_by: 'kioo' }]
                    : []),
            ],
        });
    }

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        return send(res, 404, { error: 'Not found' });
    }

    let body;
    try {
        body = JSON.parse(await readBody(req) || '{}');
    } catch {
        return send(res, 400, { error: 'Invalid JSON body' });
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return send(res, 400, { error: 'messages must be a non-empty array' });
    }

    const history = openAIMessagesToQvac(body.messages);
    const tools = openAIToolsToQvac(body.tools);
    if (!body.messages.some(message => message.role === 'system')) {
        history.unshift({ role: 'system', content: buildSystemPrompt(body.tools || []) });
    }
    const params = body;

    let modelName = config.modelName;
    let modelId;
    try {
        modelId = await loadModelById(config.modelPath);
        primaryId = modelId;
    } catch (err) {
        return send(res, 503, { error: `Primary model unavailable: ${err.message}` });
    }

    let output;
    try {
        output = await runCompletion(modelId, history, tools, params);
    } catch (err) {
        if (!config.fallbackPath) {
            return send(res, 503, { error: err.message });
        }
        try {
            const fallbackModelId = await loadModelById(config.fallbackPath);
            fallbackId = fallbackModelId;
            output = await runCompletion(fallbackModelId, history, tools, params);
            modelName = config.fallbackName;
        } catch (fallbackErr) {
            return send(res, 503, { error: fallbackErr.message });
        }
    }

    const response = completionResponse(modelName, output.content, output.calls);
    if (body.stream) {
        return sendStream(res, response);
    }
    return send(res, 200, response);
}

export function startServer() {
    const server = http.createServer((req, res) => {
        handleRequest(req, res).catch(err => {
            if (!res.headersSent) {
                send(res, 500, { error: err.message });
            } else {
                res.end();
            }
        });
    });
    server.listen(config.port, '0.0.0.0', () => {
        console.log(`AIyako model server listening on http://0.0.0.0:${config.port}/v1`);
    });
    return server;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    startServer();
}
