import type { SessionStatus as SessionStatusValue } from '../types/index.js';

export declare const SessionStatus: {
    readonly IDLE: 'idle';
    readonly THINKING: 'thinking';
    readonly TOOL: 'tool';
    readonly WAITING_APPROVAL: 'waiting_approval';
};

export declare const STATUSES: SessionStatusValue[];

export interface StatusEvent {
    sessionId: string;
    status: SessionStatusValue;
    updated_at: string;
}

export declare function isValidStatus(status: string): boolean;

export declare function assertStatus(status: string): void;

export declare function onStatusChange(listener: (event: StatusEvent) => void): () => boolean;

export declare function emitStatus(event: StatusEvent): void;
