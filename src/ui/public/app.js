const API_BASE = '';

let isOnline = navigator.onLine;
let isProcessing = false;

const statusBar = document.getElementById('status');
const modelStatus = document.getElementById('modelStatus');
const connectionStatus = document.getElementById('connectionStatus');
const chatContainer = document.getElementById('chatContainer');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const taskList = document.getElementById('taskList');
const noteList = document.getElementById('noteList');
const refreshTasksBtn = document.getElementById('refreshTasks');
const refreshNotesBtn = document.getElementById('refreshNotes');

updateConnectionStatus();

window.addEventListener('online', () => {
    isOnline = true;
    updateConnectionStatus();
});

window.addEventListener('offline', () => {
    isOnline = false;
    updateConnectionStatus();
});

function updateConnectionStatus() {
    connectionStatus.textContent = `Network: ${isOnline ? 'Online (local mode)' : 'Offline'}`;
    connectionStatus.style.color = isOnline ? '#e94560' : '#e94560';
}

async function checkHealth() {
    try {
        const res = await fetch(`${API_BASE}/health`);
        if (res.ok) {
            const data = await res.json();
            modelStatus.textContent = `Model: Loaded (offline: ${data.offline})`;
        }
    } catch (err) {
        modelStatus.textContent = 'Model: Unavailable';
    }
}

async function fetchTasks() {
    try {
        const res = await fetch(`${API_BASE}/tasks`);
        const data = await res.json();
        renderTasks(data.tasks);
    } catch (err) {
        taskList.innerHTML = '<li class="error">Failed to load tasks</li>';
    }
}

async function fetchNotes() {
    try {
        const res = await fetch(`${API_BASE}/notes`);
        const data = await res.json();
        renderNotes(data.notes);
    } catch (err) {
        noteList.innerHTML = '<li class="error">Failed to load notes</li>';
    }
}

function renderTasks(tasks) {
    if (!tasks.length) {
        taskList.innerHTML = '<div class="empty-state">No tasks yet</div>';
        return;
    }
    taskList.innerHTML = tasks.map(t => `
        <li class="${t.completed ? 'completed' : ''}">
            ${t.title}
            <div class="meta">ID: ${t.id}${t.due_date ? ` • Due: ${t.due_date}` : ''}</div>
        </li>
    `).join('');
}

function renderNotes(notes) {
    if (!notes.length) {
        noteList.innerHTML = '<div class="empty-state">No notes yet</div>';
        return;
    }
    noteList.innerHTML = notes.map(n => `
        <li>${n.content}
            <div class="meta">${n.created_at}</div>
        </li>
    `).join('');
}

function addMessage(content, role) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = content;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return div;
}

function addToolCall(name, args) {
    const div = document.createElement('div');
    div.className = 'message assistant tool';
    div.innerHTML = `<div class="tool-call">${name}(${JSON.stringify(args)})</div>`;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return div;
}

function addToolResult(result) {
    const div = document.createElement('div');
    div.className = 'message assistant';
    const color = result.success ? '#a0cfa0' : '#e94560';
    div.innerHTML = `<div class="tool-result" style="color:${color}">${JSON.stringify(result)}</div>`;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function showTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.id = 'typing';
    div.textContent = '...';
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return div;
}

function removeTypingIndicator() {
    const typing = document.getElementById('typing');
    if (typing) typing.remove();
}

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isProcessing) return;

    const message = messageInput.value.trim();
    if (!message) return;

    isProcessing = true;
    sendBtn.disabled = true;

    addMessage(message, 'user');
    messageInput.value = '';
    messageInput.focus();

    const typing = showTypingIndicator();

    try {
        const res = await fetch(`${API_BASE}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
        });

        if (!res.ok) {
            const err = await res.json();
            removeTypingIndicator();
            addMessage(`Error: ${err.error || 'Unknown error'}`, 'assistant');
            return;
        }

        const data = await res.json();
        removeTypingIndicator();

        for (const tc of data.toolCalls) {
            addToolCall(tc.name, tc.arguments);
        }
        for (const tr of data.toolResults) {
            addToolResult(tr.result);
        }

        if (data.reply) {
            addMessage(data.reply, 'assistant');
        }

        await Promise.all([fetchTasks(), fetchNotes()]);
    } catch (err) {
        removeTypingIndicator();
        addMessage(`Connection error: ${err.message}`, 'assistant');
    } finally {
        isProcessing = false;
        sendBtn.disabled = false;
    }
});

refreshTasksBtn.addEventListener('click', fetchTasks);
refreshNotesBtn.addEventListener('click', fetchNotes);

checkHealth();
fetchTasks();
fetchNotes();
