export interface Note {
    id: number;
    content: string;
    created_at: string;
    updated_at: string;
}

export interface Task {
    id: number;
    title: string;
    due_date: string | null;
    completed: boolean;
    created_at: string;
    updated_at: string;
}

export interface ToolResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}

export interface SaveNoteInput {
    text: string;
}

export interface SaveNoteResult extends ToolResult<{
    id: number;
    content: string;
    saved_at: string;
}> {}

export interface SearchNotesInput {
    query: string;
    limit?: number;
}

export interface NoteSearchResult {
    id: number;
    content: string;
    created_at: string;
}

export interface SearchNotesResult extends ToolResult<{
    results: NoteSearchResult[];
}> {}

export interface CreateTaskInput {
    title: string;
    due_date?: string | null;
}

export interface CreateTaskResult extends ToolResult<{
    id: number;
    title: string;
    due_date: string | null;
    created_at: string;
}> {}

export interface ListTasksInput {
    completed?: boolean;
}

export interface ListTasksResult extends ToolResult<{
    tasks: Task[];
}> {}

export interface MarkTaskDoneInput {
    id: number;
}

export interface MarkTaskDoneResult extends ToolResult<{
    id: number;
    title: string;
    due_date: string | null;
    completed: boolean;
}> {}

export interface ToolCall {
    name: string;
    arguments: Record<string, unknown>;
}

export type ToolName = 'save_note' | 'search_notes' | 'create_task' | 'list_tasks' | 'mark_task_done';

export type SessionStatus = 'idle' | 'thinking' | 'tool' | 'waiting_approval';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
    id: string;
    session_id: string;
    role: MessageRole;
    content: string;
    tool_name: string | null;
    tool_args: Record<string, unknown> | null;
    tool_calls: ToolCallTurn[] | null;
    tool_call_id: string | null;
    created_at: string;
}

export interface ToolCallTurn {
    id?: string;
    name: string;
    arguments?: Record<string, unknown>;
}

export type GoalStatus = 'active' | 'done' | 'paused';

export interface Goal {
    id: string;
    session_id: string;
    title: string;
    status: GoalStatus;
    progress: string | null;
    created_at: string;
    updated_at: string;
}

export type ArtifactType = 'note' | 'doc' | 'summary' | 'dashboard';

export interface Artifact {
    id: string;
    session_id: string;
    type: ArtifactType;
    title: string | null;
    content: string | null;
    created_at: string;
}

export interface Session {
    id: string;
    user_id: string | null;
    title: string | null;
    status: SessionStatus;
    created_at: string;
    updated_at: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
    id: string;
    session_id: string;
    tool_name: string;
    tool_args: Record<string, unknown> | null;
    tool_call_id: string | null;
    status: ApprovalStatus;
    executed: boolean;
    result: Record<string, unknown> | null;
    created_at: string;
    resolved_at: string | null;
}

export type RouteProvider = 'local' | 'escalation';

export interface RouteDecision {
    provider: RouteProvider;
    modelPath: string | null;
    score: number;
    threshold: number;
    reason: string;
}

export interface SessionWithData extends Session {
    messages: Message[];
    goals: Goal[];
    artifacts: Artifact[];
    approvals: Approval[];
}

export interface RunTurnResult {
    sessionId: string;
    reply: string;
    events: unknown[];
    status: SessionStatus;
    error: string | null;
    approvals: Approval[];
    route: RouteDecision | null;
}
