import http from 'node:http';
import fs from 'node:fs';
import { loadAgent, createCompletion, unloadAgent, SYSTEM_PROMPT } from '../agent.js';
import { closeDb, getDb } from '../db/database.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function startServer() {
    let modelId;
    let modelLoaded = false;

    try {
        console.log('\u25b8 Loading local model...');
        modelId = await loadAgent();
        modelLoaded = true;
        console.log('\u25b8 Model loaded successfully');
    } catch (err) {
        console.error('\u25b8 Failed to load model:', err.message);
    }

    function handleRequest(req, res) {
        let body = '';

        req.on('data', chunk => { body += chunk; });

        req.on('end', async () => {
            const url = new URL(req.url, `http://${HOST}:${PORT}`);

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            if (url.pathname === '/health') {
                const r = jsonResponse(200, {
                    status: 'ok',
                    offline: true,
                    modelLoaded,
                });
                res.writeHead(r.status, r.headers);
                res.end(r.body);
                return;
            }

            if (url.pathname === '/chat') {
                if (req.method !== 'POST') {
                    const r = jsonResponse(405, { error: 'Method not allowed' });
                    res.writeHead(r.status, r.headers);
                    res.end(r.body);
                    return;
                }

                if (!modelLoaded || !modelId) {
                    const r = jsonResponse(503, { error: 'Model not loaded. Local model unavailable.' });
                    res.writeHead(r.status, r.headers);
                    res.end(r.body);
                    return;
                }

                try {
                    const { message } = JSON.parse(body || '{}');

                    if (!message || typeof message !== 'string') {
                        const r = jsonResponse(400, { error: 'Message is required' });
                        res.writeHead(r.status, r.headers);
                        res.end(r.body);
                        return;
                    }

                    const history = [
                        { role: 'system', content:
                            'You are Kioo, a local AI assistant that runs entirely offline. ' +
                            'Your job is to help users manage their notes and tasks using the available tools.' },
                        { role: 'user', content: message },
                    ];

                    const result = await createCompletion(modelId, history);

                    const toolCalls = result.events
                        .filter(e => e.type === 'toolCall')
                        .map(e => ({ name: e.call.name, arguments: e.call.arguments }));

                    const toolResults = result.events
                        .filter(e => e.type === 'toolResult')
                        .map(e => e.result);

                    const final = result.events.find(e => e.type === 'final');
                    const finalContent = final?.content || '';

                    const r = jsonResponse(200, {
                        reply: finalContent,
                        toolCalls,
                        toolResults,
                    });
                    res.writeHead(r.status, r.headers);
                    res.end(r.body);
                } catch (err) {
                    const r = jsonResponse(500, { error: err.message });
                    res.writeHead(r.status, r.headers);
                    res.end(r.body);
                }
                return;
            }

            if (url.pathname === '/notes') {
                try {
                    const db = getDb();
                    const notes = db.prepare(
                        'SELECT id, content, created_at FROM notes ORDER BY created_at DESC'
                    ).all();
                    const r = jsonResponse(200, { notes });
                    res.writeHead(r.status, r.headers);
                    res.end(r.body);
                } catch (err) {
                    const r = jsonResponse(500, { error: err.message });
                    res.writeHead(r.status, r.headers);
                    res.end(r.body);
                }
                return;
            }

            if (url.pathname === '/tasks') {
                try {
                    const db = getDb();
                    const tasks = db.prepare(
                        'SELECT id, title, due_date, completed, created_at FROM tasks ORDER BY created_at DESC'
                    ).all();
                    const r = jsonResponse(200, { tasks });
                    res.writeHead(r.status, r.headers);
                    res.end(r.body);
                } catch (err) {
                    const r = jsonResponse(500, { error: err.message });
                    res.writeHead(r.status, r.headers);
                    res.end(r.body);
                }
                return;
            }

            const filePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
            const file = serveFile(filePath);
            res.writeHead(file.status, file.headers);
            res.end(file.body);
        });
    }

    const server = http.createServer(handleRequest);

    server.listen(PORT, HOST, () => {
        console.log(`\u25b8 Kioo AI Server running on http://${HOST}:${PORT}`);
        console.log('\u25b8 Offline mode: local model only');
    });

    process.on('SIGTERM', async () => {
        console.log('\n\u25b8 Shutting down...');
        server.close();
        try { await unloadAgent(); } catch (err) { /* already unloaded */ }
        process.exit(0);
    });

    process.on('SIGINT', async () => {
        console.log('\n\u25b8 Shutting down...');
        server.close();
        try { await unloadAgent(); } catch (err) { /* already unloaded */ }
        process.exit(0);
    });
}

startServer().catch(err => {
    console.error('\u25b8 Server error:', err);
    process.exit(1);
});
