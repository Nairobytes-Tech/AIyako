import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, closeDb } from '../src/db/database.js';
import {
    createSession,
    getSession,
    listSessions,
    updateSessionTitle,
    appendMessage,
    setStatus,
    getMessages,
    deleteSession,
    addArtifact,
    listArtifacts,
} from '../src/runtime/session.js';
import { SessionStatus, onStatusChange } from '../src/runtime/status.js';
import {
    addGoal,
    getGoal,
    listGoals,
    updateGoal,
    deleteGoal,
    syncGoalsFromEvents,
} from '../src/runtime/goals.js';
import {
    buildApprovalGate,
    createApprovals,
    getApproval,
    listExecutedApprovals,
    listPendingApprovals,
    listUnexecutedApprovals,
    markApprovalExecuted,
    parseApprovalTools,
    setApprovalStatus,
} from '../src/runtime/approvals.js';

function clearRuntimeTables() {
    const db = getDb();
    db.exec('DELETE FROM messages');
    db.exec('DELETE FROM goals');
    db.exec('DELETE FROM artifacts');
    db.exec('DELETE FROM approvals');
    db.exec('DELETE FROM sessions');
}

describe('Runtime sessions', () => {
    beforeEach(clearRuntimeTables);
    afterEach(closeDb);

    test('createSession persists an idle session', () => {
        const session = createSession('user-1', 'First chat');
        assert.ok(session.id);
        assert.equal(session.user_id, 'user-1');
        assert.equal(session.title, 'First chat');
        assert.equal(session.status, SessionStatus.IDLE);

        const loaded = getSession(session.id);
        assert.equal(loaded.id, session.id);
        assert.deepEqual(loaded.messages, []);
        assert.deepEqual(loaded.goals, []);
        assert.deepEqual(loaded.artifacts, []);
    });

    test('getSession returns null for unknown id', () => {
        assert.equal(getSession('missing'), null);
    });

    test('createSession defaults user and title to null', () => {
        const session = createSession();
        assert.equal(session.user_id, null);
        assert.equal(session.title, null);
    });

    test('listSessions orders by most recently updated', () => {
        const first = createSession(null, 'older');
        const second = createSession(null, 'newer');
        updateSessionTitle(first.id, 'older updated');

        const ids = listSessions().map(s => s.id);
        assert.equal(ids[0], first.id);
        assert.ok(ids.includes(second.id));
    });

    test('updateSessionTitle returns false for unknown session', () => {
        assert.equal(updateSessionTitle('missing', 'title'), false);
    });

    test('appendMessage stores role, content and tool metadata', () => {
        const session = createSession();

        appendMessage(session.id, 'user', 'hello');
        const toolMessage = appendMessage(session.id, 'tool', '{"success":true}', {
            toolName: 'save_note',
            toolArgs: { text: 'hello' },
        });

        assert.equal(toolMessage.tool_name, 'save_note');
        assert.deepEqual(toolMessage.tool_args, { text: 'hello' });

        const messages = getMessages(session.id);
        assert.equal(messages.length, 2);
        assert.equal(messages[0].role, 'user');
        assert.equal(messages[1].role, 'tool');
        assert.deepEqual(messages[1].tool_args, { text: 'hello' });
    });

    test('appendMessage stores assistant tool calls and tool call ids', () => {
        const session = createSession();
        const calls = [{ id: 'call_1', name: 'save_note', arguments: { text: 'hi' } }];

        const assistant = appendMessage(session.id, 'assistant', '', { toolCalls: calls });
        const tool = appendMessage(session.id, 'tool', '{"success":true}', {
            toolName: 'save_note',
            toolCallId: 'call_1',
        });

        assert.deepEqual(assistant.tool_calls, calls);
        assert.equal(tool.tool_call_id, 'call_1');

        const messages = getMessages(session.id);
        assert.deepEqual(messages[0].tool_calls, calls);
        assert.equal(messages[1].tool_call_id, 'call_1');
    });

    test('appendMessage rejects invalid roles', () => {
        const session = createSession();
        assert.throws(() => appendMessage(session.id, 'robot', 'hi'), /Invalid message role/);
    });

    test('getMessages respects limit and ascending order', () => {
        const session = createSession();
        appendMessage(session.id, 'user', 'one');
        appendMessage(session.id, 'assistant', 'two');
        appendMessage(session.id, 'user', 'three');

        const messages = getMessages(session.id, 2);
        assert.equal(messages.length, 2);
        assert.equal(messages[0].content, 'one');
        assert.equal(messages[1].content, 'two');
    });

    test('setStatus updates the session and rejects invalid values', () => {
        const session = createSession();

        const events = [];
        const unsubscribe = onStatusChange(event => events.push(event));

        assert.equal(setStatus(session.id, SessionStatus.THINKING), true);
        assert.equal(getSession(session.id).status, SessionStatus.THINKING);
        assert.equal(events.length, 1);
        assert.equal(events[0].sessionId, session.id);
        assert.equal(events[0].status, SessionStatus.THINKING);

        unsubscribe();
        assert.throws(() => setStatus(session.id, 'sleeping'), /Invalid session status/);
        assert.equal(setStatus('missing', SessionStatus.IDLE), false);
    });

    test('deleteSession removes its messages, goals and artifacts', () => {
        const session = createSession();
        appendMessage(session.id, 'user', 'hello');
        addGoal(session.id, 'Ship runtime');
        addArtifact(session.id, 'note', 'Plan', 'do the thing');

        assert.equal(deleteSession(session.id), true);
        assert.equal(getSession(session.id), null);

        const db = getDb();
        const messages = db.prepare('SELECT COUNT(*) AS count FROM messages').get();
        const goals = db.prepare('SELECT COUNT(*) AS count FROM goals').get();
        const artifacts = db.prepare('SELECT COUNT(*) AS count FROM artifacts').get();
        assert.equal(messages.count, 0);
        assert.equal(goals.count, 0);
        assert.equal(artifacts.count, 0);
    });

    test('artifacts are stored and listed per session', () => {
        const a = createSession();
        const b = createSession();

        const artifact = addArtifact(a.id, 'summary', 'Weekly summary', 'text body');
        addArtifact(b.id, 'note', 'Other', 'other body');

        assert.equal(artifact.type, 'summary');
        assert.equal(artifact.title, 'Weekly summary');

        const listed = listArtifacts(a.id);
        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, artifact.id);
        assert.equal(getSession(a.id).artifacts.length, 1);
    });
});

