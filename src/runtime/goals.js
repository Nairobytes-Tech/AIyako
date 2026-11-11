import { randomUUID } from 'node:crypto';
import { getDb } from '../db/database.js';

const GOAL_STATUSES = ['active', 'done', 'paused'];

function now() {
    return new Date().toISOString();
}

function assertGoalStatus(status) {
    if (!GOAL_STATUSES.includes(status)) {
        throw new Error(`Invalid goal status: ${status}`);
    }
}

function mapGoal(row) {
    if (!row) return null;
    return {
        id: row.id,
        session_id: row.session_id,
        title: row.title,
        status: row.status,
        progress: row.progress,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

export function addGoal(sessionId, title, options = {}) {
    const status = options.status || 'active';
    const progress = options.progress === undefined ? null : options.progress;
    assertGoalStatus(status);

    const db = getDb();
    const goal = {
        id: randomUUID(),
        session_id: sessionId,
        title,
        status,
        progress,
        created_at: now(),
        updated_at: now(),
    };

    db.prepare(
        'INSERT INTO goals (id, session_id, title, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(goal.id, goal.session_id, goal.title, goal.status, goal.progress, goal.created_at, goal.updated_at);

    return goal;
}

export function getGoal(goalId) {
    const db = getDb();
    return mapGoal(db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId));
}

export function listGoals(sessionId) {
    const db = getDb();
    const rows = db.prepare(
        'SELECT * FROM goals WHERE session_id = ? ORDER BY created_at DESC'
    ).all(sessionId);
    return rows.map(mapGoal);
}

export function updateGoal(goalId, fields = {}) {
    const existing = getGoal(goalId);
    if (!existing) return null;

    const next = {
        title: fields.title === undefined ? existing.title : fields.title,
        status: fields.status === undefined ? existing.status : fields.status,
        progress: fields.progress === undefined ? existing.progress : fields.progress,
        updated_at: now(),
    };
    assertGoalStatus(next.status);

    const db = getDb();
    db.prepare(
        'UPDATE goals SET title = ?, status = ?, progress = ?, updated_at = ? WHERE id = ?'
    ).run(next.title, next.status, next.progress, next.updated_at, goalId);

    return getGoal(goalId);
}

export function deleteGoal(goalId) {
    const db = getDb();
    return db.prepare('DELETE FROM goals WHERE id = ?').run(goalId).changes > 0;
}

export function findGoalByTitle(sessionId, title, status = null) {
    const db = getDb();
    const row = status
        ? db.prepare(
            'SELECT * FROM goals WHERE session_id = ? AND title = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
        ).get(sessionId, title, status)
        : db.prepare(
            'SELECT * FROM goals WHERE session_id = ? AND title = ? ORDER BY created_at DESC LIMIT 1'
        ).get(sessionId, title);
    return mapGoal(row);
}

export function syncGoalsFromEvents(sessionId, events = []) {
    const created = [];
    const completed = [];
    const queue = [];

    for (const event of events) {
        if (event.type === 'toolExecute') {
            queue.push({ name: event.name, arguments: event.arguments });
            continue;
        }

        if (event.type !== 'toolResult') continue;

        const call = queue.shift();
        if (!call || !event.result || !event.result.success) continue;

        const data = event.result.data || {};

        if (call.name === 'create_task' && data.title) {
            const existing = findGoalByTitle(sessionId, data.title, 'active');
            if (!existing) {
                created.push(addGoal(sessionId, data.title, { progress: `task #${data.id}` }));
            }
        } else if (call.name === 'mark_task_done' && data.title) {
            const goal = findGoalByTitle(sessionId, data.title, 'active')
                || findGoalByTitle(sessionId, data.title);
            if (goal && goal.status !== 'done') {
                completed.push(updateGoal(goal.id, { status: 'done', progress: 'completed' }));
            }
        }
    }

    return { created, completed };
}

export { GOAL_STATUSES };
