import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgent, unloadAgent } from '../agent.js';
import { getDb } from '../db/database.js';
import { runTurn, resolveApproval } from '../runtime/agentRunner.js';
import { createSession, getSession, listSessions, deleteSession, updateSessionTitle, appendMessage, setStatus } from '../runtime/session.js';
import { addGoal, listGoals, updateGoal } from '../runtime/goals.js';
import { listPendingApprovals, createApprovals, setApprovalStatus, markApprovalExecuted } from '../runtime/approvals.js';
import { onStatusChange } from '../runtime/status.js';
import {
    USER_MD_TEMPLATE,
    consumePasswordReset,
    createAuthSession,
    createPasswordReset,
    createUser,
    deleteAccount,
    findAuthSessionByToken,
    getPasswordHash,
    getProfile,
    getUserByEmail,
    getUserByGoogleId,
    getUserById,
    hashToken,
    revokeAllUserSessions,
    revokeAuthSession,
    rotateAuthSession,
    saveProfile,
    setGoogleId,
    setUserPassword,
    verifyPassword,
} from '../auth/index.js';

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
const AUTH_ENABLED = process.env.KIOO_AUTH_ENABLED !== '0';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';
const ACCESS_TTL_MS = Number(process.env.KIOO_ACCESS_TTL_MS || 15 * 60 * 1000);
const REFRESH_TTL_MS = Number(process.env.KIOO_REFRESH_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const RESET_TTL_MS = Number(process.env.KIOO_RESET_TTL_MS || 60 * 60 * 1000);
const DEV_RESET_TOKENS = process.env.KIOO_DEV_RESET_TOKENS === '1';
const COOKIE_SECURE = process.env.KIOO_COOKIE_SECURE === '1';

const contentTypes = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
};

function jsonResponse(statusCode, data, extraHeaders = {}) {
    return {
        status: statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            ...extraHeaders,
        },
        body: JSON.stringify(data),
    };
}

function send(res, response) {
    for (const [name, value] of Object.entries(response.headers)) {
        res.setHeader(name, value);
    }
    res.writeHead(response.status);
    res.end(response.body);
}

function normalizeApprovalDecision(value) {
    if (value === 'approve' || value === 'approved') return 'approve';
    if (value === 'reject' || value === 'rejected') return 'reject';
    return null;
}

function parseCookies(req) {
    const cookies = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (name) cookies[name] = decodeURIComponent(value);
    }
    return cookies;
}

function cookie(name, value, maxAge) {
    let header = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
    if (maxAge) header += `; Max-Age=${Math.floor(maxAge / 1000)}`;
    if (COOKIE_SECURE) header += '; Secure';
    return header;
}

function authCookies(session) {
    if (!session) {
        return [
            cookie('kioo_access', '', 0),
            cookie('kioo_refresh', '', 0),
        ];
    }
    return [
        cookie('kioo_access', session.accessToken, ACCESS_TTL_MS),
        cookie('kioo_refresh', session.refreshToken, REFRESH_TTL_MS),
    ];
}

function authHeaders(session) {
    return { 'Set-Cookie': authCookies(session) };
}

function publicUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        created_at: user.created_at,
        status: user.status,
    };
}

function issueSession(user, req) {
    return createAuthSession(user.id, req.headers['user-agent'], ACCESS_TTL_MS, REFRESH_TTL_MS);
}

function getAuth(req) {
    if (!AUTH_ENABLED) return null;
    const cookies = parseCookies(req);
    const authorization = String(req.headers.authorization || '');
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
    const accessToken = bearer || cookies.kioo_access;
    const session = findAuthSessionByToken(accessToken, 'access');
    if (!session) return null;
    const user = getUserById(session.user_id);
    if (!user || user.status !== 'active') return null;
    return { user, session };
}

function requireOwnedSession(sessionId, auth) {
    const session = getSession(sessionId);
    if (!session) return null;
    if (AUTH_ENABLED && (!auth || !auth.user || session.user_id !== auth.user.id)) return null;
    return session;
}

