import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getDb, closeDb } from '../src/db/database.js';
import { saveNote } from '../src/tools/saveNote.js';
import { searchNotes } from '../src/tools/searchNotes.js';
import { createTask } from '../src/tools/createTask.js';
import { listTasks } from '../src/tools/listTasks.js';
import { markTaskDone } from '../src/tools/markTaskDone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Tools', () => {
    beforeEach(() => {
        const db = getDb();
        db.exec('DELETE FROM notes');
        db.exec('DELETE FROM tasks');
    });

    afterEach(() => {
        closeDb();
    });

    describe('save_note', () => {
        test('saves a valid note', async () => {
            const result = await saveNote({ text: 'Hello world' });
            assert.equal(result.success, true);
            assert.equal(result.data.content, 'Hello world');
            assert.ok(result.data.id);
        });

        test('rejects empty text', async () => {
            const result = await saveNote({ text: '' });
            assert.equal(result.success, false);
            assert.ok(result.error);
        });

        test('rejects missing text', async () => {
            const result = await saveNote({});
            assert.equal(result.success, false);
        });
    });

    describe('search_notes', () => {
        test('finds exact matches', async () => {
            await saveNote({ text: 'my transport budget is KES 4,000' });
            const result = await searchNotes({ query: 'transport budget' });
            assert.equal(result.success, true);
            assert.equal(result.data.results.length, 1);
        });

        test('returns empty array when no matches', async () => {
            const result = await searchNotes({ query: 'nonexistent' });
            assert.equal(result.success, true);
            assert.equal(result.data.results.length, 0);
        });
    });

    describe('create_task', () => {
        test('creates task with tomorrow date', async () => {
            const result = await createTask({ title: 'Buy groceries', due_date: 'tomorrow' });
            assert.equal(result.success, true);
            assert.equal(result.data.title, 'Buy groceries');
            assert.ok(result.data.due_date);
        });

        test('creates task without due date', async () => {
            const result = await createTask({ title: 'Read a book' });
            assert.equal(result.success, true);
            assert.equal(result.data.title, 'Read a book');
            assert.equal(result.data.due_date, null);
        });
    });

    describe('list_tasks', () => {
        test('returns empty array initially', async () => {
            const result = await listTasks({});
            assert.equal(result.success, true);
            assert.equal(result.data.tasks.length, 0);
        });

        test('returns all tasks when created', async () => {
            await createTask({ title: 'Task 1' });
            await createTask({ title: 'Task 2' });
            const result = await listTasks({});
            assert.equal(result.data.tasks.length, 2);
        });

        test('filters by completed status', async () => {
            const t1 = await createTask({ title: 'Task 1' });
            await createTask({ title: 'Task 2' });
            await markTaskDone({ id: t1.data.id });
            const pendingOnly = await listTasks({ completed: false });
            const doneOnly = await listTasks({ completed: true });
            assert.equal(pendingOnly.data.tasks.length, 1);
            assert.equal(doneOnly.data.tasks.length, 1);
        });
    });

    describe('mark_task_done', () => {
        test('marks a task as completed', async () => {
            const created = await createTask({ title: 'Test task' });
            const result = await markTaskDone({ id: created.data.id });
            assert.equal(result.success, true);
            assert.equal(result.data.completed, true);
        });

        test('reports error for nonexistent task', async () => {
            const result = await markTaskDone({ id: 999 });
            assert.equal(result.success, false);
            assert.equal(result.error, 'Task 999 not found');
        });
    });
});
