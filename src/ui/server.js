import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgent, unloadAgent } from '../agent.js';
import { getDb } from '../db/database.js';
import { runTurn, resolveApproval } from '../runtime/agentRunner.js';
import { createSession, getSession, listSessions, deleteSession } from '../runtime/session.js';
import { addGoal, listGoals, updateGoal } from '../runtime/goals.js';
import { listPendingApprovals } from '../runtime/approvals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

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

async function startServer() {
    let modelId;
    let modelLoaded = false;

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
        if (!modelLoaded || !modelId) {
            return send(res, jsonResponse(503, { error: 'Model not loaded. Local model unavailable.' }));
        }
        if (!message || typeof message !== 'string') {
            return send(res, jsonResponse(400, { error: 'Message is required' }));
        }
        if (!getSession(sessionId)) {
            return send(res, jsonResponse(404, { error: 'Session not found' }));
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

        if (parts[0] === 'health') {
            return send(res, jsonResponse(200, {
                status: 'ok',
                offline: true,
                modelLoaded,
                escalationEnabled: Boolean(process.env.KIOO_ESCALATION_MODEL_PATH),
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

            if (parts.length === 3 && parts[2] === 'chat' && method === 'POST') {
                const payload = parseJson(await readBody(req));
                if (payload === null) {
                    return send(res, jsonResponse(400, { error: 'Invalid JSON body' }));
                }
                return handleChat(res, sessionId, payload.message);
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
                if (!modelLoaded || !modelId) {
                    return send(res, jsonResponse(503, { error: 'Model not loaded. Local model unavailable.' }));
                }
                try {
                    const result = await resolveApproval(sessionId, approvalId, payload.decision, { modelId });
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
