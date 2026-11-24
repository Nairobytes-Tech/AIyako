const API_BASE = '';
const SESSION_KEY = 'kioo_session_id';

let isOnline = navigator.onLine;
let isProcessing = false;
let currentSessionId = localStorage.getItem(SESSION_KEY);
let statusSource = null;
let libraryTab = 'notes';
let cachedNotes = [];
let cachedArtifacts = [];

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const micBtn = document.getElementById('micBtn');
const tasksContainer = document.getElementById('tasksContainer');
const notesContainer = document.getElementById('notesContainer');
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.chat-view, .goals-view, .library-view, .profile-view, .more-view');
const chatForm = document.getElementById('chatForm');
const sessionSelect = document.getElementById('sessionSelect');
const newChatBtn = document.getElementById('newChatBtn');
const renameSessionBtn = document.getElementById('renameSessionBtn');
const deleteSessionBtn = document.getElementById('deleteSessionBtn');
const goalForm = document.getElementById('goalForm');
const goalInput = document.getElementById('goalInput');
const settingModel = document.getElementById('settingModel');
const settingMode = document.getElementById('settingMode');
const settingEscalation = document.getElementById('settingEscalation');
const settingMcp = document.getElementById('settingMcp');
const settingNetwork = document.getElementById('settingNetwork');
const mcpContainer = document.getElementById('mcpContainer');
const authShell = document.getElementById('authShell');
const appShell = document.getElementById('appShell');
const authScreens = document.querySelectorAll('.auth-screen');
const onboarding = document.getElementById('onboarding');
const profilePreview = document.getElementById('profilePreview');
const profileEditor = document.getElementById('profileEditor');
const profileInput = document.getElementById('profileInput');
const profileUpdated = document.getElementById('profileUpdated');
let currentUser = null;
let profileData = null;
let authConfig = null;
let pendingOnboarding = false;

initApp();

async function apiFetch(url, options = {}, retry = true) {
    const request = { ...options, credentials: 'same-origin' };
    const response = await window.fetch(url, request);
    if (response.status === 401 && retry && !String(url).includes('/auth/')) {
        const refreshed = await window.fetch(`${API_BASE}/auth/refresh`, {
            method: 'POST',
            credentials: 'same-origin',
        });
        if (refreshed.ok) {
            return apiFetch(url, options, false);
        }
        showAuth();
    }
    return response;
}

async function initApp() {
    statusText.textContent = 'Idle';
    statusDot.className = 'status-dot idle';
    sendBtn.disabled = true;
    initAuthForms();

    try {
        const configRes = await apiFetch('/auth/config');
        authConfig = await configRes.json();
        if (!authConfig.google) {
            const googleBtn = document.getElementById('googleBtn');
            googleBtn.disabled = true;
            googleBtn.textContent = 'Google Sign-In not configured';
        }
        if (authConfig.enabled) {
            const meRes = await apiFetch('/auth/me');
            if (!meRes.ok) {
                showAuth();
                return;
            }
            currentUser = (await meRes.json()).user;
        }
        await showApp();
    } catch {
        showAuth();
    }
}

async function showApp() {
    authShell.classList.add('hidden');
    appShell.classList.remove('hidden');
    checkHealth();
    initNav();
    initInput();
    initSessionControls();
    initGoals();
    initLibraryTabs();
    initProfile();
    await ensureSession(currentSessionId);
    await fetchProfile();
}

function showAuth(screen = 'authWelcome') {
    if (statusSource) {
        statusSource.close();
        statusSource = null;
    }
    appShell.classList.add('hidden');
    onboarding.classList.add('hidden');
    authShell.classList.remove('hidden');
    showAuthScreen(screen);
}

function showAuthScreen(screen) {
    authScreens.forEach(item => item.classList.toggle('active', item.id === screen));
    clearAuthErrors();
}

