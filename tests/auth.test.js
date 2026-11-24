import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 4500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kioo-auth-'));

let child;
let cookieA;
let cookieB;
let sessionId;

function cookiesToHeader(setCookies) {
    return setCookies.map(value => value.split(';')[0]).join('; ');
}

async function api(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (options.cookie) headers.Cookie = options.cookie;
    const res = await fetch(`${BASE}${pathname}`, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const text = await res.text();
    let data = text;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    return { status: res.status, data, setCookies, cookie: cookiesToHeader(setCookies) };
}

async function waitForServer() {
    for (let i = 0; i < 80; i++) {
        try {
            const res = await fetch(`${BASE}/auth/config`);
            if (res.ok) return;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Auth server did not start in time');
}

describe('auth and profile API', () => {
    before(async () => {
        child = spawn(process.execPath, ['src/ui/server.js'], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                PORT: String(PORT),
                HOST: '127.0.0.1',
                KIOO_SKIP_MODEL: '1',
                KIOO_AUTH_ENABLED: '1',
                KIOO_DB_PATH: path.join(tempDir, 'kioo.db'),
                KIOO_DEV_RESET_TOKENS: '1',
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
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('config reports email auth and disabled Google', async () => {
        const res = await api('/auth/config');
        assert.equal(res.status, 200);
        assert.equal(res.data.enabled, true);
        assert.equal(res.data.google, false);
        assert.equal(res.data.phone, false);
    });

    test('agent routes are gated before sign in', async () => {
        const res = await api('/sessions');
        assert.equal(res.status, 401);
    });

    test('register creates a user, session, and user.md template', async () => {
        const res = await api('/auth/register', {
            method: 'POST',
            body: { name: 'Ada', email: 'ada@example.com', password: 'correct-horse' },
        });
        assert.equal(res.status, 201);
        assert.equal(res.data.user.email, 'ada@example.com');
        assert.ok(res.data.user.id);
        assert.ok(res.cookie.includes('kioo_access='));
        cookieA = res.cookie;

        const profile = await api('/profile', { cookie: cookieA });
        assert.equal(profile.status, 200);
        assert.match(profile.data.user_md, /# About you/);
        assert.match(profile.data.user_md, /- Name:/);
    });

    test('sign in rejects bad passwords and accepts the right one', async () => {
        const bad = await api('/auth/login', {
            method: 'POST',
            body: { email: 'ada@example.com', password: 'wrong-password' },
        });
        assert.equal(bad.status, 401);

        const good = await api('/auth/login', {
            method: 'POST',
            body: { email: 'ada@example.com', password: 'correct-horse' },
        });
        assert.equal(good.status, 200);
        cookieA = good.cookie;
    });

    test('profile markdown can be viewed and updated', async () => {
        const updated = await api('/profile', {
            method: 'PUT',
            cookie: cookieA,
            body: { user_md: '# Ada\n\n- Prefers concise answers' },
        });
        assert.equal(updated.status, 200);
        const profile = await api('/profile', { cookie: cookieA });
        assert.equal(profile.data.user_md, '# Ada\n\n- Prefers concise answers');
    });

    test('refresh rotates the session', async () => {
        const refreshed = await api('/auth/refresh', { method: 'POST', cookie: cookieA });
        assert.equal(refreshed.status, 200);
        const old = await api('/auth/me', { cookie: cookieA });
        assert.equal(old.status, 401);
        cookieA = refreshed.cookie;
        const me = await api('/auth/me', { cookie: cookieA });
        assert.equal(me.status, 200);
        assert.equal(me.data.user.email, 'ada@example.com');
    });

    test('sessions are isolated by account', async () => {
        const created = await api('/sessions', {
            method: 'POST',
            cookie: cookieA,
            body: { title: 'Private chat' },
        });
        assert.equal(created.status, 201);
        sessionId = created.data.id;
        assert.equal(created.data.user_id, (await api('/auth/me', { cookie: cookieA })).data.user.id);

        const other = await api('/auth/register', {
            method: 'POST',
            body: { name: 'Grace', email: 'grace@example.com', password: 'another-password' },
        });
        assert.equal(other.status, 201);
        cookieB = other.cookie;

        const denied = await api(`/sessions/${sessionId}`, { cookie: cookieB });
        assert.equal(denied.status, 404);

        const own = await api('/sessions', { cookie: cookieB });
        assert.deepEqual(own.data.sessions, []);
    });

    test('forgot and reset replace the password and revoke sessions', async () => {
        const forgot = await api('/auth/forgot', {
            method: 'POST',
            body: { email: 'ada@example.com' },
        });
        assert.equal(forgot.status, 200);
        assert.ok(forgot.data.token);

        const old = await api('/auth/me', { cookie: cookieA });
        assert.equal(old.status, 200);

        const reset = await api('/auth/reset', {
            method: 'POST',
            body: {
                token: forgot.data.token,
                password: 'brand-new-password',
                confirm: 'brand-new-password',
            },
        });
        assert.equal(reset.status, 200);

        const revoked = await api('/auth/me', { cookie: cookieA });
        assert.equal(revoked.status, 401);

        const login = await api('/auth/login', {
            method: 'POST',
            body: { email: 'ada@example.com', password: 'brand-new-password' },
        });
        assert.equal(login.status, 200);
        cookieA = login.cookie;
    });

    test('delete account removes the user and owned sessions', async () => {
        const removed = await api('/auth/account', { method: 'DELETE', cookie: cookieA });
        assert.equal(removed.status, 200);

        const login = await api('/auth/login', {
            method: 'POST',
            body: { email: 'ada@example.com', password: 'brand-new-password' },
        });
        assert.equal(login.status, 401);

        const missingSession = await api(`/sessions/${sessionId}`, { cookie: cookieB });
        assert.equal(missingSession.status, 404);
    });
});
