import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AGENT_PORT = 4100 + Math.floor(Math.random() * 400);
const SERVER_PORT = 4500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

let agentServer;
let child;
let lastRequest;

async function waitForServer() {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`${BASE}/health`);
            if (res.ok) return;
        } catch {
            // server not ready yet
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Server did not start in time');
}

describe('Remote agent proxy', () => {
    before(async () => {
        agentServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                lastRequest = JSON.parse(body || '{}');
                const approved = lastRequest.approved_tool_keys || [];
                const risky = lastRequest.message.includes('risky');
                const response = risky && !approved.length
                    ? {
                        session_id: lastRequest.session_id,
                        reply: 'Waiting for your approval.',
                        status: 'waiting_approval',
                        approval: {
                            name: 'send_email',
                            arguments: { to: 'user@example.com' },
                            key: 'send_email:test',
                            risk: 'high',
                        },
                        events: [{ type: 'status', status: 'tool', tool: 'send_email' }],
                    }
                    : {
                        session_id: lastRequest.session_id,
                        reply: 'Remote reply',
                        status: 'completed',
                        model: 'remote-model',
                        tool_calls: [],
                        tool_results: [],
                    };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
            });
        });
        await new Promise(resolve => agentServer.listen(AGENT_PORT, '127.0.0.1', resolve));

        child = spawn(process.execPath, ['src/ui/server.js'], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                PORT: String(SERVER_PORT),
                HOST: '127.0.0.1',
                KIOO_SKIP_MODEL: '1',
                KIOO_AGENT_URL: `http://127.0.0.1:${AGENT_PORT}`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.resume();
        child.stderr.resume();
        await waitForServer();
    });

    after(async () => {
        if (child && child.exitCode === null && !child.killed) {
            child.kill('SIGTERM');
            await new Promise(resolve => child.once('exit', resolve));
        }
        if (agentServer) {
            await new Promise(resolve => agentServer.close(resolve));
        }
    });

    test('health reports remote mode', async () => {
        const res = await fetch(`${BASE}/health`);
        const data = await res.json();
        assert.equal(data.mode, 'remote');
        assert.equal(data.offline, false);
        assert.match(data.agentUrl, /127\.0\.0\.1/);
    });

    test('chat proxies to the remote agent and persists the turn', async () => {
        const session = await (await fetch(`${BASE}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })).json();

        const res = await fetch(`${BASE}/sessions/${session.id}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'hello remote' }),
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.reply, 'Remote reply');
        assert.equal(data.route.provider, 'remote');
        assert.equal(lastRequest.message, 'hello remote');

        const loaded = await (await fetch(`${BASE}/sessions/${session.id}`)).json();
        assert.equal(loaded.messages.length, 2);
        assert.equal(loaded.messages[0].content, 'hello remote');
        assert.equal(loaded.messages[1].content, 'Remote reply');

        await fetch(`${BASE}/sessions/${session.id}`, { method: 'DELETE' });
    });

    test('high-risk remote tools create an approval and resume after approval', async () => {
        const session = await (await fetch(`${BASE}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        })).json();

        const first = await fetch(`${BASE}/sessions/${session.id}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'risky action' }),
        });
        const pending = await first.json();
        assert.equal(pending.status, 'waiting_approval');
        assert.equal(pending.approvals.length, 1);
        assert.equal(pending.approvals[0].tool_name, 'send_email');

        const approvalId = pending.approvals[0].id;
        const approve = await fetch(`${BASE}/sessions/${session.id}/approvals/${approvalId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'approve' }),
        });
        assert.equal(approve.status, 200);
        const resumed = await approve.json();
        assert.equal(resumed.reply, 'Remote reply');
        assert.deepEqual(lastRequest.approved_tool_keys, ['send_email:test']);

        await fetch(`${BASE}/sessions/${session.id}`, { method: 'DELETE' });
    });
});
