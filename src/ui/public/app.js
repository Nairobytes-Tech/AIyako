const API_BASE = '';
const SESSION_KEY = 'aiyako_session_id';
const QUEUE_KEY = 'aiyako_queued_messages';
const TAB_KEY = 'aiyako_active_tab';

const STATUS_LABELS = {
    ready: 'Ready',
    thinking: 'Thinking…',
    working: 'Working on tools…',
    streaming: 'Replying…',
    offline: 'Offline',
    reconnecting: 'Reconnecting…',
    error: 'Agent unavailable',
    idle: 'Idle',
};

const CONNECTOR_CATALOG = [
    { name: 'local', label: 'Local tools', capability: 'Notes, tasks, web search, and files on this device.', cannot: 'Does not access external accounts.', icon: '>_' },
    { name: 'gmail', label: 'Gmail', capability: 'Read, draft, and send email with approval.', cannot: 'Cannot send without your explicit approval.', icon: 'M' },
    { name: 'calendar', label: 'Calendar', capability: 'Check availability and create events.', cannot: 'Cannot change events without approval.', icon: 'C' },
    { name: 'whatsapp', label: 'WhatsApp', capability: 'Read and reply to approved conversations.', cannot: 'Cannot message contacts without approval.', icon: 'W' },
    { name: 'drive', label: 'Drive', capability: 'Find and open files you already use.', cannot: 'Cannot share files without approval.', icon: 'D' },
    { name: 'github', label: 'GitHub', capability: 'Review issues, pull requests, and repositories.', cannot: 'Cannot push changes without approval.', icon: 'G' },
    { name: 'notion', label: 'Notion', capability: 'Find pages and update approved workspaces.', cannot: 'Cannot delete pages without approval.', icon: 'N' },
];

let isOnline = navigator.onLine;
let isProcessing = false;
let currentSessionId = localStorage.getItem(SESSION_KEY);
let statusSource = null;
let libraryTab = 'notes';
let currentTab = localStorage.getItem(TAB_KEY) || 'chat';
let currentUser = null;
let profileData = null;
let authConfig = null;
let healthData = null;
let lastError = '';
let lastOutbound = '';
let cachedNotes = [];
let cachedArtifacts = [];
let cachedGoals = [];
let cachedTasks = [];
let cachedConnectors = [];
let cachedTools = [];
let cachedAudit = [];
let currentActivityEl = null;
let navInitialized = false;
let modalHandler = null;

const el = id => document.getElementById(id);

initApp();

