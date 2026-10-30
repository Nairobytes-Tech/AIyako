import type {
    Note,
    Task,
    SaveNoteInput,
    SaveNoteResult,
    SearchNotesInput,
    SearchNotesResult,
    CreateTaskInput,
    CreateTaskResult,
    ListTasksInput,
    ListTasksResult,
    MarkTaskDoneInput,
    MarkTaskDoneResult,
} from './types/index.js';

export {
    Note,
    Task,
    ToolResult,
    ToolCall,
    ToolName,
    SaveNoteInput,
    SaveNoteResult,
    SearchNotesInput,
    SearchNotesResult,
    CreateTaskInput,
    CreateTaskResult,
    ListTasksInput,
    ListTasksResult,
    MarkTaskDoneInput,
    MarkTaskDoneResult,
} from './types/index.js';

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required: string[];
    };
}

export interface ToolExecutor {
    (name: string, args: Record<string, unknown>): Promise<ToolResult<unknown>>;
}

export declare const toolDefinitions: ToolDefinition[];
export declare const executeTool: ToolExecutor;
export declare const saveNote: (input: SaveNoteInput) => Promise<SaveNoteResult>;
export declare const searchNotes: (input: SearchNotesInput) => Promise<SearchNotesResult>;
export declare const createTask: (input: CreateTaskInput) => Promise<CreateTaskResult>;
export declare const listTasks: (input: ListTasksInput) => Promise<ListTasksResult>;
export declare const markTaskDone: (input: MarkTaskDoneInput) => Promise<MarkTaskDoneResult>;
