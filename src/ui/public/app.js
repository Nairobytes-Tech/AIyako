const API_BASE = '';
const SESSION_KEY = 'kioo_session_id';

let isOnline = navigator.onLine;
let isProcessing = false;
let currentSessionId = localStorage.getItem(SESSION_KEY);

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const tasksContainer = document.getElementById('tasksContainer');
const notesContainer = document.getElementById('notesContainer');
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.chat-view, .goals-view, .library-view, .more-view');
const chatForm = document.getElementById('chatForm');

initApp();

async function initApp() {
    statusText.textContent = 'Idle';
    statusDot.className = 'status-dot idle';
    sendBtn.disabled = true;
    checkHealth();

    initNav();
    initInput();
    await ensureSession();
}

async function ensureSession() {
    if (currentSessionId) {
        try {
            const res = await fetch(`${API_BASE}/sessions/${currentSessionId}`);
            if (res.ok) {
                const session = await res.json();
                if (!session.messages || session.messages.length === 0) {
                    showWelcome();
                } else {
                    renderHistory(session.messages);
                }
                for (const approval of session.approvals || []) {
                    addApproval(approval);
                }
                if ((session.approvals || []).length > 0) {
                    setAgentStatus('busy', 'Waiting for approval');
                }
                await Promise.all([fetchTasks(), fetchNotes()]);
                return;
            }
        } catch {
            // fall through to creating a new session
        }
    }

    try {
        await createNewSession();
        showWelcome();
    } catch (err) {
        addMessage(`Could not start a session: ${err.message}`, 'assistant', 'error');
    }
}