async function initApp() {
    setStatus('idle', 'Connecting…', 'Connecting to AIyako');
    initAuthForms();
    initGlobalEvents();
    initNav();
    initChat();
    initGoals();
    initLibrary();
    initConnectors();
    initProfile();

    try {
        const configRes = await apiFetch('/auth/config');
        authConfig = await configRes.json();
        if (!authConfig.google) {
            const googleBtn = el('googleBtn');
            googleBtn.disabled = true;
            googleBtn.textContent = 'Google Sign-In not configured';
        }
        if (!authConfig.phone) {
            el('phoneBtn').disabled = true;
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

async function apiFetch(url, options = {}, retry = true) {
    const method = String(options.method || 'GET').toUpperCase();
    const fetchOptions = { ...options };
    const timeoutMs = fetchOptions.timeout === undefined ? 20000 : fetchOptions.timeout;
    delete fetchOptions.timeout;
    const controller = new AbortController();
    const timeout = timeoutMs > 0
        ? setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)
        : null;

    try {
        const response = await window.fetch(url, {
            ...fetchOptions,
            credentials: 'same-origin',
            signal: controller.signal,
        });

        if (response.status === 401 && retry && !String(url).includes('/auth/')) {
            const refreshed = await window.fetch('/auth/refresh', {
                method: 'POST',
                credentials: 'same-origin',
            });
            if (refreshed.ok) {
                return apiFetch(url, options, false);
            }
            showAuth();
            setLastError('Your session expired. Sign in again.');
            throw new Error('Session expired');
        }

        if (retry && method === 'GET' && response.status >= 500) {
            return apiFetch(url, options, false);
        }

        return response;
    } catch (err) {
        if (retry && method === 'GET') {
            return apiFetch(url, options, false);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

async function responseJson(response, fallback = {}) {
    try {
        return await response.json();
    } catch {
        return fallback;
    }
}

function friendlyError(err) {
    const message = String(err && err.message || 'Request failed');
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError') || /aborted|timed out/i.test(message)) {
        return 'That took too long. Check that the agent is healthy, then retry.';
    }
    if (/failed to fetch|networkerror/i.test(message)) {
        return 'AIyako could not reach the server. Check your connection and retry.';
    }
    return message;
}

function showAuth(screen = 'authWelcome') {
    if (statusSource) {
        statusSource.close();
        statusSource = null;
    }
    el('appShell').classList.add('hidden');
    el('onboarding').classList.add('hidden');
    el('authShell').classList.remove('hidden');
    showAuthScreen(screen);
}

function showAuthScreen(screen) {
    document.querySelectorAll('.auth-screen').forEach(item => {
        item.classList.toggle('active', item.id === screen);
    });
    clearAuthErrors();
}

function clearAuthErrors() {
    document.querySelectorAll('.field-error').forEach(item => {
        item.textContent = '';
    });
    document.querySelectorAll('.field-input[aria-invalid="true"]').forEach(item => {
        item.removeAttribute('aria-invalid');
    });
}

function setFieldError(id, message) {
    const node = el(id);
    if (!node) return;
    node.textContent = message || '';
    if (message) {
        node.setAttribute('role', 'alert');
        const field = document.getElementById(id.replace(/Error$/, ''));
        if (field) field.setAttribute('aria-invalid', 'true');
    }
}

function setBusy(button, busy, busyText, idleText) {
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? busyText : idleText;
}

async function showApp() {
    el('authShell').classList.add('hidden');
    el('appShell').classList.remove('hidden');
    renderUser();
    setStatus(isOnline ? 'idle' : 'offline', isOnline ? 'Ready' : 'Offline', isOnline ? '' : 'You are offline.');
    await Promise.all([checkHealth(), ensureSession(currentSessionId), fetchProfile(), fetchMcp()]);
    flushQueue();
    switchTab(currentTab);
}

function renderUser() {
    const name = currentUser && currentUser.name ? currentUser.name : 'AIyako user';
    const email = currentUser && currentUser.email ? currentUser.email : 'Signed in';
    const initial = name.trim().charAt(0).toUpperCase() || 'A';
    el('sidebarName').textContent = name;
    el('sidebarEmail').textContent = email;
    el('sidebarAvatar').textContent = initial;
    el('headerAvatar').textContent = initial;
    el('profileName').textContent = name;
    el('profileEmail').textContent = email;
    el('profileAvatar').textContent = initial;
}

function initNav() {
    if (navInitialized) return;
    navInitialized = true;
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => switchTab(item.dataset.tab));
    });
}

function switchTab(tab) {
    const valid = ['chat', 'goals', 'library', 'connectors', 'profile'].includes(tab) ? tab : 'chat';
    currentTab = valid;
    localStorage.setItem(TAB_KEY, valid);

    document.querySelectorAll('.nav-item').forEach(item => {
        const active = item.dataset.tab === valid;
        item.classList.toggle('active', active);
        if (active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
    });

    document.querySelectorAll('.view').forEach(view => {
        view.classList.toggle('active', view.id === `${valid}View`);
    });

    const titles = {
        chat: currentSessionTitle() || 'Chat',
        goals: 'Goals',
        library: 'Library',
        connectors: 'Connectors',
        profile: 'Profile',
    };
    el('contextTitle').textContent = titles[valid];

    if (valid === 'goals') fetchGoals();
    if (valid === 'library') fetchNotes();
    if (valid === 'connectors') fetchMcp();
    if (valid === 'profile') fetchProfile();
    closeStatusPopover();
}

function currentSessionTitle() {
    const option = el('sessionSelect').selectedOptions[0];
    return option ? option.textContent : '';
}

function initGlobalEvents() {
    el('statusChip').addEventListener('click', event => {
        event.stopPropagation();
        const popover = el('statusPopover');
        const open = popover.classList.toggle('hidden') === false;
        el('statusChip').setAttribute('aria-expanded', String(open));
    });

    document.addEventListener('click', event => {
        if (!el('statusPopover').classList.contains('hidden') && !event.target.closest('.status-popover') && !event.target.closest('#statusChip')) {
            closeStatusPopover();
        }
        const back = event.target.closest('[data-back]');
        if (back) {
            el(back.dataset.back).classList.remove('hidden');
            back.closest('.detail-panel').classList.add('hidden');
        }
        const prompt = event.target.closest('[data-prompt]');
        if (prompt) quickPrompt(prompt.dataset.prompt);
    });

    el('statusRetry').addEventListener('click', async () => {
        setStatus('reconnecting', 'Reconnecting…', 'Checking the agent connection.');
        await Promise.all([checkHealth(), refreshActiveView()]);
        showToast('Status refreshed', 'success');
    });

    el('headerAvatar').addEventListener('click', () => switchTab('profile'));
    el('sidebarUser').addEventListener('click', () => switchTab('profile'));

    el('modalClose').addEventListener('click', closeModal);
    el('modalSecondary').addEventListener('click', closeModal);
    el('modalPrimary').addEventListener('click', async () => {
        if (!modalHandler) return;
        try {
            await modalHandler(el('appModal'));
        } catch (err) {
            el('modalError').textContent = err.message || 'That action failed.';
        }
    });

    el('onboardingClose').addEventListener('click', () => el('onboarding').classList.add('hidden'));
    el('onboardingSkip').addEventListener('click', () => el('onboarding').classList.add('hidden'));

    [el('appModal'), el('onboarding')].forEach(modal => {
        modal.addEventListener('click', event => {
            if (event.target === modal) modal.classList.add('hidden');
        });
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        closeStatusPopover();
        if (!el('appModal').classList.contains('hidden')) closeModal();
        el('onboarding').classList.add('hidden');
    });

    window.addEventListener('online', () => {
        isOnline = true;
        setStatus('reconnecting', 'Reconnecting…', 'Connection restored.');
        el('preferenceNetwork').textContent = 'Online';
        checkHealth();
        flushQueue();
    });

    window.addEventListener('offline', () => {
        isOnline = false;
        setStatus('offline', 'Offline', 'You are offline. Messages will be queued.');
        el('preferenceNetwork').textContent = 'Offline';
        showToast('You are offline. Messages will be queued.', 'error');
    });

    window.addEventListener('beforeunload', () => {
        if (statusSource) statusSource.close();
    });
}

function closeStatusPopover() {
    el('statusPopover').classList.add('hidden');
    el('statusChip').setAttribute('aria-expanded', 'false');
}

function setLastError(message) {
    lastError = message || '';
    el('statusLastError').textContent = lastError;
}

function setStatus(state, text, detail = '') {
    const label = text || STATUS_LABELS[state] || state;
    el('statusText').textContent = label;
    el('statusDot').className = `status-dot ${state}`;
    el('statusChip').dataset.state = state;
    el('sidebarStatusText').textContent = label;
    el('sidebarStatusDot').className = `status-dot ${state}`;
    el('statusDetail').textContent = detail || label;
    el('statusMode').textContent = healthData && healthData.mode === 'remote' ? 'Remote agent' : 'Local agent';
    el('sidebarStatusMode').textContent = healthData && healthData.mode === 'remote' ? 'Remote agent' : 'Local agent';
    if (state === 'error') setLastError(detail || label);
}

async function checkHealth() {
    try {
        const res = await apiFetch('/health');
        const data = await responseJson(res);
        healthData = data;
        el('statusMode').textContent = data.mode === 'remote' ? 'Remote agent' : 'Local agent';
        el('sidebarStatusMode').textContent = data.mode === 'remote' ? 'Remote agent' : 'Local agent';
        el('preferenceMode').textContent = data.mode === 'remote' ? 'Remote agent' : 'Local QVAC';
        el('preferenceNetwork').textContent = isOnline ? 'Online' : 'Offline';

        if (!isOnline) {
            setStatus('offline', 'Offline', 'You are offline.');
        } else if (!data || data.status !== 'ok') {
            setStatus('error', 'Agent unavailable', 'The agent did not report a healthy status.');
        } else if (data.mode === 'remote') {
            setStatus('ready', 'Ready', 'Remote agent connected.');
        } else if (data.modelLoaded) {
            setStatus('ready', 'Ready', 'Local model loaded.');
        } else {
            setStatus('working', 'Working on tools…', 'The local model is still loading.');
        }
    } catch (err) {
        healthData = null;
        setStatus('error', 'Agent unavailable', err.message || 'Could not reach the agent.');
        setLastError(err.message || 'Could not reach the agent.');
    }
}

async function refreshActiveView() {
    if (currentTab === 'goals') return fetchGoals(false);
    if (currentTab === 'library') return fetchNotes(false);
    if (currentTab === 'connectors') return fetchMcp(false);
    if (currentTab === 'profile') return fetchProfile(false);
    return refreshSessionList();
}

function openModal({ eyebrow = '', title = '', bodyHtml = '', primaryLabel = 'Confirm', secondaryLabel = 'Cancel', danger = false, onPrimary }) {
    el('modalEyebrow').textContent = eyebrow;
    el('modalTitle').textContent = title;
    el('modalBody').innerHTML = bodyHtml;
    el('modalError').textContent = '';
    el('modalSecondary').textContent = secondaryLabel;
    el('modalPrimary').textContent = primaryLabel;
    el('modalPrimary').classList.toggle('danger', danger);
    modalHandler = onPrimary || null;
    el('appModal').classList.remove('hidden');
    const firstInput = el('appModal').querySelector('input, textarea, select');
    if (firstInput) firstInput.focus();
}

function closeModal() {
    el('appModal').classList.add('hidden');
    modalHandler = null;
}

function showToast(message, type = '') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`.trim();
    toast.textContent = message;
    el('toastRegion').appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

function activityLabel(text) {
    return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

function toolActivityLabel(name) {
    const key = String(name || 'tool').toLowerCase();
    if (key.includes('web_search') || key.includes('search')) return 'Searching the web…';
    if (key.includes('save_note') || key.includes('note')) return 'Saving note…';
    if (key.includes('task')) return 'Updating tasks…';
    if (key.includes('goal')) return 'Updating goals…';
    if (key.includes('profile')) return 'Updating your profile…';
    if (key.includes('reminder')) return 'Setting reminder…';
    if (key.includes('artifact')) return 'Preparing artifact…';
    return `Using ${name}…`;
}

function addActivity(text, options = {}) {
    const label = activityLabel(text);
    if (options.final && !currentActivityEl) return null;
    if (options.final && currentActivityEl) {
        currentActivityEl.querySelector('.activity-text').textContent = `Done · ${label}`;
        currentActivityEl.classList.add('final');
        currentActivityEl.querySelector('.activity-icon').textContent = '✓';
        currentActivityEl = null;
        return null;
    }

    if (!options.final && currentActivityEl) {
        currentActivityEl.querySelector('.activity-text').textContent = label;
        return currentActivityEl;
    }

    const row = document.createElement('div');
    row.className = `activity-row${options.final ? ' final' : ''}`;
    row.innerHTML = `<span class="activity-icon">${options.final ? '✓' : '•'}</span><span class="activity-text">${escapeHtml(label)}</span>`;
    el('messages').appendChild(row);
    if (!options.final) currentActivityEl = row;
    trimActivityRows();
    scrollToBottom();
    return row;
}

function trimActivityRows() {
    const rows = el('messages').querySelectorAll('.activity-row');
    for (let i = 0; i < rows.length - 10; i += 1) rows[i].remove();
}

function addMessage(text, role, type = '') {
    const div = document.createElement('div');
    div.className = type === 'system' ? 'message system' : `message ${role}`;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const bubbleClass = role === 'user' ? 'bubble user' : 'bubble assistant';
    const content = role === 'assistant' && type !== 'error'
        ? renderSafeMarkdown(text)
        : escapeHtml(text);
    div.innerHTML = `<div class="${bubbleClass}"><div class="bubble-content">${content}</div><div class="time">${time}</div></div>`;
    el('messages').appendChild(div);
    scrollToBottom();
}

function addErrorRow(text, retry = false) {
    const row = document.createElement('div');
    row.className = 'error-row';
    row.innerHTML = `<span>${escapeHtml(text)}</span>${retry ? '<button type="button">Retry</button>' : ''}`;
    if (retry) row.querySelector('button').addEventListener('click', retryLastMessage);
    el('messages').appendChild(row);
    scrollToBottom();
}

function renderSafeMarkdown(text) {
    const value = String(text ?? '');
    return value.split('\n').map(line => {
        if (!line.trim()) return '<div>&nbsp;</div>';
        if (line.startsWith('### ')) return `<strong>${escapeHtml(line.slice(4))}</strong>`;
        if (line.startsWith('## ')) return `<strong>${escapeHtml(line.slice(3))}</strong>`;
        if (line.startsWith('# ')) return `<strong>${escapeHtml(line.slice(2))}</strong>`;
        if (line.startsWith('- ')) return `<div>&bull; ${formatInline(line.slice(2))}</div>`;
        return `<div>${formatInline(line)}</div>`;
    }).join('');
}

function formatInline(line) {
    const chunks = String(line).split(/(\[[^\]]+\]\([^)\s]+\))/g);
    return chunks.map(chunk => {
        const match = chunk.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        if (match) {
            const href = safeUrl(match[2]);
            if (!href) return escapeHtml(match[1]);
            return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[1])}</a>`;
        }
        return escapeHtml(chunk)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    }).join('');
}

