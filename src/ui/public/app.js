const API_BASE = '';

let isOnline = navigator.onLine;
let isProcessing = false;

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const connectionStatus = document.getElementById('connectionStatus');
const modelStatus = document.getElementById('modelStatus');
const chatContainer = document.getElementById('chatContainer');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const taskListEl = document.getElementById('taskList');
const noteListEl = document.getElementById('noteList');
const navTabs = document.querySelectorAll('.nav-tab');
const views = document.querySelectorAll('.chat-view, .tasks-view, .notes-view, .library-view');

initApp();

function initApp() {
    connectionStatus.textContent = `Network: ${isOnline ? 'Online' : 'Offline'}`;
    sendBtn.disabled = true;
    checkHealth();
    initNav();
    initChat();

    messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    });

    messageInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!isProcessing && messageInput.value.trim()) {
                chatForm.dispatchEvent(new Event('submit'));
            }
        }
    });

    const addTaskBtn = document.getElementById('addTaskBtn');
    if (addTaskBtn) {
        addTaskBtn.addEventListener('click', () => {
            addAssistantMessage('I can help you create tasks! Just tell me what you need to do in the chat.');
        });
    }

    messageInput.addEventListener('input', () => {
        sendBtn.disabled = !messageInput.value.trim();
    });
}

function initNav() {
    navTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            navTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            views.forEach(v => v.classList.remove('active'));
            document.getElementById(`${tab.dataset.tab}View`).classList.add('active');
            if (tab.dataset.tab === 'tasks') fetchTasks();
            if (tab.dataset.tab === 'notes') fetchNotes();
        });
    });
}

function initChat() {
    chatForm.addEventListener('submit', handleChatSubmit);
}

async function checkHealth() {
    try {
        const res = await fetch(`${API_BASE}/health`);
        const data = await res.json();
        modelStatus.textContent = `Model: ${data.modelLoaded ? 'Loaded' : 'Not loaded'}`;
        if (data.modelLoaded) {
            statusDot.className = 'status-dot';
            statusText.textContent = 'Ready';
        } else {
            statusDot.className = 'status-dot offline';
            statusText.textContent = 'Offline';
        }
    } catch (err) {
        modelStatus.textContent = 'Model: Unavailable';
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline';
    }
}

