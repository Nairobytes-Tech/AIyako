import type {
    Session,
    SessionWithData,
    SessionStatus,
    Message,
    MessageRole,
    Artifact,
    ArtifactType,
} from '../types/index.js';

export declare const VALID_ROLES: MessageRole[];

export declare function createSession(userId?: string | null, title?: string | null): Session;

export declare function getSession(sessionId: string): SessionWithData | null;

export declare function listSessions(): Session[];

export declare function updateSessionTitle(sessionId: string, title: string): boolean;

export declare function appendMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
    meta?: {
        toolName?: string | null;
        toolArgs?: Record<string, unknown> | null;
        toolCalls?: import('../types/index.js').ToolCallTurn[] | null;
        toolCallId?: string | null;
    }
): Message;

export declare function setStatus(
    sessionId: string,
    status: SessionStatus,
    meta?: { tool?: string }
): boolean;

export declare function getMessages(sessionId: string, limit?: number): Message[];

export declare function deleteSession(sessionId: string): boolean;

export declare function addArtifact(
    sessionId: string,
    type: ArtifactType,
    title: string | null,
    content: string | null
): Artifact;

export declare function listArtifacts(sessionId: string): Artifact[];