function safeUrl(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTimestamp(value) {
    if (!value) return '';
    const normalized = String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        el('messages').scrollTop = el('messages').scrollHeight;
    });
}

function initChat() {
    el('input').addEventListener('input', event => {
        event.target.style.height = 'auto';
        event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
        el('sendBtn').disabled = !event.target.value.trim() || isProcessing;
    });

    el('input').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !isProcessing) {
            event.preventDefault();
            handleSubmit();
        }
    });

    el('chatForm').addEventListener('submit', event => {
        event.preventDefault();
        handleSubmit();
    });

    el('sessionSelect').addEventListener('change', event => switchSession(event.target.value));
    el('newChatBtn').addEventListener('click', () => {
        if (!isProcessing) startNewChat();
    });
    el('renameSessionBtn').addEventListener('click', renameCurrentSession);
    el('deleteSessionBtn').addEventListener('click', deleteCurrentSession);
}

async function ensureSession(preferredId) {
    if (preferredId) {
        try {
            const res = await apiFetch(`/sessions/${preferredId}`);
            if (res.ok) {
                await activateSession(await res.json());
                return;
            }
        } catch {
            setLastError('Could not open the previous conversation.');
        }
    }
    await startNewChat();
}

async function activateSession(session) {
    currentSessionId = session.id;
    localStorage.setItem(SESSION_KEY, currentSessionId);
    currentActivityEl = null;
    el('messages').innerHTML = '';

    if (session.messages && session.messages.length) renderHistory(session.messages);
    else showWelcome();

    for (const approval of session.approvals || []) addApproval(approval);

    applySessionStatus(session.status || 'idle');
    if ((session.approvals || []).length) {
        setStatus('working', 'Waiting for approval', 'A tool is waiting for your decision.');
        updateApprovalBadge(session.approvals.length);
    }
    await Promise.all([refreshSessionList(), fetchGoals(false), fetchNotes(false)]);
    subscribeToStatus();
}

async function startNewChat() {
    try {
        const res = await apiFetch('/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const data = await responseJson(res);
        if (!res.ok) throw new Error(data.error || 'Could not create a conversation');
        await activateSession({ messages: [], approvals: [], artifacts: [], goals: [], ...data });
    } catch (err) {
        addErrorRow(`Could not start a conversation. ${err.message}`, true);
        setStatus('error', 'Agent unavailable', err.message);
    }
}

async function switchSession(sessionId) {
    if (!sessionId || sessionId === currentSessionId) return;
    if (isProcessing) {
        el('sessionSelect').value = currentSessionId;
        showToast('Finish the current reply before switching conversations.', 'error');
        return;
    }
    try {
        const res = await apiFetch(`/sessions/${sessionId}`);
        const data = await responseJson(res);
        if (!res.ok) throw new Error(data.error || 'Conversation not found');
        await activateSession(data);
    } catch (err) {
        addErrorRow(`Could not load that conversation. ${err.message}`);
        refreshSessionList();
    }
}

async function refreshSessionList() {
    try {
        const res = await apiFetch('/sessions');
        const data = await responseJson(res);
        if (!res.ok) return;
        el('sessionSelect').innerHTML = '';
        for (const session of data.sessions || []) {
            const option = document.createElement('option');
            option.value = session.id;
            option.textContent = session.title || `Chat ${session.id.slice(0, 8)}`;
            el('sessionSelect').appendChild(option);
        }
        if (currentSessionId) el('sessionSelect').value = currentSessionId;
        if (currentTab === 'chat') el('contextTitle').textContent = currentSessionTitle() || 'Chat';
    } catch {
        setLastError('Could not refresh conversations.');
    }
}

function renderHistory(messages) {
    for (const message of messages || []) {
        if (message.role === 'user') {
            addMessage(message.content, 'user');
        } else if (message.role === 'assistant') {
            for (const call of message.tool_calls || []) addActivity(toolActivityLabel(call.name), { final: true });
            if (!message.content || message.content === '[tool_calls]') continue;
            addMessage(message.content, 'assistant');
        } else if (message.role === 'tool') {
            try {
                addToolResult(JSON.parse(message.content));
            } catch {
                addActivity('Tool result recorded', { final: true });
            }
        }
    }
    scrollToBottom();
}

function applySessionStatus(status, tool = null) {
    if (status === 'thinking') {
        setStatus('thinking', 'Thinking…', 'AIyako is thinking.');
        addActivity('Thinking…');
    } else if (status === 'tool') {
        const label = toolActivityLabel(tool);
        setStatus('working', 'Working on tools…', label);
        addActivity(label);
    } else if (status === 'waiting_approval') {
        setStatus('working', 'Waiting for approval', 'A tool is waiting for your decision.');
        addActivity('Waiting for your approval…');
    } else {
        setStatus('ready', 'Ready', 'Ready for your next message.');
        addActivity('Done', { final: true });
    }
}

function subscribeToStatus() {
    if (statusSource) statusSource.close();
    if (!currentSessionId) return;

    statusSource = new EventSource(`/sessions/${currentSessionId}/events`);
    statusSource.addEventListener('status', event => {
        try {
            const data = JSON.parse(event.data);
            applySessionStatus(data.status, data.tool);
        } catch {
            setLastError('A status update could not be read.');
        }
    });
    statusSource.addEventListener('error', () => {
        if (!navigator.onLine) setStatus('offline', 'Offline', 'You are offline.');
        else setStatus('reconnecting', 'Reconnecting…', 'Trying to restore the live connection.');
    });
}

function showWelcome() {
    const name = currentUser && currentUser.name ? currentUser.name.split(' ')[0] : 'there';
    const welcome = document.createElement('div');
    welcome.className = 'welcome';
    welcome.innerHTML = `
        <div class="message assistant">
            <div class="bubble assistant">
                <div class="bubble-content">Hey ${escapeHtml(name)}. I'm AIyako. I can plan, research, save notes, and keep track of your goals. What should we work on?</div>
            </div>
        </div>
        <div class="suggested-chips">
            <button class="chip" type="button" data-prompt="Plan my week">Plan my week</button>
            <button class="chip" type="button" data-prompt="Save a note about today">Save a note about today</button>
            <button class="chip" type="button" data-prompt="Search the web for current AI news">Search the web</button>
            <button class="chip" type="button" data-prompt="What goals am I tracking?">Check my goals</button>
        </div>
    `;
    el('messages').appendChild(welcome);
    scrollToBottom();
}

function quickPrompt(text) {
    el('input').value = text;
    el('sendBtn').disabled = false;
    handleSubmit();
}

function getQueue() {
    try {
        const value = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

function saveQueue(messages) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(messages));
}

function queueMessage(text) {
    const queue = getQueue();
    queue.push(text);
    saveQueue(queue);
    addMessage(text, 'user');
    addActivity('Queued — will send when you are back online…');
    showToast('Message queued. It will send when you reconnect.', 'success');
}

function flushQueue() {
    if (!isOnline || isProcessing) return;
    const queue = getQueue();
    if (!queue.length) return;
    saveQueue([]);
    sendMessage(queue.shift());
    if (queue.length) saveQueue(queue);
}

async function handleSubmit() {
    const text = el('input').value.trim();
    if (!text || isProcessing) return;
    if (!isOnline) {
        el('input').value = '';
        el('sendBtn').disabled = true;
        queueMessage(text);
        return;
    }
    sendMessage(text);
}

async function sendMessage(text) {
    if (!text || isProcessing) return;
    lastOutbound = text;
    isProcessing = true;
    el('input').value = '';
    el('input').style.height = 'auto';
    el('sendBtn').disabled = true;
    addMessage(text, 'user');
    addActivity('Thinking…');
    setStatus('thinking', 'Thinking…', 'AIyako is preparing a reply.');

    try {
        if (!currentSessionId) await createNewSession();

        let res = await apiFetch(`/sessions/${currentSessionId}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
            timeout: 0,
        });

        if (res.status === 404) {
            await createNewSession();
            res = await apiFetch(`/sessions/${currentSessionId}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
                timeout: 0,
            });
        }

        const data = await responseJson(res);
        if (!res.ok) throw new Error(data.error || 'The request failed.');

        setStatus('streaming', 'Replying…', 'AIyako is writing the reply.');

        for (const event of data.events || []) {
            if (event.type === 'status' || event.status) applySessionStatus(event.status || data.status, event.tool);
        }
        for (const result of data.toolResults || []) addToolResult(result);
        for (const approval of data.approvals || []) addApproval(approval);

        if (data.reply) addMessage(data.reply, 'assistant');
        if (data.error) addErrorRow(data.error);

        applySessionStatus(data.status || 'idle');
        await Promise.all([refreshSessionList(), fetchGoals(false), fetchNotes(false)]);
    } catch (err) {
        const message = friendlyError(err);
        addErrorRow(`Could not send that message. ${message}`, true);
        setStatus('error', 'Agent unavailable', message);
        setLastError(message);
    } finally {
        isProcessing = false;
        el('sendBtn').disabled = !el('input').value.trim();
        await refreshSessionList();
    }
}

