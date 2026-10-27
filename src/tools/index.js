import { saveNote, saveNoteSchema } from './saveNote.js';
import { searchNotes, searchNotesSchema } from './searchNotes.js';
import { createTask, createTaskSchema } from './createTask.js';
import { listTasks, listTasksSchema } from './listTasks.js';
import { markTaskDone, markTaskDoneSchema } from './markTaskDone.js';

export const toolDefinitions = [
    {
        name: 'save_note',
        description: 'Persist a note to local storage. Use this when the user wants to save information for later recall.',
        parameters: saveNoteSchema,
    },
    {
        name: 'search_notes',
        description: 'Search for notes containing text similar to the query. Use this to find previously saved information.',
        parameters: searchNotesSchema,
    },
    {
        name: 'create_task',
        description: 'Create a task with a title and optional due date. Use this when the user wants to track something they need to do.',
        parameters: createTaskSchema,
    },
    {
        name: 'list_tasks',
        description: 'List all tasks, optionally filtered by completion status. Use this to see what tasks exist.',
        parameters: listTasksSchema,
    },
    {
        name: 'mark_task_done',
        description: 'Mark a task as completed by its ID. Use this when the user has finished a task.',
        parameters: markTaskDoneSchema,
    },
];

export const executeTool = async (name, args) => {
    switch (name) {
        case 'save_note':
            return await saveNote(args);
        case 'search_notes':
            return await searchNotes(args);
        case 'create_task':
            return await createTask(args);
        case 'list_tasks':
            return await listTasks(args);
        case 'mark_task_done':
            return await markTaskDone(args);
        default:
            return { success: false, error: `Unknown tool: ${name}` };
    }
};

export { saveNote, searchNotes, createTask, listTasks, markTaskDone };