function clearAuthErrors() {
    document.querySelectorAll('.field-error').forEach(item => { item.textContent = ''; });
}

function setFieldError(id, message) {
    const el = document.getElementById(id);
    if (el) el.textContent = message || '';
}

function setBusy(button, busy, busyText, idleText) {
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? busyText : idleText;
}

async function ensureSession(preferredId) {
    if (preferredId) {
        try {
            const res = await apiFetch(`${API_BASE}/sessions/${preferredId}`);
            if (res.ok) {
                await activateSession(await res.json());
                return;
            }
        } catch {
            // fall through to creating a new session
        }
    }

    await startNewChat();
}

async function activateSession(session) {
    currentSessionId = session.id;
    localStorage.setItem(SESSION_KEY, currentSessionId);

    messagesEl.innerHTML = '';
    libraryTab = 'notes';
    document.querySelectorAll('.tab-subitem').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.subtab === libraryTab);
    });

    if (session.messages && session.messages.length > 0) {
        renderHistory(session.messages);
    } else {
        showWelcome();
    }

    for (const approval of session.approvals || []) {
        addApproval(approval);
    }

    applySessionStatus(session.status || 'idle');
    if ((session.approvals || []).length > 0) {
        setAgentStatus('busy', 'Waiting for approval');
    }

    await refreshSessionList();
    subscribeToStatus();
    await Promise.all([fetchTasks(), fetchNotes()]);
}

async function startNewChat() {
    try {
        const session = await createNewSession();
        await activateSession({
            messages: [],
            approvals: [],
            artifacts: [],
            goals: [],
            ...session,
        });
    } catch (err) {
        addMessage(`Could not start a session: ${err.message}`, 'assistant', 'error');
    }
}

async function switchSession(sessionId) {
    if (!sessionId || sessionId === currentSessionId) return;
    if (isProcessing) {
        sessionSelect.value = currentSessionId;
        return;
    }

    try {
        const res = await apiFetch(`${API_BASE}/sessions/${sessionId}`);
        if (!res.ok) throw new Error('Session not found');
        await activateSession(await res.json());
    } catch (err) {
        addMessage(`Could not load session: ${err.message}`, 'assistant', 'error');
        await refreshSessionList();
    }
}

async function refreshSessionList() {
    try {
        const res = await apiFetch(`${API_BASE}/sessions`);
        if (!res.ok) return;
        const data = await res.json();
        sessionSelect.innerHTML = '';

        for (const session of data.sessions || []) {
            const option = document.createElement('option');
            option.value = session.id;
            option.textContent = session.title || `Chat ${session.id.slice(0, 8)}`;
            sessionSelect.appendChild(option);
        }

        if (currentSessionId) sessionSelect.value = currentSessionId;
    } catch {
        // keep the existing list if the server is unreachable
    }
}

function applySessionStatus(status, tool = null) {
    if (status === 'thinking') {
        setAgentStatus('busy', 'Working...');
    } else if (status === 'tool') {
        setAgentStatus('busy', tool === 'web_search' ? 'Searching the web...' : 'Calling tool...');
    } else if (status === 'waiting_approval') {
        setAgentStatus('busy', 'Waiting for approval');
    } else {
        setAgentStatus('idle', 'Idle');
    }
}

function subscribeToStatus() {
    if (statusSource) {
        statusSource.close();
        statusSource = null;
    }
    if (!currentSessionId) return;

    statusSource = new EventSource(`${API_BASE}/sessions/${currentSessionId}/events`);
    statusSource.addEventListener('status', event => {
        try {
            const data = JSON.parse(event.data);
            applySessionStatus(data.status, data.tool);
        } catch {
            // ignore malformed events
        }
    });
    statusSource.addEventListener('error', () => {
        if (!navigator.onLine) setAgentStatus('idle', 'Offline');
    });
}

