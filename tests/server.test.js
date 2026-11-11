import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 3900 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

let child;

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

function postJson(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('HTTP server', () => {
    before(async () => {
        child = spawn(process.execPath, ['src/ui/server.js'], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                PORT: String(PORT),
                HOST: '127.0.0.1',
                KIOO_SKIP_MODEL: '1',
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
    });

    test('health reports the local model state', async () => {
        const res = await fetch(`${BASE}/health`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.status, 'ok');
        assert.equal(data.offline, true);
        assert.equal(data.modelLoaded, false);
        assert.equal(data.escalationEnabled, false);
    });

    test('sessions can be created, fetched and deleted', async () => {
        const createRes = await postJson(`${BASE}/sessions`, {});
        assert.equal(createRes.status, 201);
        const session = await createRes.json();
        assert.ok(session.id);
        assert.equal(session.status, 'idle');

        const getRes = await fetch(`${BASE}/sessions/${session.id}`);
        assert.equal(getRes.status, 200);
        const loaded = await getRes.json();
        assert.deepEqual(loaded.messages, []);
        assert.deepEqual(loaded.goals, []);
        assert.deepEqual(loaded.artifacts, []);

        const listRes = await fetch(`${BASE}/sessions`);
        const listed = await listRes.json();
        assert.ok(listed.sessions.some(s => s.id === session.id));

        const deleteRes = await fetch(`${BASE}/sessions/${session.id}`, { method: 'DELETE' });
        assert.equal(deleteRes.status, 200);

        const missingRes = await fetch(`${BASE}/sessions/${session.id}`);
        assert.equal(missingRes.status, 404);
    });

    test('pending approvals endpoint returns a list', async () => {
        const session = await (await postJson(`${BASE}/sessions`, {})).json();

        const res = await fetch(`${BASE}/sessions/${session.id}/approvals`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.deepEqual(data.approvals, []);

        await fetch(`${BASE}/sessions/${session.id}`, { method: 'DELETE' });
    });

    test('status stream sends the initial session status', async () => {
        const session = await (await postJson(`${BASE}/sessions`, {})).json();
        const controller = new AbortController();

        try {
            const res = await fetch(`${BASE}/sessions/${session.id}/events`, {
                signal: controller.signal,
            });
            assert.equal(res.status, 200);
            assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            for (let i = 0; i < 20 && !buffer.includes('"status":"idle"'); i++) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
            }

            assert.match(buffer, /event: status/);
            assert.match(buffer, /"status":"idle"/);
            reader.releaseLock();
        } finally {
            controller.abort();
        }

        await fetch(`${BASE}/sessions/${session.id}`, { method: 'DELETE' });
    });

    test('status stream rejects unknown sessions', async () => {
        const res = await fetch(`${BASE}/sessions/missing/events`);
        assert.equal(res.status, 404);
        const data = await res.json();
        assert.match(data.error, /Session not found/);
    });

    test('goals can be added, listed and updated per session', async () => {
        const session = await (await postJson(`${BASE}/sessions`, {})).json();

        const addRes = await postJson(`${BASE}/sessions/${session.id}/goals`, { title: 'Ship runtime' });
        assert.equal(addRes.status, 201);
        const goal = await addRes.json();
        assert.equal(goal.status, 'active');

        const listRes = await fetch(`${BASE}/sessions/${session.id}/goals`);
        const list = await listRes.json();
        assert.equal(list.goals.length, 1);

        const patchRes = await fetch(`${BASE}/goals/${goal.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'done', progress: '1/1' }),
        });
        assert.equal(patchRes.status, 200);
        const updated = await patchRes.json();
        assert.equal(updated.status, 'done');
        assert.equal(updated.progress, '1/1');

        await fetch(`${BASE}/sessions/${session.id}`, { method: 'DELETE' });
    });

    test('goal creation rejects a missing title', async () => {
        const session = await (await postJson(`${BASE}/sessions`, {})).json();
        const res = await postJson(`${BASE}/sessions/${session.id}/goals`, {});
        assert.equal(res.status, 400);

        await fetch(`${BASE}/sessions/${session.id}`, { method: 'DELETE' });
    });

    test('chat returns 503 when the model is unavailable', async () => {
        const session = await (await postJson(`${BASE}/sessions`, {})).json();
        const res = await postJson(`${BASE}/sessions/${session.id}/chat`, { message: 'hello' });
        assert.equal(res.status, 503);
        const data = await res.json();
        assert.match(data.error, /Model not loaded/);

        await fetch(`${BASE}/sessions/${session.id}`, { method: 'DELETE' });
    });

    test('notes and tasks endpoints return lists', async () => {
        const notesRes = await fetch(`${BASE}/notes`);
        const notes = await notesRes.json();
        assert.equal(notesRes.status, 200);
        assert.ok(Array.isArray(notes.notes));

        const tasksRes = await fetch(`${BASE}/tasks`);
        const tasks = await tasksRes.json();
        assert.equal(tasksRes.status, 200);
        assert.ok(Array.isArray(tasks.tasks));
    });
});
