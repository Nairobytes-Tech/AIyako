import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgent, unloadAgent } from '../agent.js';
import { getDb } from '../db/database.js';
import { runTurn, resolveApproval } from '../runtime/agentRunner.js';
import { createSession, getSession, listSessions, deleteSession, updateSessionTitle, appendMessage, setStatus } from '../runtime/session.js';
import { addGoal, listGoals, updateGoal } from '../runtime/goals.js';
import { listPendingApprovals, createApprovals, setApprovalStatus, markApprovalExecuted } from '../runtime/approvals.js';
import { onStatusChange } from '../runtime/status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
const AGENT_URL = process.env.KIOO_AGENT_URL ? process.env.KIOO_AGENT_URL.replace(/\/$/, '') : null;
const AGENT_TIMEOUT_MS = Number(process.env.KIOO_AGENT_TIMEOUT_MS || 300000);
const MCP_GATEWAY_URL = process.env.MCP_GATEWAY_URL ? process.env.MCP_GATEWAY_URL.replace(/\/$/, '') : null;
const MODEL_NAME = process.env.MODEL_NAME || path.basename(process.env.QVAC_MODEL_PATH || 'unknown');
const ESCALATION_MODEL_NAME = process.env.KIOO_ESCALATION_MODEL_PATH
    ? path.basename(process.env.KIOO_ESCALATION_MODEL_PATH)
    : null;

const contentTypes = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
};

function jsonResponse(statusCode, data) {
    return {
        status: statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify(data),
    };
}

function send(res, response) {
    res.writeHead(response.status, response.headers);
    res.end(response.body);
}

function normalizeApprovalDecision(value) {
    if (value === 'approve' || value === 'approved') return 'approve';
    if (value === 'reject' || value === 'rejected') return 'reject';
    return null;
}

