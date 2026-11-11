import { randomUUID } from 'node:crypto';
import { getDb } from '../db/database.js';

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];

function now() {
    return new Date().toISOString();
}

function assertApprovalStatus(status) {
    if (!APPROVAL_STATUSES.includes(status)) {
        throw new Error(`Invalid approval status: ${status}`);
    }
}

function mapApproval(row) {
    if (!row) return null;
    return {
        id: row.id,
        session_id: row.session_id,
        tool_name: row.tool_name,
        tool_args: row.tool_args === null || row.tool_args === undefined ? null : JSON.parse(row.tool_args),
        tool_call_id: row.tool_call_id || null,
        status: row.status,
        executed: Boolean(row.executed),
        result: row.result === null || row.result === undefined ? null : JSON.parse(row.result),
        created_at: row.created_at,
        resolved_at: row.resolved_at,
    };
}

export function createApprovals(sessionId, toolCalls, gate = null) {
    const db = getDb();
    const timestamp = now();

    return toolCalls.map(call => {
        const requiresApproval = typeof gate === 'function' ? Boolean(gate(call)) : false;
        const approval = {
            id: randomUUID(),
            session_id: sessionId,
            tool_name: call.name,
            tool_args: call.arguments === undefined ? null : JSON.stringify(call.arguments),
            tool_call_id: call.id || null,
            status: requiresApproval ? 'pending' : 'approved',
            executed: false,
            result: null,
            created_at: timestamp,
            resolved_at: requiresApproval ? null : timestamp,
        };

        db.prepare(
            'INSERT INTO approvals (id, session_id, tool_name, tool_args, tool_call_id, status, executed, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
            approval.id,
            approval.session_id,
            approval.tool_name,
            approval.tool_args,
            approval.tool_call_id,
            approval.status,
            approval.executed ? 1 : 0,
            approval.created_at,
            approval.resolved_at
        );

        return {
            ...approval,
            tool_args: call.arguments === undefined ? null : call.arguments,
        };
    });
}

export function getApproval(approvalId) {
    const db = getDb();
    return mapApproval(db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId));
}

export function listApprovals(sessionId, status = null) {
    const db = getDb();
    const rows = status
        ? db.prepare('SELECT * FROM approvals WHERE session_id = ? AND status = ? ORDER BY created_at ASC').all(sessionId, status)
        : db.prepare('SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at ASC').all(sessionId);
    return rows.map(mapApproval);
}

export function listPendingApprovals(sessionId) {
    return listApprovals(sessionId, 'pending');
}

export function listUnexecutedApprovals(sessionId) {
    const db = getDb();
    const rows = db.prepare(
        "SELECT * FROM approvals WHERE session_id = ? AND executed = 0 AND status IN ('approved', 'rejected') ORDER BY created_at ASC, rowid ASC"
    ).all(sessionId);
    return rows.map(mapApproval);
}

export function setApprovalStatus(approvalId, status) {
    assertApprovalStatus(status);
    const db = getDb();
    const result = db.prepare(
        'UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = ?'
    ).run(status, now(), approvalId, 'pending');
    return result.changes > 0;
}

export function markApprovalExecuted(approvalId, result = null) {
    const db = getDb();
    const stored = result === null || result === undefined ? null : JSON.stringify(result);
    const update = db.prepare('UPDATE approvals SET executed = 1, result = ? WHERE id = ?').run(stored, approvalId);
    return update.changes > 0;
}

export function listExecutedApprovals(sessionId) {
    const db = getDb();
    const rows = db.prepare(
        'SELECT * FROM approvals WHERE session_id = ? AND executed = 1 AND result IS NOT NULL ORDER BY created_at ASC, rowid ASC'
    ).all(sessionId);
    return rows.map(mapApproval);
}

export function parseApprovalTools(value) {
    if (!value) return [];
    return String(value)
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);
}

export function buildApprovalGate(tools) {
    const list = Array.isArray(tools) ? tools : parseApprovalTools(tools);
    if (list.length === 0) return null;
    const allowed = new Set(list);
    return call => allowed.has(call.name);
}

export { APPROVAL_STATUSES };