function retryLastMessage() {
    if (!lastOutbound || isProcessing) {
        showToast('Nothing to retry.', 'error');
        return;
    }
    sendMessage(lastOutbound);
}

async function createNewSession() {
    const res = await apiFetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    const data = await responseJson(res);
    if (!res.ok) throw new Error(data.error || 'Could not create a conversation');
    currentSessionId = data.id;
    localStorage.setItem(SESSION_KEY, currentSessionId);
    return data;
}

function addToolResult(result) {
    const success = Boolean(result && result.success);
    const label = success ? 'Tool completed' : (result && result.error) || 'Tool failed';
    const div = document.createElement('div');
    div.className = `tool-result${success ? '' : ' error'}`;
    let detail = '';
    if (success && result.data && Array.isArray(result.data.results)) detail = renderSearchResultCards(result.data);
    else if (success && result.data) detail = `<pre>${escapeHtml(JSON.stringify(result.data, null, 2))}</pre>`;
    div.innerHTML = `${escapeHtml(label)}${detail}`;
    el('messages').appendChild(div);
    addActivity(success ? 'Tool completed' : label, { final: true });
    scrollToBottom();
}

function renderSearchResultCards(data) {
    const rows = (data.results || []).map(item => {
        const href = safeUrl(item.url);
        const title = escapeHtml(item.title || item.url || 'Result');
        const snippet = escapeHtml(item.snippet || '');
        const link = href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title;
        return `<div class="search-result">${link}${snippet ? `<div class="search-snippet">${snippet}</div>` : ''}</div>`;
    });
    return rows.length ? `<div class="search-results">${rows.join('')}</div>` : '<div class="search-results">No usable results returned.</div>';
}

function approvalSummary(approval) {
    const args = approval.tool_args || {};
    const name = approval.tool_name || 'tool';
    const to = args.to || args.recipient || args.email || '';
    const subject = args.subject || args.title || '';
    const body = args.body || args.text || args.message || args.content || '';
    let details = `<div class="approval-detail"><strong>${escapeHtml(name)}</strong>`;
    if (to) details += `<div>To: ${escapeHtml(to)}</div>`;
    if (subject) details += `<div>Subject: ${escapeHtml(subject)}</div>`;
    if (body) details += `<div>${escapeHtml(String(body).slice(0, 240))}</div>`;
    if (!to && !subject && !body) details += `<div>${escapeHtml(JSON.stringify(args).slice(0, 240))}</div>`;
    details += '</div>';
    return details;
}

function addApproval(approval) {
    const card = document.createElement('div');
    const status = approval.status || 'pending';
    const resolvedClass = status === 'approved' || approval.executed ? 'approved' : status === 'rejected' ? 'rejected' : '';
    card.className = `approval-card ${resolvedClass}`.trim();
    card.dataset.approvalId = approval.id;
    const heading = status === 'pending' ? 'AIyako wants to:' : status === 'rejected' ? 'AIyako did not:' : 'AIyako completed:';
    const actions = status === 'pending'
        ? '<div class="approval-actions"><button class="approval-btn reject" type="button" data-approval-action="reject">Deny</button><button class="approval-btn" type="button" data-approval-action="edit">Edit</button><button class="approval-btn approve" type="button" data-approval-action="approve">Allow</button></div>'
        : `<div class="approval-actions"><span class="status-pill ${resolvedClass || 'done'}">${escapeHtml(status)}</span></div>`;
    card.innerHTML = `
        <div class="approval-head"><strong>${heading}</strong><span>${escapeHtml(formatTimestamp(approval.created_at))}</span></div>
        ${approvalSummary(approval)}
        ${actions}
    `;
    if (status === 'pending') {
        card.addEventListener('click', event => {
            const action = event.target.closest('[data-approval-action]');
            if (!action) return;
            if (action.dataset.approvalAction === 'edit') {
                toggleApprovalEditor(card, approval);
                return;
            }
            const editor = card.querySelector('.approval-editor');
            let args = null;
            if (editor) {
                try {
                    args = JSON.parse(editor.value);
                } catch {
                    showToast('Arguments must be valid JSON.', 'error');
                    return;
                }
            }
            resolveApprovalPrompt(approval.id, action.dataset.approvalAction, card, args);
        });
    }
    el('messages').appendChild(card);
    updateApprovalBadge(el('messages').querySelectorAll('.approval-card:not(.approved):not(.rejected)').length);
    scrollToBottom();
}

function toggleApprovalEditor(card, approval) {
    const existing = card.querySelector('.approval-editor');
    if (existing) {
        existing.remove();
        return;
    }
    const editor = document.createElement('textarea');
    editor.className = 'approval-editor';
    editor.value = JSON.stringify(approval.tool_args || {}, null, 2);
    card.insertBefore(editor, card.querySelector('.approval-actions'));
    editor.focus();
}

