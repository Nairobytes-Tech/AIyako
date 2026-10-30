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