async function createNewSession() {
    const res = await fetch(`${API_BASE}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });

    if (!res.ok) {
        throw new Error('Session creation failed');
    }

    const session = await res.json();
    currentSessionId = session.id;
    localStorage.setItem(SESSION_KEY, currentSessionId);
    return session;
}

function renderHistory(messages) {
    for (const message of messages) {
        if (message.role === 'user') {
            addMessage(message.content, 'user');
        } else if (message.role === 'assistant') {
            if (!message.content || message.content === '[tool_calls]') continue;
            addMessage(message.content, 'assistant');
        } else if (message.role === 'tool') {
            try {
                addToolResult(JSON.parse(message.content));
            } catch {
                // ignore malformed tool payloads
            }
        }
    }
    scrollToBottom();
}

function initNav() {
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            views.forEach(v => v.classList.remove('active'));
            document.getElementById(`${item.dataset.tab}View`).classList.add('active');
            if (item.dataset.tab === 'goals') fetchTasks();
            if (item.dataset.tab === 'library') fetchNotes();
        });
    });
}

function initInput() {
    inputEl.addEventListener('input', () => {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
        sendBtn.disabled = !inputEl.value.trim();
    });

    inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !isProcessing) {
            e.preventDefault();
            if (inputEl.value.trim()) {
                handleSubmit();
            }
        }
    });

    document.getElementById('chatForm').addEventListener('submit', e => {
        e.preventDefault();
        handleSubmit();
    });

    micBtn.addEventListener('click', () => {
        addMessage('Voice input is not available in this version. Please type your message.', 'assistant', 'system');
    });
}

async function checkHealth() {
    try {
        const res = await fetch(`${API_BASE}/health`);
        const data = await res.json();
        if (data.modelLoaded) {
            setAgentStatus('ready', 'Ready');
        } else {
            setAgentStatus('busy', 'Loading...');
        }
    } catch (err) {
        setAgentStatus('idle', 'Offline');
    }
}

function setAgentStatus(state, text) {
    statusText.textContent = text;
    statusDot.className = `status-dot ${state}`;
}

async function handleSubmit() {
    const text = inputEl.value.trim();
    if (!text || isProcessing) return;

    isProcessing = true;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendBtn.disabled = true;

    addMessage(text, 'user');

    const typing = showTyping();

    try {
        setAgentStatus('busy', 'Working...');

        if (!currentSessionId) {
            await createNewSession();
        }

        let res = await fetch(`${API_BASE}/sessions/${currentSessionId}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
        });

        if (res.status === 404) {
            await createNewSession();
            res = await fetch(`${API_BASE}/sessions/${currentSessionId}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
            });
        }

        if (!res.ok) {
            const err = await res.json();
            removeTyping();
            addMessage(`Error: ${err.error || 'Something went wrong'}`, 'assistant', 'error');
            setAgentStatus('idle', 'Error');
            return;
        }

        const data = await res.json();

        removeTyping();

        for (const tc of data.toolCalls) {
            addToolCall(tc.name, tc.arguments);
        }

        for (const tr of data.toolResults) {
            addToolResult(tr);
        }

        for (const approval of data.approvals || []) {
            addApproval(approval);
        }

        if (data.reply) {
            addMessage(data.reply, 'assistant');
        }

        if (data.error) {
            addMessage(`Error: ${data.error}`, 'assistant', 'error');
        }

        if (data.status === 'waiting_approval') {
            setAgentStatus('busy', 'Waiting for approval');
        } else {
            setAgentStatus('ready', 'Ready');
        }

        await Promise.all([fetchTasks(), fetchNotes()]);
    } catch (err) {
        removeTyping();
        addMessage(`Connection error: ${err.message}`, 'assistant', 'error');
        setAgentStatus('idle', 'Offline');
    } finally {
        isProcessing = false;
    }
}

function showWelcome() {
    const welcome = document.createElement('div');
    welcome.className = 'welcome';
    welcome.innerHTML = `
        <div class="message assistant">
            <div class="bubble assistant">
                <div class="bubble-content">Hey! I'm Kioo, your offline AI assistant. I can save notes, track tasks, and help with everyday things. What can I help you with today?</div>
                <div class="time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
            </div>
        </div>
        <div class="suggested-chips">
            <div class="chip" onclick="quickPrompt('Plan my weekend')">Plan my weekend</div>
            <div class="chip" onclick="quickPrompt('Check my tasks')">Check my tasks</div>
        </div>
    `;
    messagesEl.appendChild(welcome);
    scrollToBottom();
}

function quickPrompt(text) {
    inputEl.value = text;
    sendBtn.disabled = false;
    handleSubmit();
}

function showTyping() {
    const div = document.createElement('div');
    div.id = 'typing';
    div.className = 'typing';
    div.innerHTML = `
        <div class="bubble assistant">
            <div class="typing-dots">
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
            </div>
        </div>
    `;
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
}

function removeTyping() {
    const typing = document.getElementById('typing');
    if (typing) typing.remove();
}

function addMessage(text, role, type = '') {
    const div = document.createElement('div');
    const cls = type === 'system' ? 'message system' : `message ${role}`;
    div.className = cls;

    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const bubbleClass = type === 'system' ? '' : (role === 'user' ? 'bubble user' : 'bubble assistant');
    const contentClass = type === 'error' ? 'bubble user' : bubbleClass;

    if (type === 'error') {
        div.className = 'message error';
        div.innerHTML = `<div class="bubble user" style="background:rgba(239,68,68,0.2);border-color:rgba(239,68,68,0.4)">${escapeHtml(text)}</div>`;
    } else {
        div.innerHTML = `
            <div class="${bubbleClass}">
                <div class="bubble-content">${escapeHtml(text)}</div>
                <div class="time">${timeStr}</div>
            </div>
        `;
    }

    messagesEl.appendChild(div);
    scrollToBottom();
}

function addToolCall(name, args) {
    setAgentStatus('busy', `Calling ${name}...`);

    const div = document.createElement('div');
    div.className = 'tool-call';
    div.innerHTML = `
        <span class="tool-name">${escapeHtml(name)}</span>
        ${args ? `<code style="color:#64748b">(${escapeHtml(JSON.stringify(args))})</code>` : ''}
    `;
    messagesEl.appendChild(div);
    scrollToBottom();
}

function addToolResult(result) {
    const div = document.createElement('div');
    const isSuccess = result && result.success;
    const icon = isSuccess ? '✅' : '❌';
    const label = isSuccess ? 'Success' : (result?.error || 'Failed');
    const dataPreview = isSuccess && result.data
        ? `<pre style="margin-top:4px;color:#86efac">${escapeHtml(JSON.stringify(result.data, null, 2))}</pre>`
        : '';

    div.className = `tool-result ${isSuccess ? '' : 'error'}`;
    div.innerHTML = `<span class="result-icon">${icon}</span> ${escapeHtml(label)}${dataPreview}`;
    messagesEl.appendChild(div);
    scrollToBottom();
}

function addApproval(approval) {
    const div = document.createElement('div');
    div.className = 'tool-call approval';
    div.dataset.approvalId = approval.id;
    div.innerHTML = `
        <span class="tool-name">Approval needed</span>
        <code style="color:#64748b">${escapeHtml(approval.tool_name)}(${escapeHtml(JSON.stringify(approval.tool_args || {}))})</code>
        <div class="approval-actions">
            <button type="button" class="approval-btn approve">Approve</button>
            <button type="button" class="approval-btn reject">Reject</button>
        </div>
    `;

    div.querySelector('.approve').addEventListener('click', () => {
        resolveApprovalPrompt(approval.id, 'approve', div);
    });
    div.querySelector('.reject').addEventListener('click', () => {
        resolveApprovalPrompt(approval.id, 'reject', div);
    });

    messagesEl.appendChild(div);
    scrollToBottom();
}

async function resolveApprovalPrompt(approvalId, decision, el) {
    if (!currentSessionId) return;

    el.querySelectorAll('button').forEach(button => { button.disabled = true; });
    setAgentStatus('busy', decision === 'approve' ? 'Approving...' : 'Rejecting...');

    try {
        const res = await fetch(`${API_BASE}/sessions/${currentSessionId}/approvals/${approvalId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision }),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Approval failed');
        }

        const data = await res.json();
        el.remove();

        for (const tc of data.toolCalls || []) addToolCall(tc.name, tc.arguments);
        for (const tr of data.toolResults || []) addToolResult(tr);
        for (const approval of data.approvals || []) addApproval(approval);

        if (data.reply) addMessage(data.reply, 'assistant');
        if (data.error) addMessage(`Error: ${data.error}`, 'assistant', 'error');

        if (data.status === 'waiting_approval') {
            setAgentStatus('busy', 'Waiting for approval');
        } else {
            setAgentStatus('ready', 'Ready');
        }

        await Promise.all([fetchTasks(), fetchNotes()]);
    } catch (err) {
        el.querySelectorAll('button').forEach(button => { button.disabled = false; });
        addMessage(`Approval error: ${err.message}`, 'assistant', 'error');
        setAgentStatus('idle', 'Error');
    }
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return text
        .toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    });
}