async function resolveApprovalPrompt(approvalId, decision, card, args = null) {
    if (!currentSessionId) return;
    card.querySelectorAll('button').forEach(button => { button.disabled = true; });
    setStatus('working', 'Working on tools…', decision === 'approve' ? 'Allowing the action…' : 'Denying the action…');
    addActivity(decision === 'approve' ? 'Allowing the action…' : 'Denying the action…');

    try {
        const payload = { decision };
        if (args && decision === 'approve') payload.args = args;
        const res = await apiFetch(`/sessions/${currentSessionId}/approvals/${approvalId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await responseJson(res);
        if (!res.ok) throw new Error(data.error || 'Approval failed');

        card.className = `approval-card ${decision === 'approve' ? 'approved' : 'rejected'}`;
        card.querySelector('.approval-head strong').textContent = decision === 'approve' ? 'AIyako completed:' : 'AIyako did not:';
        card.querySelector('.approval-actions').innerHTML = `<span class="status-pill ${decision === 'approve' ? 'approved' : 'rejected'}">${decision === 'approve' ? 'allowed' : 'denied'}</span>`;

        for (const result of data.toolResults || []) addToolResult(result);
        for (const next of data.approvals || []) addApproval(next);
        if (data.reply) addMessage(data.reply, 'assistant');
        if (data.error) addErrorRow(data.error);
        applySessionStatus(data.status || 'idle');
        showToast(decision === 'approve' ? 'Action allowed.' : 'Action denied.', 'success');
        await Promise.all([fetchGoals(false), fetchNotes(false)]);
    } catch (err) {
        card.querySelectorAll('button').forEach(button => { button.disabled = false; });
        addErrorRow(`Approval failed. ${err.message}`, true);
        setStatus('error', 'Agent unavailable', err.message);
        setLastError(err.message);
    }
}

function updateApprovalBadge(count) {
    const show = count > 0;
    ['sidebarChatBadge', 'mobileChatBadge'].forEach(id => {
        const badge = el(id);
        badge.classList.toggle('hidden', !show);
        badge.textContent = show ? String(count) : '';
    });
}

function renameCurrentSession() {
    if (!currentSessionId || isProcessing) return;
    const current = currentSessionTitle();
    openModal({
        eyebrow: 'CONVERSATION',
        title: 'Rename conversation',
        bodyHtml: `<label class="field-label" for="renameInput">Title</label><input id="renameInput" class="field-input" type="text" maxlength="120" value="${escapeHtml(current)}">`,
        primaryLabel: 'Save',
        onPrimary: async modal => {
            const title = modal.querySelector('#renameInput').value.trim();
            if (!title) {
                el('modalError').textContent = 'Enter a title.';
                return;
            }
            const res = await apiFetch(`/sessions/${currentSessionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title }),
            });
            const data = await responseJson(res);
            if (!res.ok) throw new Error(data.error || 'Could not rename conversation');
            closeModal();
            await refreshSessionList();
            showToast('Conversation renamed.', 'success');
        },
    });
}

function deleteCurrentSession() {
    if (!currentSessionId || isProcessing) return;
    openModal({
        eyebrow: 'CONVERSATION',
        title: 'Delete this conversation?',
        bodyHtml: '<p>This removes the conversation, its messages, goals, and artifacts. This cannot be undone.</p>',
        primaryLabel: 'Delete conversation',
        danger: true,
        onPrimary: async () => {
            const res = await apiFetch(`/sessions/${currentSessionId}`, { method: 'DELETE' });
            const data = await responseJson(res);
            if (!res.ok) throw new Error(data.error || 'Could not delete conversation');
            closeModal();
            localStorage.removeItem(SESSION_KEY);
            currentSessionId = null;
            await startNewChat();
            showToast('Conversation deleted.', 'success');
        },
    });
}

function initGoals() {
    el('newGoalBtn').addEventListener('click', () => {
        el('goalForm').classList.toggle('hidden');
        if (!el('goalForm').classList.contains('hidden')) el('goalInput').focus();
    });
    el('goalCancelBtn').addEventListener('click', () => {
        el('goalForm').classList.add('hidden');
        setFieldError('goalError', '');
        el('goalInput').value = '';
    });
    el('goalForm').addEventListener('submit', async event => {
        event.preventDefault();
        const title = el('goalInput').value.trim();
        if (!title || !currentSessionId) {
            setFieldError('goalError', 'Enter a goal title.');
            return;
        }
        try {
            const res = await apiFetch(`/sessions/${currentSessionId}/goals`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title }),
            });
            const data = await responseJson(res);
            if (!res.ok) throw new Error(data.error || 'Could not add the goal');
            el('goalInput').value = '';
            setFieldError('goalError', '');
            el('goalForm').classList.add('hidden');
            await fetchGoals(false);
            showToast('Goal added.', 'success');
        } catch (err) {
            setFieldError('goalError', err.message);
        }
    });

    el('goalsList').addEventListener('click', event => {
        const card = event.target.closest('[data-goal-id]');
        if (card) openGoalDetail(card.dataset.goalId);
    });
}

async function fetchGoals(showSkeleton = true) {
    if (!currentSessionId) {
        el('goalsList').innerHTML = '<div class="empty-state">Goals appear as AIyako learns what you are working on. You can also add one.</div>';
        return;
    }
    if (showSkeleton) el('goalsList').innerHTML = '<div class="skeleton-list"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>';
    try {
        const [tasksRes, goalsRes] = await Promise.all([
            apiFetch('/tasks'),
            apiFetch(`/sessions/${currentSessionId}/goals`),
        ]);
        const tasksData = await responseJson(tasksRes);
        const goalsData = await responseJson(goalsRes, { goals: [] });
        cachedTasks = tasksData.tasks || [];
        cachedGoals = goalsData.goals || [];
        renderGoals();
    } catch (err) {
        el('goalsList').innerHTML = `<div class="error-message">Could not load goals. ${escapeHtml(err.message)} <button id="goalsRetry" class="terminal-btn" type="button">Retry</button></div>`;
        el('goalsRetry').addEventListener('click', () => fetchGoals());
    }
}

function renderGoals() {
    if (!cachedGoals.length && !cachedTasks.length) {
        el('goalsList').innerHTML = '<div class="empty-state">Goals appear as AIyako learns what you are working on. You can also add one.</div>';
        return;
    }
    let html = '';
    if (cachedGoals.length) {
        html += '<div class="list-heading">Active goals</div><div class="item-list">';
        html += cachedGoals.map(goal => `
            <button class="item-card" type="button" data-goal-id="${escapeHtml(goal.id)}">
                <div class="item-card-head">
                    <span class="item-card-title">${escapeHtml(goal.title)}</span>
                    <span class="status-pill ${statusClass(goal.status)}">${escapeHtml(goal.status || 'active')}</span>
                </div>
                <div class="item-card-meta">${escapeHtml(goal.progress || 'No progress note')} · ${escapeHtml(formatTimestamp(goal.updated_at || goal.created_at))}</div>
            </button>
        `).join('');
        html += '</div>';
    }
    if (cachedTasks.length) {
        html += '<div class="list-heading">Tasks</div><div class="item-list">';
        html += cachedTasks.map(task => `
            <div class="item-card">
                <div class="item-card-head">
                    <span class="item-card-title">${escapeHtml(task.title)}</span>
                    <span class="status-pill ${task.completed ? 'done' : 'active'}">${task.completed ? 'done' : 'open'}</span>
                </div>
                <div class="item-card-meta">${task.due_date ? `Due ${escapeHtml(formatTimestamp(task.due_date))}` : 'No due date'}</div>
            </div>
        `).join('');
        html += '</div>';
    }
    el('goalsList').innerHTML = html;
}

function statusClass(status) {
    const value = String(status || 'active').toLowerCase();
    return ['active', 'done', 'paused', 'attention'].includes(value) ? value : 'active';
}