async function createNewSession() {
    const res = await apiFetch(`${API_BASE}/sessions`, {
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
            for (const call of message.tool_calls || []) {
                addToolCall(call.name, call.arguments, true);
            }
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
            if (item.dataset.tab === 'more') fetchMcp();
        });
    });
}

function initSessionControls() {
    sessionSelect.addEventListener('change', () => switchSession(sessionSelect.value));
    newChatBtn.addEventListener('click', () => {
        if (isProcessing) return;
        startNewChat();
    });
    renameSessionBtn.addEventListener('click', renameCurrentSession);
    deleteSessionBtn.addEventListener('click', deleteCurrentSession);
}

async function renameCurrentSession() {
    if (!currentSessionId || isProcessing) return;
    const option = sessionSelect.selectedOptions[0];
    const suggested = option ? option.textContent : '';
    const title = window.prompt('Chat title', suggested);
    if (!title || !title.trim()) return;

    try {
        const res = await apiFetch(`${API_BASE}/sessions/${currentSessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title.trim() }),
        });
        if (!res.ok) throw new Error('Could not rename chat');
        await refreshSessionList();
    } catch (err) {
        addMessage(`Rename failed: ${err.message}`, 'assistant', 'error');
    }
}

async function deleteCurrentSession() {
    if (!currentSessionId || isProcessing) return;
    if (!window.confirm('Delete this chat? This cannot be undone.')) return;

    try {
        const res = await apiFetch(`${API_BASE}/sessions/${currentSessionId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Could not delete chat');
        localStorage.removeItem(SESSION_KEY);
        currentSessionId = null;
        await startNewChat();
    } catch (err) {
        addMessage(`Delete failed: ${err.message}`, 'assistant', 'error');
    }
}

function initGoals() {
    goalForm.addEventListener('submit', async event => {
        event.preventDefault();
        const title = goalInput.value.trim();
        if (!title || !currentSessionId) return;

        try {
            const res = await apiFetch(`${API_BASE}/sessions/${currentSessionId}/goals`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Could not add goal');
            }

            goalInput.value = '';
            await fetchTasks();
        } catch (err) {
            addMessage(`Goal error: ${err.message}`, 'assistant', 'error');
        }
    });
}

function initLibraryTabs() {
    document.querySelectorAll('.tab-subitem').forEach(tab => {
        tab.addEventListener('click', () => {
            libraryTab = tab.dataset.subtab;
            document.querySelectorAll('.tab-subitem').forEach(item => {
                item.classList.toggle('active', item === tab);
            });
            renderLibrary();
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
        const res = await apiFetch(`${API_BASE}/health`);
        const data = await res.json();
        if (!data || data.status !== 'ok') {
            setAgentStatus('idle', 'Unavailable');
        } else if (data.mode === 'remote') {
            setAgentStatus('ready', 'Remote agent');
        } else if (data.modelLoaded) {
            setAgentStatus('ready', 'Ready');
        } else {
            setAgentStatus('busy', 'Loading...');
        }

        settingModel.textContent = data.model || 'Unknown';
        settingMode.textContent = data.mode === 'remote' ? 'Remote agent' : 'Local QVAC';
        settingEscalation.textContent = data.escalationModel || 'Off';
        settingMcp.textContent = data.mcpGateway ? 'Connected' : 'Off';
        settingNetwork.textContent = isOnline ? 'Online' : 'Offline';
    } catch (err) {
        setAgentStatus('idle', 'Offline');
        settingModel.textContent = 'Unavailable';
        settingMode.textContent = 'Unavailable';
        settingNetwork.textContent = 'Offline';
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

        let res = await apiFetch(`${API_BASE}/sessions/${currentSessionId}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
        });

        if (res.status === 404) {
            await createNewSession();
            res = await apiFetch(`${API_BASE}/sessions/${currentSessionId}/chat`, {
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

        for (const event of data.events || []) {
            if (event.type === 'status' && event.tool) {
                setAgentStatus('busy', `Calling ${event.tool}...`);
            }
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

        applySessionStatus(data.status);

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

function addToolCall(name, args, silent = false) {
    if (!silent) setAgentStatus('busy', `Calling ${name}...`);

    const div = document.createElement('div');
    div.className = 'tool-call';
    div.innerHTML = `
        <span class="tool-name">${escapeHtml(name)}</span>
        ${args ? `<code style="color:#64748b">(${escapeHtml(JSON.stringify(args))})</code>` : ''}
    `;
    messagesEl.appendChild(div);
    scrollToBottom();
}

function safeUrl(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
        return null;
    }
}

function renderSearchResultCards(data) {
    const rows = (data.results || []).map(item => {
        const href = safeUrl(item.url);
        const title = escapeHtml(item.title || item.url || 'Result');
        const snippet = escapeHtml(item.snippet || '');
        const link = href
            ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>`
            : title;
        return `<div class="search-result">${link}${snippet ? `<div class="search-snippet">${snippet}</div>` : ''}</div>`;
    });

    if (!rows.length) {
        return '<div class="search-results">No usable results returned.</div>';
    }
    return `<div class="search-results">${rows.join('')}</div>`;
}

function addToolResult(result) {
    const div = document.createElement('div');
    const isSuccess = result && result.success;
    const icon = isSuccess ? '✅' : '❌';
    const label = isSuccess ? 'Success' : (result?.error || 'Failed');
    const isSearch = isSuccess && result.data && Array.isArray(result.data.results);
    const dataPreview = isSuccess && result.data
        ? (isSearch
            ? renderSearchResultCards(result.data)
            : `<pre style="margin-top:4px;color:#86efac">${escapeHtml(JSON.stringify(result.data, null, 2))}</pre>`)
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
        const res = await apiFetch(`${API_BASE}/sessions/${currentSessionId}/approvals/${approvalId}`, {
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

        applySessionStatus(data.status);

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

function formatTimestamp(value) {
    if (!value) return '';
    const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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
            apiFetch(`${API_BASE}/tasks`),
            apiFetch(`${API_BASE}/sessions/${currentSessionId}/goals`),
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
            html += `<ul class="item-list">${goals.map(goal => `
                <li data-goal-id="${goal.id}">
                    ${escapeHtml(goal.title)}
                    <div class="goal-controls">
                        <select class="goal-status" data-goal-id="${goal.id}" aria-label="Goal status">
                            <option value="active"${goal.status === 'active' ? ' selected' : ''}>Active</option>
                            <option value="done"${goal.status === 'done' ? ' selected' : ''}>Done</option>
                            <option value="paused"${goal.status === 'paused' ? ' selected' : ''}>Paused</option>
                        </select>
                        <input class="goal-progress" data-goal-id="${goal.id}" value="${escapeHtml(goal.progress || '')}" placeholder="Progress" aria-label="Goal progress">
                    </div>
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

        tasksContainer.querySelectorAll('.goal-status').forEach(select => {
            select.addEventListener('change', () => {
                updateGoalField(select.dataset.goalId, { status: select.value });
            });
        });

        tasksContainer.querySelectorAll('.goal-progress').forEach(input => {
            const commit = () => {
                updateGoalField(input.dataset.goalId, { progress: input.value.trim() || null });
            };
            input.addEventListener('change', commit);
            input.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    input.blur();
                }
            });
        });
    } catch (err) {
        tasksContainer.innerHTML = '<div class="error-message">Failed to load goals</div>';
    }
}

async function updateGoalField(goalId, fields) {
    try {
        const res = await apiFetch(`${API_BASE}/goals/${goalId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fields),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Could not update goal');
        }

        await fetchTasks();
    } catch (err) {
        addMessage(`Goal update failed: ${err.message}`, 'assistant', 'error');
    }
}

async function fetchMcp() {
    mcpContainer.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
        const [toolsRes, auditRes] = await Promise.all([
            apiFetch(`${API_BASE}/mcp/tools`),
            apiFetch(`${API_BASE}/mcp/audit`),
        ]);
        const toolsData = await toolsRes.json();
        const auditData = await auditRes.json();
        const tools = toolsData.tools || [];
        const events = auditData.events || [];

        let html = '<div class="mcp-section-title">Available tools</div>';
        if (!tools.length) {
            html += '<div class="empty-state">No MCP tools registered</div>';
        } else {
            html += `<ul class="item-list">${tools.map(tool => {
                const definition = tool.function || tool;
                return `<li>${escapeHtml(definition.name || 'tool')}
                    <div class="meta">${escapeHtml(definition.description || 'MCP tool')}</div>
                </li>`;
            }).join('')}</ul>`;
        }

        html += '<div class="mcp-section-title">Recent activity</div>';
        if (!events.length) {
            html += '<div class="empty-state">No connector activity yet</div>';
        } else {
            html += `<ul class="item-list">${events.slice(0, 12).map(event => `
                <li>${escapeHtml(event.tool || event.connector || 'event')}
                    <div class="meta">${escapeHtml(event.status || '')} • ${formatTimestamp(event.created_at)}</div>
                </li>
            `).join('')}</ul>`;
        }
        mcpContainer.innerHTML = html;
    } catch (err) {
        mcpContainer.innerHTML = `<div class="error-message">MCP Gateway unavailable: ${escapeHtml(err.message)}</div>`;
    }
}

async function fetchNotes() {
    if (!currentSessionId) {
        cachedNotes = [];
        cachedArtifacts = [];
        renderLibrary();
        return;
    }

    try {
        const [notesRes, sessionRes] = await Promise.all([
            apiFetch(`${API_BASE}/notes`),
            apiFetch(`${API_BASE}/sessions/${currentSessionId}`),
        ]);
        const notesData = await notesRes.json();
        const sessionData = sessionRes.ok ? await sessionRes.json() : { artifacts: [] };
        cachedNotes = notesData.notes || [];
        cachedArtifacts = sessionData.artifacts || [];
        renderLibrary();
    } catch (err) {
        notesContainer.innerHTML = '<div class="error-message">Failed to load library</div>';
    }
}

function renderLibrary() {
    if (libraryTab === 'artifacts') {
        if (!cachedArtifacts.length) {
            notesContainer.innerHTML = '<div class="empty-state">No artifacts yet</div>';
            return;
        }
        notesContainer.innerHTML = `<ul class="item-list">${cachedArtifacts.map(artifact => `
            <li>${escapeHtml(artifact.title || artifact.type)}
                <div class="meta">${escapeHtml(artifact.type)} • ${formatTimestamp(artifact.created_at)}</div>
            </li>
        `).join('')}</ul>`;
        return;
    }

    if (!cachedNotes.length) {
        notesContainer.innerHTML = '<div class="empty-state">No notes yet</div>';
        return;
    }
    notesContainer.innerHTML = `<ul class="item-list">${cachedNotes.map(note => `
        <li>${escapeHtml(note.content)}
            <div class="meta">${formatTimestamp(note.created_at)}</div>
        </li>
    `).join('')}</ul>`;
}

window.addEventListener('online', () => {
    isOnline = true;
    settingNetwork.textContent = 'Online';
});

window.addEventListener('beforeunload', () => {
    if (statusSource) statusSource.close();
});

window.addEventListener('offline', () => {
    isOnline = false;
    settingNetwork.textContent = 'Offline';
    setAgentStatus('idle', 'Offline');
});

function initAuthForms() {
    document.querySelectorAll('[data-auth-screen]').forEach(button => {
        button.addEventListener('click', () => showAuthScreen(button.dataset.authScreen));
    });

    document.querySelectorAll('.reveal-btn').forEach(button => {
        button.addEventListener('click', () => {
            const input = document.getElementById(button.dataset.target);
            if (!input) return;
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            button.textContent = showing ? 'SHOW' : 'HIDE';
        });
    });

    const googleBtn = document.getElementById('googleBtn');
    googleBtn.addEventListener('click', () => {
        window.location.href = '/auth/google';
    });

    document.getElementById('registerForm').addEventListener('submit', async event => {
        event.preventDefault();
        pendingOnboarding = true;
        const data = await authRequest('/auth/register', {
            name: document.getElementById('registerName').value.trim(),
            email: document.getElementById('registerEmail').value.trim(),
            password: document.getElementById('registerPassword').value,
        }, document.getElementById('registerSubmit'), 'CREATING...', 'Create account', 'registerEmailError');
        if (data) {
            currentUser = data.user;
            await showApp();
        }
    });

    document.getElementById('signinForm').addEventListener('submit', async event => {
        event.preventDefault();
        const data = await authRequest('/auth/login', {
            email: document.getElementById('signinEmail').value.trim(),
            password: document.getElementById('signinPassword').value,
        }, document.getElementById('signinSubmit'), 'SIGNING IN...', 'Sign in', 'signinPasswordError');
        if (data) {
            currentUser = data.user;
            await showApp();
        }
    });

    document.getElementById('forgotForm').addEventListener('submit', async event => {
        event.preventDefault();
        const data = await authRequest('/auth/forgot', {
            email: document.getElementById('forgotEmail').value.trim(),
        }, document.getElementById('forgotSubmit'), 'SENDING...', 'Send reset link', 'forgotEmailError');
        if (!data) return;
        const success = document.getElementById('forgotSuccess');
        success.classList.remove('hidden');
        success.innerHTML = data.token
            ? `Development reset link:<br><a href="${escapeHtml(data.resetUrl)}">${escapeHtml(data.resetUrl)}</a>`
            : escapeHtml(data.message);
    });

    document.getElementById('resetForm').addEventListener('submit', async event => {
        event.preventDefault();
        const token = new URLSearchParams(window.location.search).get('reset');
        const data = await authRequest('/auth/reset', {
            token,
            password: document.getElementById('resetPassword').value,
            confirm: document.getElementById('resetConfirm').value,
        }, document.getElementById('resetSubmit'), 'SAVING...', 'Save password', 'resetError');
        if (data) {
            window.history.replaceState({}, '', window.location.pathname);
            showAuthScreen('authSignin');
        }
    });

    const resetToken = new URLSearchParams(window.location.search).get('reset');
    const authError = new URLSearchParams(window.location.search).get('authError');
    if (resetToken) {
        showAuthScreen('authReset');
    } else if (authError) {
        document.getElementById('authWelcomeError').textContent = `Google sign-in failed: ${authError}`;
    }
}

async function authRequest(path, body, button, busyText, idleText, errorId) {
    clearAuthErrors();
    setBusy(button, true, busyText, idleText);
    try {
        const res = await apiFetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    } catch (err) {
        setFieldError(errorId, err.message);
        return null;
    } finally {
        setBusy(button, false, busyText, idleText);
    }
}

function initProfile() {
    document.getElementById('signOutBtn').addEventListener('click', signOut);
    document.getElementById('deleteAccountBtn').addEventListener('click', deleteUserAccount);
    document.getElementById('editProfileBtn').addEventListener('click', () => {
        profileEditor.classList.remove('hidden');
        profileInput.value = profileData ? profileData.user_md : '';
        profileInput.focus();
    });
    document.getElementById('cancelProfileBtn').addEventListener('click', () => {
        profileEditor.classList.add('hidden');
    });
    document.getElementById('saveProfileBtn').addEventListener('click', saveUserProfile);
    document.getElementById('onboardingBtn').addEventListener('click', () => onboarding.classList.remove('hidden'));
    document.getElementById('onboardingSkip').addEventListener('click', () => onboarding.classList.add('hidden'));
    document.getElementById('onboardingSave').addEventListener('click', saveOnboarding);
}

async function fetchProfile() {
    try {
        const res = await apiFetch('/profile');
        if (!res.ok) return;
        profileData = await res.json();
        profileInput.value = profileData.user_md || '';
        profileUpdated.textContent = profileData.updated_at ? formatTimestamp(profileData.updated_at) : '';
        renderMarkdown(profileData.user_md || '');
        if (currentUser) {
            document.getElementById('profileName').textContent = currentUser.name;
            document.getElementById('profileEmail').textContent = currentUser.email;
            document.getElementById('profileAvatar').textContent = currentUser.name
                ? currentUser.name.trim().charAt(0).toUpperCase()
                : 'K';
        }
        if (pendingOnboarding && profileData.user_md.includes('- Name:')) {
            pendingOnboarding = false;
            onboarding.classList.remove('hidden');
        }
    } catch {
        profilePreview.innerHTML = '<div class="empty-state">Profile unavailable</div>';
    }
}

function renderMarkdown(text) {
    const html = text.split('\n').map(line => {
        if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
        if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
        if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
        if (line.startsWith('- ')) return `<div class="md-line">&bull; ${escapeHtml(line.slice(2))}</div>`;
        return `<div class="md-line">${line ? escapeHtml(line) : '&nbsp;'}</div>`;
    }).join('');
    profilePreview.innerHTML = html;
}

async function saveUserProfile() {
    const button = document.getElementById('saveProfileBtn');
    setBusy(button, true, 'SAVING...', 'Save');
    try {
        const res = await apiFetch('/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_md: profileInput.value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save profile');
        profileData = data;
        profileInput.value = data.user_md;
        profileUpdated.textContent = formatTimestamp(data.updated_at);
        renderMarkdown(data.user_md);
        profileEditor.classList.add('hidden');
    } catch (err) {
        addMessage(`Profile save failed: ${err.message}`, 'assistant', 'error');
    } finally {
        setBusy(button, false, 'SAVING...', 'Save');
    }
}

async function saveOnboarding() {
    const name = document.getElementById('onboardingName').value.trim();
    const location = document.getElementById('onboardingLocation').value.trim();
    const focus = document.getElementById('onboardingFocus').value;
    const markdown = `# About you\n\n## Basics\n- Name: ${name || (currentUser && currentUser.name) || ''}\n- Location: ${location}\n\n## Focus\n- ${focus} is where I want the most help.\n\n## Preferences\n- Give practical next steps and keep answers direct.\n`;
    const button = document.getElementById('onboardingSave');
    setBusy(button, true, 'SAVING...', 'Save profile');
    try {
        const res = await apiFetch('/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_md: markdown }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save profile');
        profileData = data;
        profileInput.value = data.user_md;
        profileUpdated.textContent = formatTimestamp(data.updated_at);
        renderMarkdown(data.user_md);
        onboarding.classList.add('hidden');
    } catch (err) {
        addMessage(`Profile setup failed: ${err.message}`, 'assistant', 'error');
    } finally {
        setBusy(button, false, 'SAVING...', 'Save profile');
    }
}

async function signOut() {
    try {
        await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
        currentUser = null;
    }
    currentUser = null;
    profileData = null;
    currentSessionId = null;
    localStorage.removeItem(SESSION_KEY);
    showAuth();
}

async function deleteUserAccount() {
    if (!window.confirm('Delete your account, sessions, and profile? This cannot be undone.')) return;
    try {
        const res = await apiFetch('/auth/account', { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Could not delete account');
        }
        currentUser = null;
        profileData = null;
        currentSessionId = null;
        localStorage.removeItem(SESSION_KEY);
        showAuth();
    } catch (err) {
        addMessage(`Account deletion failed: ${err.message}`, 'assistant', 'error');
    }
}

window.quickPrompt = quickPrompt;