function isValidEmail(value) {
    return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isValidPassword(value) {
    return typeof value === 'string' && value.length >= 8;
}

function redirectResponse(location, cookies = []) {
    return {
        status: 302,
        headers: {
            Location: location,
            'Set-Cookie': cookies,
            'Cache-Control': 'no-store',
        },
        body: '',
    };
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

async function callRemoteAgent(sessionId, message, approvedToolKeys = [], userContext = {}) {
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
                user_id: userContext.userId || null,
                user_md: userContext.userMd || null,
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

async function handleAuthRoutes(req, res, parts, url) {
    const method = req.method;

    if (parts[0] === 'auth' && parts[1] === 'config' && method === 'GET') {
        return send(res, jsonResponse(200, {
            enabled: AUTH_ENABLED,
            google: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
            phone: false,
        }));
    }

    if (parts[0] === 'auth' && parts[1] === 'me' && method === 'GET') {
        const auth = getAuth(req);
        if (!auth) {
            return send(res, jsonResponse(401, { error: 'Not signed in' }));
        }
        return send(res, jsonResponse(200, { user: publicUser(auth.user) }));
    }

    if (parts[0] === 'auth' && parts[1] === 'register' && method === 'POST') {
        const payload = parseJson(await readBody(req));
        if (!payload || !isValidEmail(payload.email) || !isValidPassword(payload.password)) {
            return send(res, jsonResponse(400, { error: 'Name, valid email, and password of at least 8 characters are required' }));
        }
        if (getUserByEmail(payload.email)) {
            return send(res, jsonResponse(409, { error: 'An account with that email already exists' }));
        }
        const user = createUser({
            name: payload.name,
            email: payload.email,
            phone: payload.phone,
            password: payload.password,
        });
        const session = issueSession(user, req);
        return send(res, jsonResponse(201, { user: publicUser(user) }, authHeaders(session)));
    }

    if (parts[0] === 'auth' && parts[1] === 'login' && method === 'POST') {
        const payload = parseJson(await readBody(req));
        if (!payload || !isValidEmail(payload.email) || typeof payload.password !== 'string') {
            return send(res, jsonResponse(400, { error: 'Email and password are required' }));
        }
        const user = getUserByEmail(payload.email);
        if (!user || !verifyPassword(payload.password, getPasswordHash(user.id))) {
            return send(res, jsonResponse(401, { error: 'Invalid email or password' }));
        }
        const session = issueSession(user, req);
        return send(res, jsonResponse(200, { user: publicUser(user) }, authHeaders(session)));
    }

    if (parts[0] === 'auth' && parts[1] === 'refresh' && method === 'POST') {
        const refreshToken = parseCookies(req).kioo_refresh;
        const existing = findAuthSessionByToken(refreshToken, 'refresh');
        if (!existing) {
            return send(res, jsonResponse(401, { error: 'Session expired' }, authHeaders(null)));
        }
        const user = getUserById(existing.user_id);
        if (!user || user.status !== 'active') {
            return send(res, jsonResponse(401, { error: 'Account unavailable' }, authHeaders(null)));
        }
        const session = rotateAuthSession(existing, req.headers['user-agent'], ACCESS_TTL_MS, REFRESH_TTL_MS);
        return send(res, jsonResponse(200, { user: publicUser(user) }, authHeaders(session)));
    }

    if (parts[0] === 'auth' && parts[1] === 'logout' && method === 'POST') {
        const cookies = parseCookies(req);
        const authorization = String(req.headers.authorization || '');
        const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
        const session = findAuthSessionByToken(bearer || cookies.kioo_access, 'access')
            || findAuthSessionByToken(cookies.kioo_refresh, 'refresh');
        if (session) revokeAuthSession(session.id);
        return send(res, jsonResponse(200, { ok: true }, authHeaders(null)));
    }

    if (parts[0] === 'auth' && parts[1] === 'forgot' && method === 'POST') {
        const payload = parseJson(await readBody(req));
        if (!payload || !isValidEmail(payload.email)) {
            return send(res, jsonResponse(400, { error: 'A valid email is required' }));
        }
        const user = getUserByEmail(payload.email);
        const response = { ok: true, message: 'If that account exists, a reset link is ready.' };
        if (user) {
            const token = createPasswordReset(user.id, RESET_TTL_MS);
            if (DEV_RESET_TOKENS) {
                response.token = token;
                response.resetUrl = `${url.origin}/?reset=${encodeURIComponent(token)}`;
            }
        }
        return send(res, jsonResponse(200, response));
    }

    if (parts[0] === 'auth' && parts[1] === 'reset' && method === 'POST') {
        const payload = parseJson(await readBody(req));
        if (!payload || !isValidPassword(payload.password) || payload.password !== payload.confirm) {
            return send(res, jsonResponse(400, { error: 'Passwords must match and be at least 8 characters' }));
        }
        const userId = consumePasswordReset(payload.token);
        if (!userId) {
            return send(res, jsonResponse(400, { error: 'Reset link is invalid or expired' }));
        }
        setUserPassword(userId, payload.password);
        revokeAllUserSessions(userId);
        return send(res, jsonResponse(200, { ok: true }));
    }

    if (parts[0] === 'auth' && parts[1] === 'google' && parts.length === 2 && method === 'GET') {
        if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
            return send(res, jsonResponse(503, { error: 'Google Sign-In is not configured' }));
        }
        const state = hashToken(randomUUID());
        const params = new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            redirect_uri: GOOGLE_REDIRECT_URI,
            response_type: 'code',
            scope: 'openid email profile',
            state,
            prompt: 'select_account',
        });
        return send(res, redirectResponse(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, [
            cookie('kioo_oauth_state', state, 10 * 60 * 1000),
        ]));
    }

    if (parts[0] === 'auth' && parts[1] === 'google' && parts[2] === 'callback' && method === 'GET') {
        const cookies = parseCookies(req);
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        if (!code || !state || state !== cookies.kioo_oauth_state) {
            return send(res, redirectResponse('/?authError=google_state'));
        }
        try {
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: GOOGLE_CLIENT_ID,
                    client_secret: GOOGLE_CLIENT_SECRET,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: GOOGLE_REDIRECT_URI,
                }),
            });
            if (!tokenRes.ok) throw new Error('Google token exchange failed');
            const tokenData = await tokenRes.json();
            const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            if (!infoRes.ok) throw new Error('Google profile lookup failed');
            const info = await infoRes.json();
            if (!info.email || !info.sub) throw new Error('Google account is incomplete');

            let user = getUserByGoogleId(info.sub) || getUserByEmail(info.email);
            if (!user) {
                user = createUser({ name: info.name || 'Kioo user', email: info.email, googleId: info.sub });
            } else if (!user.has_google) {
                setGoogleId(user.id, info.sub);
                user = getUserById(user.id);
            }
            const session = issueSession(user, req);
            return send(res, redirectResponse('/', authCookies(session)));
        } catch (err) {
            return send(res, redirectResponse(`/?authError=${encodeURIComponent(err.message)}`));
        }
    }

    if (parts[0] === 'auth' && parts[1] === 'account' && method === 'DELETE') {
        const auth = getAuth(req);
        if (!auth) {
            return send(res, jsonResponse(401, { error: 'Not signed in' }));
        }
        deleteAccount(auth.user.id);
        return send(res, jsonResponse(200, { ok: true }, authHeaders(null)));
    }

    if (parts[0] === 'profile' && (method === 'GET' || method === 'PUT')) {
        const auth = getAuth(req);
        if (AUTH_ENABLED && !auth) {
            return send(res, jsonResponse(401, { error: 'Not signed in' }));
        }
        const userId = auth ? auth.user.id : 'local';
        if (method === 'GET') {
            return send(res, jsonResponse(200, { ...getProfile(userId), template: USER_MD_TEMPLATE }));
        }
        const payload = parseJson(await readBody(req));
        if (!payload || typeof payload.user_md !== 'string' || payload.user_md.length > 20000) {
            return send(res, jsonResponse(400, { error: 'user_md must be markdown under 20000 characters' }));
        }
        return send(res, jsonResponse(200, saveProfile(userId, payload.user_md)));
    }

    return false;
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

    async function handleChat(res, sessionId, message, auth = null) {
        if (!message || typeof message !== 'string') {
            return send(res, jsonResponse(400, { error: 'Message is required' }));
        }
        const ownedSession = requireOwnedSession(sessionId, auth);
        if (!ownedSession) {
            return send(res, jsonResponse(404, { error: 'Session not found' }));
        }
        const userId = ownedSession.user_id || (auth && auth.user && auth.user.id) || null;
        const userContext = {
            userId,
            userMd: userId ? getProfile(userId).user_md : null,
        };

        if (AGENT_URL) {
            setStatus(sessionId, 'thinking');
            try {
                const data = await callRemoteAgent(sessionId, message, [], userContext);

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

        const result = await runTurn(sessionId, message, { modelId, userMd: userContext.userMd });
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

        if (await handleAuthRoutes(req, res, parts, url) !== false) {
            return;
        }

        const auth = AUTH_ENABLED ? getAuth(req) : null;
        const protectedPrefixes = new Set(['notes', 'tasks', 'sessions', 'goals', 'mcp', 'chat']);
        if (AUTH_ENABLED && protectedPrefixes.has(parts[0]) && !auth) {
            return send(res, jsonResponse(401, { error: 'Sign in required' }));
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
                authEnabled: AUTH_ENABLED,
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
                const userId = auth && auth.user ? auth.user.id : null;
                return send(res, jsonResponse(200, { sessions: listSessions(userId) }));
            }

            if (parts.length === 1 && method === 'POST') {
                const payload = parseJson(await readBody(req));
                if (payload === null) {
                    return send(res, jsonResponse(400, { error: 'Invalid JSON body' }));
                }
                const userId = auth && auth.user ? auth.user.id : (payload.userId || null);
                const session = createSession(userId, payload.title || null);
                return send(res, jsonResponse(201, session));
            }

            const sessionId = parts[1];

            if (parts.length === 2 && method === 'GET') {
                const session = requireOwnedSession(sessionId, auth);
                if (!session) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }
                return send(res, jsonResponse(200, session));
            }

            if (parts.length === 2 && method === 'DELETE') {
                if (!requireOwnedSession(sessionId, auth)) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }
                const deleted = deleteSession(sessionId);
                if (!deleted) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }
                return send(res, jsonResponse(200, { ok: true }));
            }

            if (parts.length === 2 && method === 'PATCH') {
                if (!requireOwnedSession(sessionId, auth)) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }
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
                return handleChat(res, sessionId, payload.message, auth);
            }

            if (parts.length === 3 && parts[2] === 'events' && method === 'GET') {
                const session = requireOwnedSession(sessionId, auth);
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
                if (!requireOwnedSession(sessionId, auth)) {
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
                if (!requireOwnedSession(sessionId, auth)) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }
                return send(res, jsonResponse(200, { approvals: listPendingApprovals(sessionId) }));
            }

            if (parts.length === 4 && parts[2] === 'approvals' && method === 'POST') {
                const ownedSession = requireOwnedSession(sessionId, auth);
                if (!ownedSession) {
                    return send(res, jsonResponse(404, { error: 'Session not found' }));
                }
                const userId = ownedSession.user_id || (auth && auth.user && auth.user.id) || null;
                const userContext = {
                    userId,
                    userMd: userId ? getProfile(userId).user_md : null,
                };
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

                        const data = await callRemoteAgent(sessionId, remote.message, [remote.key], userContext);
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
                    const result = await resolveApproval(sessionId, approvalId, decision, {
                        modelId,
                        userMd: userContext.userMd,
                    });
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
            const userId = auth && auth.user ? auth.user.id : null;
            const sessionId = payload.sessionId || createSession(userId).id;
            return handleChat(res, sessionId, payload.message, auth);
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