function openGoalDetail(id) {
    const goal = cachedGoals.find(item => item.id === id);
    if (!goal) return;
    el('goalsList').classList.add('hidden');
    el('goalDetail').classList.remove('hidden');
    const related = cachedTasks.filter(task => String(task.title).toLowerCase().includes(String(goal.title).toLowerCase()));
    el('goalDetailBody').innerHTML = `
        <p class="eyebrow">GOAL DETAIL</p>
        <h2>${escapeHtml(goal.title)}</h2>
        <div class="status-pill ${statusClass(goal.status)}">${escapeHtml(goal.status || 'active')}</div>
        <div class="detail-body">
            <p class="profile-hint">${escapeHtml(goal.progress || 'No progress note yet.')}</p>
            <div class="setting-group">
                <div class="setting-item"><span class="setting-label">Status</span><span class="setting-value">${escapeHtml(goal.status || 'active')}</span></div>
                <div class="setting-item"><span class="setting-label">Created</span><span class="setting-value">${escapeHtml(formatTimestamp(goal.created_at))}</span></div>
                <div class="setting-item"><span class="setting-label">Updated</span><span class="setting-value">${escapeHtml(formatTimestamp(goal.updated_at))}</span></div>
            </div>
            <div class="mcp-section-title">Timeline</div>
            <div class="item-list">
                <div class="item-card"><div class="item-card-title">Goal created</div><div class="item-card-meta">${escapeHtml(formatTimestamp(goal.created_at))}</div></div>
                ${related.map(task => `<div class="item-card"><div class="item-card-title">${escapeHtml(task.title)}</div><div class="item-card-meta">Related task · ${task.completed ? 'done' : 'open'}</div></div>`).join('')}
            </div>
            <div class="editor-actions">
                <button id="pauseGoalBtn" class="terminal-btn" type="button">Pause</button>
                <button id="editGoalBtn" class="terminal-btn" type="button">Edit</button>
                <button id="doneGoalBtn" class="terminal-btn primary" type="button">Mark done</button>
            </div>
        </div>
    `;
    el('pauseGoalBtn').addEventListener('click', () => updateGoalField(goal.id, { status: 'paused' }));
    el('doneGoalBtn').addEventListener('click', () => updateGoalField(goal.id, { status: 'done' }));
    el('editGoalBtn').addEventListener('click', () => {
        openModal({
            eyebrow: 'GOAL',
            title: 'Edit goal',
            bodyHtml: `<label class="field-label" for="editGoalTitle">Title</label><input id="editGoalTitle" class="field-input" type="text" maxlength="200" value="${escapeHtml(goal.title)}">`,
            primaryLabel: 'Save',
            onPrimary: async modal => {
                const title = modal.querySelector('#editGoalTitle').value.trim();
                if (!title) {
                    el('modalError').textContent = 'Enter a goal title.';
                    return;
                }
                const res = await apiFetch(`/goals/${goal.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title }),
                });
                const data = await responseJson(res);
                if (!res.ok) throw new Error(data.error || 'Could not update goal');
                closeModal();
                await fetchGoals(false);
                openGoalDetail(goal.id);
                showToast('Goal updated.', 'success');
            },
        });
    });
}

async function updateGoalField(goalId, fields) {
    try {
        const res = await apiFetch(`/goals/${goalId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fields),
        });
        const data = await responseJson(res);
        if (!res.ok) throw new Error(data.error || 'Could not update goal');
        await fetchGoals(false);
        showToast('Goal updated.', 'success');
        openGoalDetail(goalId);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function initLibrary() {
    el('librarySearch').addEventListener('input', renderLibrary);
    document.querySelectorAll('[data-library-tab]').forEach(tab => {
        tab.addEventListener('click', () => {
            libraryTab = tab.dataset.libraryTab;
            document.querySelectorAll('[data-library-tab]').forEach(item => item.classList.toggle('active', item === tab));
            renderLibrary();
        });
    });
    el('libraryList').addEventListener('click', event => {
        const item = event.target.closest('[data-library-key]');
        if (item) openLibraryDetail(item.dataset.libraryKey);
    });
}

async function fetchNotes(showSkeleton = true) {
    if (!currentSessionId) {
        cachedNotes = [];
        cachedArtifacts = [];
        renderLibrary();
        return;
    }
    if (showSkeleton) el('libraryList').innerHTML = '<div class="skeleton-list"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>';
    try {
        const [notesRes, sessionRes] = await Promise.all([
            apiFetch('/notes'),
            apiFetch(`/sessions/${currentSessionId}`),
        ]);
        const notesData = await responseJson(notesRes);
        const sessionData = await responseJson(sessionRes, { artifacts: [] });
        cachedNotes = notesData.notes || [];
        cachedArtifacts = sessionData.artifacts || [];
        renderLibrary();
    } catch (err) {
        el('libraryList').innerHTML = `<div class="error-message">Could not load library. ${escapeHtml(err.message)} <button id="libraryRetry" class="terminal-btn" type="button">Retry</button></div>`;
        el('libraryRetry').addEventListener('click', () => fetchNotes());
    }
}

function renderLibrary() {
    const query = el('librarySearch').value.trim().toLowerCase();
    const items = libraryTab === 'artifacts' ? cachedArtifacts : cachedNotes;
    const filtered = items.filter(item => {
        const haystack = `${item.title || ''} ${item.content || ''} ${item.type || ''}`.toLowerCase();
        return !query || haystack.includes(query);
    });

    if (!filtered.length) {
        el('libraryList').innerHTML = `<div class="empty-state">${libraryTab === 'artifacts'
            ? 'Plans, notes, and files you create with AIyako show up here.'
            : 'Notes you save with AIyako show up here.'}</div>`;
        return;
    }

    el('libraryList').innerHTML = `<div class="item-list">${filtered.map((item, index) => {
        const key = `${libraryTab}:${index}`;
        const title = libraryTab === 'artifacts' ? (item.title || item.type || 'Artifact') : (item.content || 'Note').slice(0, 120);
        return `<button class="item-card" type="button" data-library-key="${escapeHtml(key)}">
            <div class="item-card-head"><span class="item-card-title">${escapeHtml(title)}</span><span class="status-pill">${libraryTab === 'artifacts' ? escapeHtml(item.type || 'artifact') : 'note'}</span></div>
            <div class="item-card-meta">Updated ${escapeHtml(formatTimestamp(item.updated_at || item.created_at))}</div>
        </button>`;
    }).join('')}</div>`;
}

function openLibraryDetail(key) {
    const [type, index] = key.split(':');
    const items = type === 'artifacts' ? cachedArtifacts : cachedNotes;
    const item = items[Number(index)];
    if (!item) return;
    el('libraryList').classList.add('hidden');
    el('libraryDetail').classList.remove('hidden');
    const title = type === 'artifacts' ? (item.title || item.type || 'Artifact') : 'Note';
    el('libraryDetailBody').innerHTML = `
        <p class="eyebrow">LIBRARY</p>
        <h2>${escapeHtml(title)}</h2>
        <div class="setting-group">
            <div class="setting-item"><span class="setting-label">Type</span><span class="setting-value">${escapeHtml(type === 'artifacts' ? item.type || 'artifact' : 'note')}</span></div>
            <div class="setting-item"><span class="setting-label">Created</span><span class="setting-value">${escapeHtml(formatTimestamp(item.created_at))}</span></div>
        </div>
        <div class="markdown-view">${renderSafeMarkdown(item.content || '')}</div>
    `;
}

function initConnectors() {
    el('connectorsList').addEventListener('click', event => {
        const card = event.target.closest('[data-connector]');
        if (card) openConnectorDetail(card.dataset.connector);
    });
    el('connectorDetail').addEventListener('click', event => {
        const action = event.target.closest('[data-connector-action]');
        if (!action) return;
        const name = el('connectorDetailBody').dataset.connector;
        if (action.dataset.connectorAction === 'connect') connectConnector(name);
        if (action.dataset.connectorAction === 'reconnect') reconnectConnector(name);
        if (action.dataset.connectorAction === 'audit') renderConnectorAudit(name);
    });
}

async function fetchMcp(showSkeleton = true) {
    if (showSkeleton) el('connectorsList').innerHTML = '<div class="skeleton-list"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>';
    try {
        const [toolsRes, auditRes, connectorsRes] = await Promise.all([
            apiFetch('/mcp/tools'),
            apiFetch('/mcp/audit'),
            apiFetch('/mcp/connectors'),
        ]);
        const toolsData = await responseJson(toolsRes);
        const auditData = await responseJson(auditRes);
        const connectorsData = await responseJson(connectorsRes);
        cachedTools = toolsData.tools || [];
        cachedAudit = auditData.events || [];
        cachedConnectors = connectorsData.connectors || [];
        renderConnectors();
    } catch (err) {
        el('connectorsList').innerHTML = `<div class="error-message">Could not load connectors. ${escapeHtml(err.message)} <button id="connectorsRetry" class="terminal-btn" type="button">Retry</button></div>`;
        el('connectorsRetry').addEventListener('click', () => fetchMcp());
    }
}

function connectorStatus(name) {
    const connected = cachedConnectors.includes(name);
    const events = cachedAudit.filter(event => event.connector === name);
    const lastFailure = events.find(event => ['error', 'failed', 'denied_scope'].includes(String(event.status)));
    const lastSuccess = events.find(event => event.status === 'ok');
    if (connected && lastFailure && (!lastSuccess || new Date(lastFailure.created_at) > new Date(lastSuccess.created_at))) return 'attention';
    if (connected) return 'connected';
    return 'available';
}

function connectorMeta(name) {
    return CONNECTOR_CATALOG.find(item => item.name === name) || {
        name,
        label: name.charAt(0).toUpperCase() + name.slice(1),
        capability: 'MCP tools are available for this connector.',
        cannot: 'External actions require approval.',
        icon: name.charAt(0).toUpperCase(),
    };
}

function renderConnectors() {
    const names = [...new Set([...CONNECTOR_CATALOG.map(item => item.name), ...cachedConnectors])];
    const sections = [
        ['Needs attention', 'attention'],
        ['Connected', 'connected'],
        ['Available', 'available'],
    ];
    let html = '';
    for (const [heading, status] of sections) {
        const items = names.filter(name => connectorStatus(name) === status);
        if (!items.length) continue;
        html += `<div class="list-heading">${heading}</div><div class="item-list">`;
        html += items.map(name => {
            const meta = connectorMeta(name);
            return `<button class="item-card" type="button" data-connector="${escapeHtml(name)}">
                <div class="item-card-head">
                    <span class="item-card-title">${escapeHtml(meta.icon)} &nbsp; ${escapeHtml(meta.label)}</span>
                    <span class="status-pill ${status === 'connected' ? 'connected' : status === 'attention' ? 'attention' : ''}">${status === 'attention' ? 'needs attention' : status}</span>
                </div>
                <div class="item-card-meta">${escapeHtml(meta.capability)}</div>
            </button>`;
        }).join('');
        html += '</div>';
    }
    if (!html) html = '<div class="empty-state">No connectors are available yet.</div>';
    el('connectorsList').innerHTML = html;
    const attention = names.filter(name => connectorStatus(name) === 'attention').length;
    ['sidebarConnectorBadge', 'mobileConnectorBadge'].forEach(id => {
        el(id).classList.toggle('hidden', attention === 0);
        el(id).textContent = attention ? String(attention) : '';
    });
}

function openConnectorDetail(name) {
    const meta = connectorMeta(name);
    const status = connectorStatus(name);
    const action = status === 'connected' ? 'reconnect' : 'connect';
    const actionLabel = status === 'attention' ? 'Reconnect' : status === 'connected' ? 'Manage' : 'Connect';
    el('connectorsList').classList.add('hidden');
    el('connectorDetail').classList.remove('hidden');
    el('connectorDetailBody').dataset.connector = name;
    el('connectorDetailBody').innerHTML = `
        <p class="eyebrow">CONNECTOR</p>
        <h2>${escapeHtml(meta.icon)} ${escapeHtml(meta.label)}</h2>
        <div class="status-pill ${status === 'connected' ? 'connected' : status === 'attention' ? 'attention' : ''}">${status === 'attention' ? 'needs attention' : status}</div>
        <p class="profile-hint">${escapeHtml(meta.capability)}</p>
        <div class="setting-group">
            <div class="setting-item"><span class="setting-label">What AIyako can do</span><span class="setting-value">${escapeHtml(meta.capability)}</span></div>
            <div class="setting-item"><span class="setting-label">What it cannot do</span><span class="setting-value">${escapeHtml(meta.cannot)}</span></div>
        </div>
        <div class="editor-actions">
            <button class="terminal-btn" type="button" data-connector-action="audit">View activity</button>
            <button class="terminal-btn primary" type="button" data-connector-action="${action}">${actionLabel}</button>
        </div>
        <div id="connectorAudit"></div>
    `;
}

function renderConnectorAudit(name) {
    const events = cachedAudit.filter(event => event.connector === name).slice(0, 12);
    el('connectorAudit').innerHTML = `<div class="mcp-section-title">Recent activity</div>${events.length
        ? `<div class="item-list">${events.map(event => `<div class="item-card"><div class="item-card-title">${escapeHtml(event.tool || 'event')}</div><div class="item-card-meta">${escapeHtml(event.status)} · ${escapeHtml(formatTimestamp(event.created_at))}</div></div>`).join('')}</div>`
        : '<div class="empty-state">No activity yet.</div>'}`;
}

function connectConnector(name) {
    const meta = connectorMeta(name);
    openModal({
        eyebrow: 'CONNECTOR',
        title: `Connect ${meta.label}`,
        bodyHtml: `
            <p>Add an MCP-compatible connector endpoint. AIyako stores the token in the local gateway.</p>
            <label class="field-label" for="connectorUrl">Endpoint URL</label>
            <input id="connectorUrl" class="field-input" type="url" placeholder="https://connector.example/mcp">
            <label class="field-label" for="connectorToken">Access token</label>
            <input id="connectorToken" class="field-input" type="password" autocomplete="off">
            <label class="field-label" for="connectorScopes">Scopes</label>
            <input id="connectorScopes" class="field-input" type="text" placeholder="*">
        `,
        primaryLabel: 'Connect',
        onPrimary: async modal => {
            const url = modal.querySelector('#connectorUrl').value.trim();
            const token = modal.querySelector('#connectorToken').value.trim();
            const scopes = modal.querySelector('#connectorScopes').value.trim();
            if (!url) {
                el('modalError').textContent = 'Enter an endpoint URL.';
                return;
            }
            const res = await apiFetch('/mcp/connectors', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, url, token, scopes: scopes || '*' }),
            });
            const data = await responseJson(res);
            if (!res.ok || data.error) throw new Error(data.error || 'Could not connect');
            closeModal();
            await fetchMcp(false);
            openConnectorDetail(name);
            showToast(`${meta.label} connected.`, 'success');
        },
    });
}

function reconnectConnector(name) {
    const meta = connectorMeta(name);
    openModal({
        eyebrow: 'CONNECTOR',
        title: `Manage ${meta.label}`,
        bodyHtml: '<p>Refresh the stored authorization for this connector.</p>',
        primaryLabel: 'Refresh authorization',
        onPrimary: async () => {
            const res = await apiFetch(`/mcp/connectors/${encodeURIComponent(name)}/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const data = await responseJson(res);
            if (!res.ok || data.success === false) throw new Error(data.error || 'Could not refresh authorization');
            closeModal();
            await fetchMcp(false);
            openConnectorDetail(name);
            showToast(`${meta.label} refreshed.`, 'success');
        },
    });
}

function initProfile() {
    document.querySelectorAll('[data-profile-panel]').forEach(button => {
        button.addEventListener('click', () => showProfilePanel(button.dataset.profilePanel));
    });
    el('signOutBtn').addEventListener('click', signOut);
    el('deleteAccountBtn').addEventListener('click', deleteUserAccount);
    el('changePasswordBtn').addEventListener('click', async () => {
        if (!currentUser || !currentUser.email) {
            showToast('No email is associated with this account.', 'error');
            return;
        }
        try {
            const res = await apiFetch('/auth/forgot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: currentUser.email }),
            });
            const data = await responseJson(res);
            if (!res.ok) throw new Error(data.error || 'Could not send reset link');
            showToast('Password reset link sent.', 'success');
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    el('editProfileBtn').addEventListener('click', () => {
        el('profileEditor').classList.remove('hidden');
        el('profilePreview').classList.add('hidden');
        el('editProfileBtn').classList.add('hidden');
        el('profileInput').value = profileData ? profileData.user_md || '' : '';
        el('profileInput').focus();
    });
    el('cancelProfileBtn').addEventListener('click', () => {
        el('profileEditor').classList.add('hidden');
        el('profilePreview').classList.remove('hidden');
        el('editProfileBtn').classList.remove('hidden');
        setFieldError('profileError', '');
    });
    el('saveProfileBtn').addEventListener('click', saveUserProfile);
    el('onboardingBtn').addEventListener('click', () => el('onboarding').classList.remove('hidden'));
    el('onboardingSave').addEventListener('click', saveOnboarding);
}

function showProfilePanel(panel) {
    const panels = ['about', 'security', 'preferences'];
    el('profileHub').classList.toggle('hidden', panel !== 'hub');
    panels.forEach(name => el(`profile${name.charAt(0).toUpperCase()}${name.slice(1)}`).classList.toggle('hidden', panel !== name));
    if (panel === 'about') fetchProfile(false);
}

async function fetchProfile(showSkeleton = true) {
    if (showSkeleton) {
        el('profileLoading').classList.remove('hidden');
        el('profilePreview').classList.add('hidden');
    }
    try {
        const res = await apiFetch('/profile');
        if (!res.ok) return;
        profileData = await res.json();
        el('profileInput').value = profileData.user_md || '';
        el('profileUpdated').textContent = profileData.updated_at ? formatTimestamp(profileData.updated_at) : '';
        el('profilePreview').innerHTML = renderSafeMarkdown(profileData.user_md || '');
        el('googleStatus').textContent = authConfig && authConfig.google ? 'Available' : 'Not configured';
        renderUser();
        if (showSkeleton) {
            el('profileLoading').classList.add('hidden');
            el('profilePreview').classList.remove('hidden');
        }
        if (pendingOnboarding() && String(profileData.user_md || '').includes('- Name:')) {
            clearPendingOnboarding();
            el('onboarding').classList.remove('hidden');
        }
    } catch {
        el('profilePreview').innerHTML = '<div class="error-message">Profile unavailable. Retry when you are back online.</div>';
    }
}

function pendingOnboarding() {
    return localStorage.getItem('aiyako_pending_onboarding') === '1';
}

function clearPendingOnboarding() {
    localStorage.removeItem('aiyako_pending_onboarding');
}

async function saveUserProfile() {
    setBusy(el('saveProfileBtn'), true, 'SAVING…', 'Save');
    setFieldError('profileError', '');
    try {
        const res = await apiFetch('/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_md: el('profileInput').value }),
        });
        const data = await responseJson(res);
        if (!res.ok) throw new Error(data.error || 'Could not save profile');
        profileData = data;
        el('profileInput').value = data.user_md || '';
        el('profileUpdated').textContent = formatTimestamp(data.updated_at);
        el('profilePreview').innerHTML = renderSafeMarkdown(data.user_md || '');
        el('profileEditor').classList.add('hidden');
        el('profilePreview').classList.remove('hidden');
        el('editProfileBtn').classList.remove('hidden');
        showToast('Profile saved.', 'success');
    } catch (err) {
        setFieldError('profileError', err.message);
        showToast(err.message, 'error');
    } finally {
        setBusy(el('saveProfileBtn'), false, 'SAVING…', 'Save');
    }
}

async function saveOnboarding() {
    const name = el('onboardingName').value.trim();
    const location = el('onboardingLocation').value.trim();
    const focus = el('onboardingFocus').value;
    const markdown = `# About you\n\n## Basics\n- Name: ${name || (currentUser && currentUser.name) || ''}\n- Location: ${location}\n\n## Focus\n- ${focus} is where I want the most help.\n\n## Preferences\n- Give practical next steps and keep answers direct.\n`;
    setBusy(el('onboardingSave'), true, 'SAVING…', 'Save profile');
    setFieldError('onboardingError', '');
    try {
        const res = await apiFetch('/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_md: markdown }),
        });
        const data = await responseJson(res);
        if (!res.ok) throw new Error(data.error || 'Could not save profile');
        profileData = data;
        el('profileInput').value = data.user_md || '';
        el('profileUpdated').textContent = formatTimestamp(data.updated_at);
        el('profilePreview').innerHTML = renderSafeMarkdown(data.user_md || '');
        clearPendingOnboarding();
        el('onboarding').classList.add('hidden');
        showToast('Profile ready.', 'success');
    } catch (err) {
        setFieldError('onboardingError', err.message);
    } finally {
        setBusy(el('onboardingSave'), false, 'SAVING…', 'Save profile');
    }
}

async function signOut() {
    try {
        await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
        setLastError('Could not reach the server during sign out.');
    }
    currentUser = null;
    profileData = null;
    currentSessionId = null;
    localStorage.removeItem(SESSION_KEY);
    showAuth();
}

function deleteUserAccount() {
    openModal({
        eyebrow: 'ACCOUNT',
        title: 'Delete your account?',
        bodyHtml: '<p>This deletes your sessions, messages, goals, artifacts, and profile. This cannot be undone.</p><label class="field-label" for="deleteConfirm">Type DELETE to confirm</label><input id="deleteConfirm" class="field-input" type="text" autocomplete="off">',
        primaryLabel: 'Delete account',
        danger: true,
        onPrimary: async modal => {
            if (modal.querySelector('#deleteConfirm').value !== 'DELETE') {
                el('modalError').textContent = 'Type DELETE exactly to continue.';
                return;
            }
            const res = await apiFetch('/auth/account', { method: 'DELETE' });
            const data = await responseJson(res);
            if (!res.ok) throw new Error(data.error || 'Could not delete account');
            closeModal();
            currentUser = null;
            profileData = null;
            currentSessionId = null;
            localStorage.removeItem(SESSION_KEY);
            showAuth();
            showToast('Account deleted.', 'success');
        },
    });
}

function initAuthForms() {
    document.querySelectorAll('[data-auth-screen]').forEach(button => {
        button.addEventListener('click', () => showAuthScreen(button.dataset.authScreen));
    });

    document.querySelectorAll('.reveal-btn').forEach(button => {
        button.addEventListener('click', () => {
            const input = el(button.dataset.target);
            if (!input) return;
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            button.textContent = showing ? 'SHOW' : 'HIDE';
        });
    });

    el('googleBtn').addEventListener('click', () => {
        window.location.href = '/auth/google';
    });

    el('registerForm').addEventListener('submit', async event => {
        event.preventDefault();
        const password = el('registerPassword').value;
        const confirm = el('registerConfirm').value;
        if (password !== confirm) {
            setFieldError('registerConfirmError', 'Passwords do not match.');
            return;
        }
        const data = await authRequest('/auth/register', {
            name: el('registerName').value.trim(),
            email: el('registerEmail').value.trim(),
            password,
            confirm,
        }, el('registerSubmit'), 'CREATING…', 'Create account', 'registerEmailError');
        if (!data) return;
        localStorage.setItem('aiyako_pending_onboarding', '1');
        currentUser = data.user;
        clearAuthErrors();
        await showApp();
    });

    el('signinForm').addEventListener('submit', async event => {
        event.preventDefault();
        const data = await authRequest('/auth/login', {
            email: el('signinEmail').value.trim(),
            password: el('signinPassword').value,
        }, el('signinSubmit'), 'SIGNING IN…', 'Sign in', 'signinPasswordError');
        if (!data) return;
        currentUser = data.user;
        clearAuthErrors();
        await showApp();
    });

    el('forgotForm').addEventListener('submit', async event => {
        event.preventDefault();
        const data = await authRequest('/auth/forgot', {
            email: el('forgotEmail').value.trim(),
        }, el('forgotSubmit'), 'SENDING…', 'Send reset link', 'forgotEmailError');
        if (!data) return;
        const success = el('forgotSuccess');
        success.classList.remove('hidden');
        success.innerHTML = data.token
            ? `Development reset link:<br><a href="${escapeHtml(data.resetUrl)}">${escapeHtml(data.resetUrl)}</a>`
            : `We sent a reset link to ${escapeHtml(el('forgotEmail').value.trim())}.`;
        el('forgotBackBtn').classList.remove('hidden');
    });

    el('resetForm').addEventListener('submit', async event => {
        event.preventDefault();
        const password = el('resetPassword').value;
        const confirm = el('resetConfirm').value;
        if (password !== confirm) {
            setFieldError('resetError', 'Passwords do not match.');
            return;
        }
        const token = new URLSearchParams(window.location.search).get('reset');
        const data = await authRequest('/auth/reset', {
            token,
            password,
            confirm,
        }, el('resetSubmit'), 'SAVING…', 'Save password', 'resetError');
        if (!data) return;
        window.history.replaceState({}, '', window.location.pathname);
        showAuthScreen('authSignin');
        showToast('Password updated. Sign in to continue.', 'success');
    });

    const params = new URLSearchParams(window.location.search);
    if (params.get('reset')) showAuthScreen('authReset');
    else if (params.get('authError')) setFieldError('authWelcomeError', `Google sign-in failed: ${params.get('authError')}`);
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
        const data = await responseJson(res);
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    } catch (err) {
        setFieldError(errorId, err.message || 'Request failed');
        return null;
    } finally {
        setBusy(button, false, busyText, idleText);
    }
}