describe('Runtime goals', () => {
    beforeEach(clearRuntimeTables);
    afterEach(closeDb);

    test('addGoal persists an active goal by default', () => {
        const session = createSession();
        const goal = addGoal(session.id, 'Launch v1');

        assert.ok(goal.id);
        assert.equal(goal.title, 'Launch v1');
        assert.equal(goal.status, 'active');
        assert.equal(goal.progress, null);
        assert.equal(getGoal(goal.id).title, 'Launch v1');
    });

    test('addGoal rejects invalid status', () => {
        const session = createSession();
        assert.throws(() => addGoal(session.id, 'Bad', { status: 'blocked' }), /Invalid goal status/);
    });

    test('listGoals returns goals for one session only', () => {
        const a = createSession();
        const b = createSession();
        addGoal(a.id, 'Goal A1');
        addGoal(a.id, 'Goal A2');
        addGoal(b.id, 'Goal B1');

        const goals = listGoals(a.id);
        assert.equal(goals.length, 2);
        assert.ok(goals.every(g => g.session_id === a.id));
        assert.equal(getSession(a.id).goals.length, 2);
    });

    test('updateGoal changes fields and rejects invalid status', () => {
        const session = createSession();
        const goal = addGoal(session.id, 'Ship it');

        const updated = updateGoal(goal.id, { status: 'done', progress: '1/1' });
        assert.equal(updated.status, 'done');
        assert.equal(updated.progress, '1/1');
        assert.equal(getGoal(goal.id).status, 'done');

        assert.throws(() => updateGoal(goal.id, { status: 'nope' }), /Invalid goal status/);
        assert.equal(updateGoal('missing', { title: 'x' }), null);
    });

    test('deleteGoal removes a goal', () => {
        const session = createSession();
        const goal = addGoal(session.id, 'Temporary');

        assert.equal(deleteGoal(goal.id), true);
        assert.equal(getGoal(goal.id), null);
        assert.equal(deleteGoal(goal.id), false);
    });
});