async function handleChatSubmit(e) {
    e.preventDefault();
    if (isProcessing) return;

    const message = messageInput.value.trim();
    if (!message) return;

    isProcessing = true;
    sendBtn.disabled = true;

    addMessage(message, 'user');
    messageInput.value = '';
    messageInput.style.height = 'auto';

    const typing = showTyping();

    try {
        statusDot.className = 'status-dot thinking';
        statusText.textContent = 'Thinking...';

        const res = await fetch(`${API_BASE}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
        });

        if (!res.ok) {
            const err = await res.json();
            removeTyping();
            addMessage(`Error: ${err.error || 'Something went wrong'}`, 'assistant', 'error');
            statusDot.className = 'status-dot offline';
            statusText.textContent = 'Error';
            return;
        }

        const data = await res.json();

        statusDot.className = 'status-dot processing';
        statusText.textContent = 'Processing tools...';

        removeTyping();

        for (const tc of data.toolCalls) {
            addToolCall(tc.name, tc.arguments);
        }

        statusText.textContent = 'Running tools...';

        for (const tr of data.toolResults) {
            addToolResult(tr);
        }

        if (data.reply) {
            addMessage(data.reply, 'assistant');
        }

        statusDot.className = 'status-dot';
        statusText.textContent = 'Ready';

        await Promise.all([fetchTasks(), fetchNotes()]);
    } catch (err) {
        removeTyping();
        addMessage(`Connection error: ${err.message}`, 'assistant', 'error');
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline';
    } finally {
        isProcessing = false;
        sendBtn.disabled = !messageInput.value.trim();
    }
}

function showTyping() {
    if (chatContainer.querySelector('.typing')) return;
    const div = document.createElement('div');
    div.className = 'typing';
    div.id = 'typing';
    div.innerHTML = `
        <div class="message assistant" style="background: transparent; border: none; box-shadow: none;">
            <div class="typing-indicator">
                <span>•</span><span>•</span><span>•
            </div>
        </div>
    `;
    chatContainer.appendChild(div);
    scrollToBottom();
    return div;
}

function removeTyping() {
    const typing = document.getElementById('typing');
    if (typing) typing.remove();
}

function addMessage(text, role, type = '') {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    if (type === 'error' || type === 'system') {
        div.classList.remove(role);
        div.className = `message ${type}`;
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    div.innerHTML = `<div class="msg-text">${escapeHtml(text)}</div><div class="time">${timeStr}</div>`;
    chatContainer.appendChild(div);
    scrollToBottom();
}

function addAssistantMessage(text) {
    addMessage(text, 'assistant');
}

function addToolCall(name, args) {
    const div = document.createElement('div');
    div.className = 'message-tool';
    div.innerHTML = `
        <div class="tool-call">
            <span class="tool-name">${escapeHtml(name)}</span>
            ${args ? escapeHtml(JSON.stringify(args)) : ''}
        </div>
    `;
    chatContainer.appendChild(div);
    scrollToBottom();
}

function addToolResult(result) {
    const div = document.createElement('div');
    div.className = 'message-tool';
    const isSuccess = result && result.success;
    const statusIcon = isSuccess ? '✅' : '❌';
    const statusText = isSuccess ? 'Success' : (result?.error || 'Failed');
    const dataPreview = isSuccess && result.data
        ? `<pre style="margin-top:4px;white-space:pre-wrap;max-width:100%">${escapeHtml(JSON.stringify(result.data, null, 2))}</pre>`
        : '';
    div.innerHTML = `
        <div class="tool-result ${isSuccess ? '' : 'error'}">
            ${statusIcon} ${escapeHtml(statusText)}
            ${dataPreview}
        </div>
    `;
    chatContainer.appendChild(div);
    scrollToBottom();
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
        chatContainer.scrollTop = chatContainer.scrollHeight;
    });
}

async function fetchTasks() {
    try {
        const res = await fetch(`${API_BASE}/tasks`);
        const data = await res.json();

        if (!data.tasks || !data.tasks.length) {
            taskListEl.innerHTML = '<div class="empty-chat"><p>No tasks yet</p></div>';
            return;
        }

        const ul = document.createElement('ul');
        ul.className = 'item-list';
        ul.innerHTML = data.tasks.map(t => `
            <li class="${t.completed ? 'completed' : ''}">
                ${escapeHtml(t.title)}
                <div class="meta">ID: ${t.id}${t.due_date ? ` • Due: ${escapeHtml(t.due_date)}` : ''} • ${new Date(t.created_at).toLocaleDateString()}</div>
            </li>
        `).join('');
        taskListEl.innerHTML = '';
        taskListEl.appendChild(ul);
    } catch (err) {
        taskListEl.innerHTML = '<div class="error-message">Failed to load tasks</div>';
    }
}

async function fetchNotes() {
    try {
        const res = await fetch(`${API_BASE}/notes`);
        const data = await res.json();

        if (!data.notes || !data.notes.length) {
            noteListEl.innerHTML = '<div class="empty-chat"><p>No notes yet</p></div>';
            return;
        }

        const ul = document.createElement('ul');
        ul.className = 'item-list';
        ul.innerHTML = data.notes.map(n => `
            <li>${escapeHtml(n.content)}
                <div class="meta">${new Date(n.created_at + 'T00:00:00').toLocaleString()}</div>
            </li>
        `).join('');
        noteListEl.innerHTML = '';
        noteListEl.appendChild(ul);
    } catch (err) {
        noteListEl.innerHTML = '<div class="error-message">Failed to load notes</div>';
    }
}

window.addEventListener('online', () => {
    isOnline = true;
    connectionStatus.textContent = 'Network: Online';
});

window.addEventListener('offline', () => {
    isOnline = false;
    connectionStatus.textContent = 'Network: Offline (local mode)';
});

sendBtn.disabled = false;