async function fetchTasks() {
    if (!currentSessionId) {
        tasksContainer.innerHTML = '<div class="empty-state">No goals yet</div>';
        return;
    }

    try {
        const [tasksRes, goalsRes] = await Promise.all([
            fetch(`${API_BASE}/tasks`),
            fetch(`${API_BASE}/sessions/${currentSessionId}/goals`),
        ]);
        const tasksData = await tasksRes.json();
        const goalsData = goalsRes.ok ? await goalsRes.json() : { goals: [] };
        const tasks = tasksData.tasks || [];
        const goals = goalsData.goals || [];

        if (!tasks.length && !goals.length) {
            tasksContainer.innerHTML = '<div class="empty-state">No goals yet</div>';
            return;
        }

        let html = '';

        if (goals.length) {
            html += '<h3 class="list-heading">Session goals</h3>';
            html += `<ul class="item-list">${goals.map(g => `
                <li class="${g.status === 'done' ? 'completed' : ''}">
                    ${escapeHtml(g.title)}
                    <div class="meta">${escapeHtml(g.status)}${g.progress ? ` • ${escapeHtml(g.progress)}` : ''}</div>
                </li>
            `).join('')}</ul>`;
        }

        if (tasks.length) {
            html += '<h3 class="list-heading">Tasks</h3>';
            html += `<ul class="item-list">${tasks.map(t => `
                <li class="${t.completed ? 'completed' : ''}">
                    ${escapeHtml(t.title)}
                    <div class="meta">ID: ${t.id}${t.due_date ? ` • Due: ${escapeHtml(t.due_date)}` : ''}</div>
                </li>
            `).join('')}</ul>`;
        }

        tasksContainer.innerHTML = html;
    } catch (err) {
        tasksContainer.innerHTML = '<div class="error-message">Failed to load goals</div>';
    }
}

async function fetchNotes() {
    if (!currentSessionId) {
        notesContainer.innerHTML = '<div class="empty-state">No notes yet</div>';
        return;
    }

    try {
        const [notesRes, sessionRes] = await Promise.all([
            fetch(`${API_BASE}/notes`),
            fetch(`${API_BASE}/sessions/${currentSessionId}`),
        ]);
        const notesData = await notesRes.json();
        const sessionData = sessionRes.ok ? await sessionRes.json() : { artifacts: [] };
        const notes = notesData.notes || [];
        const artifacts = sessionData.artifacts || [];

        if (!notes.length && !artifacts.length) {
            notesContainer.innerHTML = '<div class="empty-state">No notes yet</div>';
            return;
        }

        let html = '';

        if (artifacts.length) {
            html += '<h3 class="list-heading">Artifacts</h3>';
            html += `<ul class="item-list">${artifacts.map(a => `
                <li>${escapeHtml(a.title || a.type)}
                    <div class="meta">${escapeHtml(a.type)} • ${new Date(a.created_at).toLocaleString()}</div>
                </li>
            `).join('')}</ul>`;
        }

        if (notes.length) {
            html += '<h3 class="list-heading">Notes</h3>';
            html += `<ul class="item-list">${notes.map(n => `
                <li>${escapeHtml(n.content)}
                    <div class="meta">${new Date(n.created_at + 'T00:00:00').toLocaleString()}</div>
                </li>
            `).join('')}</ul>`;
        }

        notesContainer.innerHTML = html;
    } catch (err) {
        notesContainer.innerHTML = '<div class="error-message">Failed to load notes</div>';
    }
}

window.addEventListener('online', () => {
    isOnline = true;
});

window.addEventListener('offline', () => {
    isOnline = false;
    setAgentStatus('idle', 'Offline');
});

window.quickPrompt = quickPrompt;