describe('Goal extraction', () => {
    beforeEach(clearRuntimeTables);
    afterEach(closeDb);

    test('successful create_task events create a goal', () => {
        const session = createSession();
        const result = syncGoalsFromEvents(session.id, [
            { type: 'toolExecute', name: 'create_task', arguments: { title: 'Review budget' } },
            { type: 'toolResult', result: { success: true, data: { id: 1, title: 'Review budget' } } },
        ]);

        assert.equal(result.created.length, 1);
        const goals = listGoals(session.id);
        assert.equal(goals.length, 1);
        assert.equal(goals[0].title, 'Review budget');
        assert.equal(goals[0].status, 'active');
    });

    test('does not duplicate an active goal for the same title', () => {
        const session = createSession();
        addGoal(session.id, 'Review budget');
        const result = syncGoalsFromEvents(session.id, [
            { type: 'toolExecute', name: 'create_task', arguments: { title: 'Review budget' } },
            { type: 'toolResult', result: { success: true, data: { id: 2, title: 'Review budget' } } },
        ]);

        assert.equal(result.created.length, 0);
        assert.equal(listGoals(session.id).length, 1);
    });

    test('mark_task_done completes the matching goal', () => {
        const session = createSession();
        addGoal(session.id, 'Review budget');

        const result = syncGoalsFromEvents(session.id, [
            { type: 'toolExecute', name: 'mark_task_done', arguments: { id: 1 } },
            { type: 'toolResult', result: { success: true, data: { id: 1, title: 'Review budget' } } },
        ]);

        assert.equal(result.completed.length, 1);
        assert.equal(listGoals(session.id)[0].status, 'done');
    });

    test('failed tool results are ignored', () => {
        const session = createSession();
        const result = syncGoalsFromEvents(session.id, [
            { type: 'toolExecute', name: 'create_task', arguments: { title: 'Nope' } },
            { type: 'toolResult', result: { success: false, error: 'failed' } },
        ]);

        assert.equal(result.created.length, 0);
        assert.equal(listGoals(session.id).length, 0);
    });
});

describe('Approvals', () => {
    beforeEach(clearRuntimeTables);
    afterEach(closeDb);

    test('gated calls become pending and the rest are auto-approved', () => {
        const session = createSession();
        const gate = buildApprovalGate(['save_note']);
        const approvals = createApprovals(session.id, [
            { name: 'save_note', arguments: { text: 'x' } },
            { name: 'list_tasks', arguments: {} },
        ], gate);

        assert.equal(approvals[0].status, 'pending');
        assert.equal(approvals[0].executed, false);
        assert.deepEqual(approvals[0].tool_args, { text: 'x' });
        assert.equal(approvals[1].status, 'approved');

        const pending = listPendingApprovals(session.id);
        assert.equal(pending.length, 1);
        assert.equal(pending[0].tool_name, 'save_note');
    });

    test('without a gate all calls are auto-approved', () => {
        const session = createSession();
        const approvals = createApprovals(session.id, [{ name: 'save_note', arguments: { text: 'x' } }], null);
        assert.equal(approvals[0].status, 'approved');
        assert.equal(listPendingApprovals(session.id).length, 0);
    });

    test('pending approvals can be resolved and executed', () => {
        const session = createSession();
        const [approval] = createApprovals(session.id, [
            { name: 'save_note', arguments: { text: 'x' } },
        ], buildApprovalGate(['save_note']));

        assert.equal(setApprovalStatus(approval.id, 'rejected'), true);
        assert.equal(setApprovalStatus(approval.id, 'approved'), false);
        assert.equal(getApproval(approval.id).status, 'rejected');

        const unexecuted = listUnexecutedApprovals(session.id);
        assert.equal(unexecuted.length, 1);
        assert.equal(markApprovalExecuted(approval.id), true);
        assert.equal(listUnexecutedApprovals(session.id).length, 0);
    });

    test('approvals store tool call ids and execution results', () => {
        const session = createSession();
        const [approval] = createApprovals(session.id, [
            { id: 'call_9', name: 'save_note', arguments: { text: 'x' } },
        ], buildApprovalGate(['save_note']));

        assert.equal(approval.tool_call_id, 'call_9');

        setApprovalStatus(approval.id, 'approved');
        assert.equal(markApprovalExecuted(approval.id, { success: true, data: { id: 1 } }), true);

        const executed = listExecutedApprovals(session.id);
        assert.equal(executed.length, 1);
        assert.equal(executed[0].tool_call_id, 'call_9');
        assert.deepEqual(executed[0].result, { success: true, data: { id: 1 } });
    });

    test('setApprovalStatus rejects invalid statuses', () => {
        const session = createSession();
        const [approval] = createApprovals(session.id, [
            { name: 'save_note', arguments: {} },
        ], buildApprovalGate(['save_note']));
        assert.throws(() => setApprovalStatus(approval.id, 'maybe'), /Invalid approval status/);
    });

    test('parseApprovalTools splits and trims values', () => {
        assert.deepEqual(parseApprovalTools('save_note, create_task ,, mark_task_done'), [
            'save_note',
            'create_task',
            'mark_task_done',
        ]);
        assert.deepEqual(parseApprovalTools(''), []);
    });

    test('buildApprovalGate returns null for no tools', () => {
        assert.equal(buildApprovalGate([]), null);
        assert.equal(buildApprovalGate(''), null);
        assert.equal(buildApprovalGate(['save_note'])({ name: 'save_note' }), true);
        assert.equal(buildApprovalGate(['save_note'])({ name: 'list_tasks' }), false);
    });
});
