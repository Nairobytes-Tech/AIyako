import { loadAgent, createCompletion, SYSTEM_PROMPT, toolCallKey } from '../agent.js';
import { executeTool } from '../tools/index.js';
import { appendMessage, getMessages, getSession, setStatus } from './session.js';
import { SessionStatus } from './status.js';
import { addGoal, listGoals, updateGoal, syncGoalsFromEvents } from './goals.js';
import {
    buildApprovalGate,
    createApprovals,
    getApproval,
    listPendingApprovals,
    listUnexecutedApprovals,
    markApprovalExecuted,
    parseApprovalTools,
    setApprovalStatus,
} from './approvals.js';
import { chooseRoute } from './router.js';

function buildHistory(messages) {
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages
            .filter(m => m.role !== 'system')
            .map(message => {
                const entry = { role: message.role, content: message.content };

                if (message.role === 'assistant' && message.tool_calls) {
                    entry.tool_calls = message.tool_calls;
                }

                if (message.role === 'tool') {
                    if (message.tool_call_id) entry.tool_call_id = message.tool_call_id;
                    if (message.tool_name) entry.name = message.tool_name;
                }

                return entry;
            }),
    ];
}

function getLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return messages[i].content;
    }
    return '';
}

function getApprovalGate(options) {
    if (typeof options.approvalGate === 'function') {
        return options.approvalGate;
    }
    const tools = options.approvalTools || parseApprovalTools(process.env.KIOO_APPROVAL_TOOLS);
    return buildApprovalGate(tools);
}

function persistNewMessages(sessionId, newMessages, events) {
    const toolMeta = events
        .filter(e => e.type === 'toolExecute')
        .map(e => ({ name: e.name, arguments: e.arguments }));

    let toolIndex = 0;

    for (const message of newMessages) {
        if (message.role === 'tool') {
            const meta = toolMeta[toolIndex++] || {};
            appendMessage(sessionId, 'tool', message.content, {
                toolName: message.name || meta.name,
                toolArgs: meta.arguments,
                toolCallId: message.tool_call_id,
            });
        } else if (message.role === 'assistant') {
            appendMessage(sessionId, 'assistant', message.content, {
                toolCalls: message.tool_calls || null,
            });
        } else if (message.role === 'user') {
            appendMessage(sessionId, 'user', message.content);
        }
    }
}

async function safeExecute(call) {
    try {
        return await executeTool(call.name, call.arguments);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function executeApprovalsAndResume(sessionId, options, priorEvents = []) {
    const unexecuted = listUnexecutedApprovals(sessionId);
    const approvalEvents = [];
    const repeatResults = new Map();

    for (const approval of unexecuted) {
        const result = approval.status === 'rejected'
            ? { success: false, error: 'Rejected by user' }
            : await safeExecute({ name: approval.tool_name, arguments: approval.tool_args });

        repeatResults.set(toolCallKey(approval.tool_name, approval.tool_args), result);

        appendMessage(sessionId, 'tool', JSON.stringify(result), {
            toolName: approval.tool_name,
            toolArgs: approval.tool_args,
            toolCallId: approval.tool_call_id,
        });
        markApprovalExecuted(approval.id, result);

        approvalEvents.push({
            type: 'toolExecute',
            name: approval.tool_name,
            arguments: approval.tool_args,
            toolCallId: approval.tool_call_id,
        });
        approvalEvents.push({ type: 'toolResult', result });
    }

    syncGoalsFromEvents(sessionId, approvalEvents);

    return driveCompletion(sessionId, options, [...priorEvents, ...approvalEvents], repeatResults);
}

async function driveCompletion(sessionId, options = {}, extraEvents = [], repeatResults = null) {
    setStatus(sessionId, SessionStatus.THINKING);

    const messages = getMessages(sessionId);
    const route = options.route || chooseRoute(getLastUserMessage(messages), options);

    const modelId = route.provider === 'escalation'
        ? await loadAgent({ ...options, modelPath: route.modelPath })
        : (options.modelId || await loadAgent({ ...options, modelPath: options.modelPath }));

    const gate = getApprovalGate(options);
    const history = buildHistory(messages);
    const initialLength = history.length;

    const result = await createCompletion(modelId, history, { approvalGate: gate, repeatResults });

    persistNewMessages(sessionId, history.slice(initialLength), result.events);

    const events = [...extraEvents, ...result.events];

    if (result.pendingToolCalls && result.pendingToolCalls.length > 0) {
        const approvals = createApprovals(sessionId, result.pendingToolCalls, gate);
        const pending = approvals.filter(a => a.status === 'pending');

        if (pending.length > 0) {
            setStatus(sessionId, SessionStatus.WAITING_APPROVAL);
            return {
                sessionId,
                reply: '',
                events,
                status: SessionStatus.WAITING_APPROVAL,
                error: null,
                approvals: pending,
                route,
            };
        }

        return executeApprovalsAndResume(sessionId, options, events);
    }

    syncGoalsFromEvents(sessionId, result.events);

    const finalEvent = result.events.find(e => e.type === 'final');
    const errorEvent = result.events.find(e => e.type === 'error');

    setStatus(sessionId, SessionStatus.IDLE);

    return {
        sessionId,
        reply: finalEvent?.content || '',
        events,
        status: SessionStatus.IDLE,
        error: errorEvent?.message || null,
        approvals: [],
        route,
    };
}

export async function runTurn(sessionId, userMessage, options = {}) {
    if (typeof userMessage !== 'string' || userMessage.trim() === '') {
        throw new Error('userMessage is required');
    }

    const session = getSession(sessionId);
    if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
    }

    appendMessage(sessionId, 'user', userMessage);

    try {
        return await driveCompletion(sessionId, options);
    } catch (err) {
        setStatus(sessionId, SessionStatus.IDLE);
        throw err;
    }
}

export async function resolveApproval(sessionId, approvalId, decision, options = {}) {
    if (decision !== 'approve' && decision !== 'reject') {
        throw new Error(`Invalid approval decision: ${decision}`);
    }

    const approval = getApproval(approvalId);
    if (!approval || approval.session_id !== sessionId) {
        throw new Error('Approval not found');
    }
    if (approval.status !== 'pending') {
        throw new Error('Approval already resolved');
    }

    setApprovalStatus(approvalId, decision === 'approve' ? 'approved' : 'rejected');

    const pending = listPendingApprovals(sessionId);
    if (pending.length > 0) {
        setStatus(sessionId, SessionStatus.WAITING_APPROVAL);
        return {
            sessionId,
            reply: '',
            events: [],
            status: SessionStatus.WAITING_APPROVAL,
            error: null,
            approvals: pending,
            route: null,
        };
    }

    try {
        return await executeApprovalsAndResume(sessionId, options);
    } catch (err) {
        setStatus(sessionId, SessionStatus.IDLE);
        throw err;
    }
}

export { listGoals, addGoal, updateGoal };
