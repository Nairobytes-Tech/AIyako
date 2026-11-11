import { randomUUID } from 'node:crypto';
import { getDb } from '../db/database.js';
import { assertStatus, emitStatus } from './status.js';
import { listPendingApprovals } from './approvals.js';

const VALID_ROLES = ['system', 'user', 'assistant', 'tool'];

function now() {
    return new Date().toISOString();
}

function assertRole(role) {
    if (!VALID_ROLES.includes(role)) {
        throw new Error(`Invalid message role: ${role}`);
    }
}

function mapSession(row) {
    if (!row) return null;
    return {
        id: row.id,
        user_id: row.user_id,
        title: row.title,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function mapMessage(row) {
    return {
        id: row.id,
        session_id: row.session_id,
        role: row.role,
        content: row.content,
        tool_name: row.tool_name,
        tool_args: row.tool_args === null || row.tool_args === undefined ? null : JSON.parse(row.tool_args),
        tool_calls: row.tool_calls === null || row.tool_calls === undefined ? null : JSON.parse(row.tool_calls),
        tool_call_id: row.tool_call_id || null,
        created_at: row.created_at,
    };
}

export function createSession(userId = null, title = null) {
    const db = getDb();
    const session = {
        id: randomUUID(),
        user_id: userId,
        title,
        status: 'idle',
        created_at: now(),
        updated_at: now(),
    };

    db.prepare(
        'INSERT INTO sessions (id, user_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(session.id, session.user_id, session.title, session.status, session.created_at, session.updated_at);

    return session;
}

export function getSession(sessionId) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!row) return null;

    return {
        ...mapSession(row),
        messages: getMessages(sessionId),
        goals: listSessionGoals(sessionId),
        artifacts: listArtifacts(sessionId),
        approvals: listPendingApprovals(sessionId),
    };
}

export function listSessions() {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
    return rows.map(mapSession);
}

export function updateSessionTitle(sessionId, title) {
    const db = getDb();
    const result = db.prepare(
        'UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?'
    ).run(title, now(), sessionId);
    return result.changes > 0;
}

export function appendMessage(sessionId, role, content, meta = {}) {
    assertRole(role);

    const db = getDb();
    const message = {
        id: randomUUID(),
        session_id: sessionId,
        role,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        tool_name: meta.toolName || null,
        tool_args: meta.toolArgs === undefined || meta.toolArgs === null ? null : JSON.stringify(meta.toolArgs),
        tool_calls: meta.toolCalls === undefined || meta.toolCalls === null ? null : JSON.stringify(meta.toolCalls),
        tool_call_id: meta.toolCallId || null,
        created_at: now(),
    };

    db.prepare(
        'INSERT INTO messages (id, session_id, role, content, tool_name, tool_args, tool_calls, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        message.id,
        message.session_id,
        message.role,
        message.content,
        message.tool_name,
        message.tool_args,
        message.tool_calls,
        message.tool_call_id,
        message.created_at
    );

    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(message.created_at, sessionId);

    return {
        ...message,
        tool_args: meta.toolArgs === undefined ? null : meta.toolArgs,
        tool_calls: meta.toolCalls === undefined ? null : meta.toolCalls,
        tool_call_id: meta.toolCallId || null,
    };
}

export function setStatus(sessionId, status) {
    assertStatus(status);

    const db = getDb();
    const timestamp = now();
    const result = db.prepare(
        'UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?'
    ).run(status, timestamp, sessionId);

    if (result.changes > 0) {
        emitStatus({ sessionId, status, updated_at: timestamp });
    }

    return result.changes > 0;
}

export function getMessages(sessionId, limit = 200) {
    const db = getDb();
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?'
    ).all(sessionId, limit);
    return rows.map(mapMessage);
}

export function deleteSession(sessionId) {
    const db = getDb();
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM goals WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM approvals WHERE session_id = ?').run(sessionId);
    const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return result.changes > 0;
}

export function addArtifact(sessionId, type, title, content) {
    const db = getDb();
    const artifact = {
        id: randomUUID(),
        session_id: sessionId,
        type,
        title,
        content,
        created_at: now(),
    };

    db.prepare(
        'INSERT INTO artifacts (id, session_id, type, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(artifact.id, artifact.session_id, artifact.type, artifact.title, artifact.content, artifact.created_at);

    return artifact;
}

export function listArtifacts(sessionId) {
    const db = getDb();
    return db.prepare(
        'SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC'
    ).all(sessionId);
}

function listSessionGoals(sessionId) {
    const db = getDb();
    return db.prepare(
        'SELECT * FROM goals WHERE session_id = ? ORDER BY created_at DESC'
    ).all(sessionId);
}

export { VALID_ROLES };