async function callMcp(pathname) {
    if (!MCP_GATEWAY_URL) {
        throw new Error('MCP Gateway is not configured');
    }
    const response = await fetch(`${MCP_GATEWAY_URL}${pathname}`, {
        signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    if (!response.ok) {
        throw new Error((data && data.error) || `MCP Gateway returned ${response.status}`);
    }
    return data;
}

function serveFile(filename) {
    const filepath = path.join(PUBLIC_DIR, filename);
    try {
        const content = fs.readFileSync(filepath);
        const ext = path.extname(filepath).slice(1);
        return {
            status: 200,
            headers: { 'Content-Type': contentTypes[ext] || 'application/octet-stream' },
            body: content,
        };
    } catch {
        return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not found' };
    }
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function parseJson(body) {
    try {
        return JSON.parse(body || '{}');
    } catch {
        return null;
    }
}

function buildRemoteHistory(sessionId) {
    const rows = getDb().prepare(
        'SELECT role, content, tool_name, tool_calls, tool_call_id FROM messages '
        + 'WHERE session_id = ? ORDER BY created_at, rowid'
    ).all(sessionId);

    return rows.map(row => {
        if (row.role === 'tool') {
            return {
                role: 'tool',
                content: row.content,
                tool_call_id: row.tool_call_id || '',
                name: row.tool_name || 'unknown',
            };
        }

        if (row.role === 'assistant' && row.tool_calls) {
            let calls;
            try {
                calls = JSON.parse(row.tool_calls);
            } catch {
                calls = [];
            }
            if (calls.length) {
                return {
                    role: 'assistant',
                    content: row.content,
                    tool_calls: calls.map(call => ({
                        id: call.id,
                        type: 'function',
                        function: {
                            name: call.name,
                            arguments: JSON.stringify(call.arguments || {}),
                        },
                    })),
                };
            }
        }

        return { role: row.role, content: row.content };
    });
}

function remotePayload(data) {
    const reply = data.reply || '';
    return {
        sessionId: data.session_id,
        reply,
        status: data.status || 'completed',
        error: data.error || null,
        approvals: data.approvals || [],
        route: { provider: 'remote', model: data.model || null, steps: data.steps || 0 },
        toolCalls: data.tool_calls || [],
        toolResults: data.tool_results || [],
        events: [
            { type: 'final', content: reply },
            ...(data.tool_calls || []).map(call => ({ type: 'toolCall', call: { name: call.name, arguments: call.arguments } })),
            ...(data.tool_results || []).map(result => ({ type: 'toolResult', result })),
        ],
    };
}

async function callRemoteAgent(sessionId, message, approvedToolKeys = []) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
    try {
        const res = await fetch(`${AGENT_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                session_id: sessionId,
                message,
                history: buildRemoteHistory(sessionId),
                approved_tool_keys: approvedToolKeys,
            }),
        });
        if (!res.ok) {
            throw new Error(`Remote agent returned ${res.status}`);
        }
        return await res.json();
    } finally {
        clearTimeout(timeout);
    }
}

async function startServer() {
    let modelId;
    let modelLoaded = false;
    const remoteApprovals = new Map();

    if (process.env.KIOO_SKIP_MODEL === '1') {
        console.log('\u25b8 Skipping model load (KIOO_SKIP_MODEL=1)');
    } else {
        try {
            console.log('\u25b8 Loading local model...');
            modelId = await loadAgent();
            modelLoaded = true;
            console.log('\u25b8 Model loaded successfully');
        } catch (err) {
            console.error('\u25b8 Failed to load model:', err.message);
        }
    }

    async function handleChat(res, sessionId, message) {
        if (!message || typeof message !== 'string') {
            return send(res, jsonResponse(400, { error: 'Message is required' }));
        }
        if (!getSession(sessionId)) {
            return send(res, jsonResponse(404, { error: 'Session not found' }));
        }

        if (AGENT_URL) {
            setStatus(sessionId, 'thinking');
            try {
                const data = await callRemoteAgent(sessionId, message);

                if (data.status === 'waiting_approval' && data.approval) {
                    const created = createApprovals(sessionId, [{
                        name: data.approval.name,
                        arguments: data.approval.arguments,
                        id: data.approval.key,
                    }], () => true);
                    const approval = created[0];
                    remoteApprovals.set(approval.id, {
                        sessionId,
                        message,
                        key: data.approval.key,
                    });
                    setStatus(sessionId, 'waiting_approval');
                    return send(res, jsonResponse(200, remotePayload({
                        ...data,
                        approvals: created,
                        events: [...(data.events || []), {
                            type: 'status',
                            status: 'waiting_approval',
                            tool: data.approval.name,
                        }],
                    })));
                }

                appendMessage(sessionId, 'user', message);
                appendMessage(sessionId, 'assistant', data.reply || '');
                setStatus(sessionId, 'idle');
                return send(res, jsonResponse(200, remotePayload(data)));
            } catch (err) {
                setStatus(sessionId, 'idle');
                if (!modelLoaded || !modelId) {
                    return send(res, jsonResponse(503, { error: `Remote agent unavailable: ${err.message}` }));
                }
                console.error(`Remote agent failed, falling back to local: ${err.message}`);
            }
        }

        if (!modelLoaded || !modelId) {
            return send(res, jsonResponse(503, { error: 'Model not loaded. Local model unavailable.' }));
        }

        const result = await runTurn(sessionId, message, { modelId });
        return send(res, jsonResponse(200, chatPayload(result)));
    }

    function chatPayload(result) {
        return {
            sessionId: result.sessionId,
            reply: result.reply,
            status: result.status,
            error: result.error,
            approvals: result.approvals || [],
            route: result.route || null,
            toolCalls: result.events
                .filter(e => e.type === 'toolCall')
                .map(e => ({ name: e.call.name, arguments: e.call.arguments })),
            toolResults: result.events
                .filter(e => e.type === 'toolResult')
                .map(e => e.result),
            events: result.events,
        };
    }

    async function handle(req, res) {
        const url = new URL(req.url, `http://${HOST}:${PORT}`);
        const method = req.method;
        const parts = url.pathname.split('/').filter(Boolean);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (method === 'GET' && parts[0] === 'mcp' && ['tools', 'audit', 'connectors'].includes(parts[1])) {
            try {
                const target = parts[1] === 'audit' ? `/audit${url.search}` : `/${parts[1]}`;
                return send(res, jsonResponse(200, await callMcp(target)));
            } catch (err) {
                return send(res, jsonResponse(503, { error: err.message }));
            }
        }

        if (parts[0] === 'health') {
            return send(res, jsonResponse(200, {
                status: 'ok',
                offline: !AGENT_URL,
                mode: AGENT_URL ? 'remote' : 'local',
                agentUrl: AGENT_URL,
                modelLoaded,
                model: MODEL_NAME,
                escalationEnabled: Boolean(ESCALATION_MODEL_NAME),
                escalationModel: ESCALATION_MODEL_NAME,
                mcpGateway: Boolean(MCP_GATEWAY_URL),
            }));
        }

        if (parts[0] === 'notes' && method === 'GET') {
            const db = getDb();
            const notes = db.prepare(
                'SELECT id, content, created_at FROM notes ORDER BY created_at DESC'
            ).all();
            return send(res, jsonResponse(200, { notes }));
        }

        if (parts[0] === 'tasks' && method === 'GET') {
            const db = getDb();
            const tasks = db.prepare(
                'SELECT id, title, due_date, completed, created_at FROM tasks ORDER BY created_at DESC'
            ).all();
            return send(res, jsonResponse(200, { tasks }));
        }

        if (parts[0] === 'sessions') {
            if (parts.length === 1 && method === 'GET') {
                return send(res, jsonResponse(200, { sessions: listSessions() }));
            }

            if (parts.length === 1 && method === 'POST') {
                const payload = parseJson(await readBody(req));
                if (payload === null) {
                    return send(res, jsonResponse(400, { error: 'Invalid JSON body' }));
                }
                const session = createSession(payload.userId || null, payload.title || null);
                return send(res, jsonResponse(201, session));
            }

            const sessionId = parts[1];

            if (parts.length === 2 && method === 'GET') {
                const session = getSession(sessionId);
                if (!session) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }
                return send(res, jsonResponse(200, session));
            }

            if (parts.length === 2 && method === 'DELETE') {
                const deleted = deleteSession(sessionId);
                if (!deleted) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }
                return send(res, jsonResponse(200, { ok: true }));
            }

            if (parts.length === 2 && method === 'PATCH') {
                const payload = parseJson(await readBody(req));
                if (payload === null || typeof payload.title !== 'string' || !payload.title.trim()) {
                    return send(res, jsonResponse(400, { error: 'title is required' }));
                }
                const updated = updateSessionTitle(sessionId, payload.title.trim());
                if (!updated) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }
                return send(res, jsonResponse(200, { session: getSession(sessionId) }));
            }

            if (parts.length === 3 && parts[2] === 'chat' && method === 'POST') {
                const payload = parseJson(await readBody(req));
                if (payload === null) {
                    return send(res, jsonResponse(400, { error: 'Invalid JSON body' }));
                }
                return handleChat(res, sessionId, payload.message);
            }

            if (parts.length === 3 && parts[2] === 'events' && method === 'GET') {
                const session = getSession(sessionId);
                if (!session) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }

                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                    'Access-Control-Allow-Origin': '*',
                });

                let closed = false;

                const writeStatus = event => {
                    if (closed || event.sessionId !== sessionId) return;
                    res.write(`event: status\ndata: ${JSON.stringify(event)}\n\n`);
                };

                res.write('retry: 2000\n\n');
                writeStatus({
                    sessionId,
                    status: session.status,
                    updated_at: session.updated_at,
                });

                const unsubscribe = onStatusChange(writeStatus);
                const heartbeat = setInterval(() => {
                    if (!closed) res.write(': ping\n\n');
                }, 15000);

                const closeStream = () => {
                    closed = true;
                    clearInterval(heartbeat);
                    unsubscribe();
                };

                req.on('close', closeStream);
                res.on('error', closeStream);
                return;
            }

            if (parts.length === 3 && parts[2] === 'goals') {
                if (!getSession(sessionId)) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }

                if (method === 'GET') {
                    return send(res, jsonResponse(200, { goals: listGoals(sessionId) }));
                }

                if (method === 'POST') {
                    const payload = parseJson(await readBody(req));
                    if (payload === null) {
                        return send(res, jsonResponse(400, { error: 'Invalid JSON body' }));
                    }
                    if (!payload.title || typeof payload.title !== 'string') {
                        return send(res, jsonResponse(400, { error: 'Title is required' }));
                    }
                    try {
                        const goal = addGoal(sessionId, payload.title, {
                            status: payload.status,
                            progress: payload.progress,
                        });
                        return send(res, jsonResponse(201, goal));
                    } catch (err) {
                        return send(res, jsonResponse(400, { error: err.message }));
                    }
                }
            }

            if (parts.length === 3 && parts[2] === 'approvals' && method === 'GET') {
                if (!getSession(sessionId)) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }
                return send(res, jsonResponse(200, { approvals: listPendingApprovals(sessionId) }));
            }

            if (parts.length === 4 && parts[2] === 'approvals' && method === 'POST') {
                const approvalId = parts[3];
                const payload = parseJson(await readBody(req));
                if (payload === null) {
                    return send(res, jsonResponse(400, { error: 'Invalid JSON body' }));
                }
                const decision = normalizeApprovalDecision(payload.decision);
                if (!decision) {
                    return send(res, jsonResponse(400, { error: 'Invalid approval decision' }));
                }

                const remote = remoteApprovals.get(approvalId);
                if (remote) {
                    try {
                        setApprovalStatus(approvalId, decision === 'approve' ? 'approved' : 'rejected');
                        remoteApprovals.delete(approvalId);

                        if (decision === 'reject') {
                            return send(res, jsonResponse(200, remotePayload({
                                session_id: sessionId,
                                reply: 'Approval denied. The action was not performed.',
                                status: 'rejected',
                            })));
                        }

                        const data = await callRemoteAgent(sessionId, remote.message, [remote.key]);
                        appendMessage(sessionId, 'user', remote.message);
                        appendMessage(sessionId, 'assistant', data.reply || '');
                        markApprovalExecuted(approvalId, { reply: data.reply || '' });
                        return send(res, jsonResponse(200, remotePayload(data)));
                    } catch (err) {
                        return send(res, jsonResponse(500, { error: err.message }));
                    }
                }

                if (!modelLoaded || !modelId) {
                    return send(res, jsonResponse(503, { error: 'Model not loaded. Local model unavailable.' }));
                }
                try {
                    const result = await resolveApproval(sessionId, approvalId, decision, { modelId });
                    return send(res, jsonResponse(200, chatPayload(result)));
                } catch (err) {
                    const message = err.message;
                    const status = /not found/i.test(message) ? 404
                        : /already resolved|Invalid approval decision/i.test(message) ? 400
                        : 500;
                    return send(res, jsonResponse(status, { error: message }));
                }
            }
        }

        if (parts[0] === 'goals' && parts.length === 2 && (method === 'PATCH' || method === 'PUT')) {
            const payload = parseJson(await readBody(req));
            if (payload === null) {
                return send(res, jsonResponse(400, { error: 'Invalid JSON body' }));
            }
            try {
                const goal = updateGoal(parts[1], payload);
                if (!goal) {
                    return send(res, jsonResponse(404, { error: 'Goal not found' }));
                }
                return send(res, jsonResponse(200, goal));
            } catch (err) {
                return send(res, jsonResponse(400, { error: err.message }));
            }
        }

        if (parts[0] === 'chat' && method === 'POST') {
            const payload = parseJson(await readBody(req));
            if (payload === null) {
                return send(res, jsonResponse(400, { error: 'Invalid JSON body' }));
            }
            const sessionId = payload.sessionId || createSession().id;
            return handleChat(res, sessionId, payload.message);
        }

        const filePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        return send(res, serveFile(filePath));
    }

    function handleRequest(req, res) {
        handle(req, res).catch(err => {
            if (!res.headersSent) {
                send(res, jsonResponse(500, { error: err.message }));
            } else {
                res.end();
            }
        });
    }

    const server = http.createServer(handleRequest);

    server.listen(PORT, HOST, () => {
        console.log(`\u25b8 Kioo AI Server running on http://${HOST}:${PORT}`);
        console.log('\u25b8 Offline mode: local model only');
    });

    const shutdown = async () => {
        console.log('\n\u25b8 Shutting down...');
        server.close();
        try { await unloadAgent(); } catch (err) { /* already unloaded */ }
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

startServer().catch(err => {
    console.error('\u25b8 Server error:', err);
    process.exit(1);
});
