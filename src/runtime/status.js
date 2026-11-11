export const SessionStatus = Object.freeze({
    IDLE: 'idle',
    THINKING: 'thinking',
    TOOL: 'tool',
    WAITING_APPROVAL: 'waiting_approval',
});

export const STATUSES = Object.values(SessionStatus);

const listeners = new Set();

export function isValidStatus(status) {
    return STATUSES.includes(status);
}

export function assertStatus(status) {
    if (!isValidStatus(status)) {
        throw new Error(`Invalid session status: ${status}`);
    }
}

export function onStatusChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function emitStatus(event) {
    for (const listener of listeners) {
        try {
            listener(event);
        } catch {
            // listener errors must not break the runtime
        }
    }
}
