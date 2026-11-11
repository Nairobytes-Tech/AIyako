import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, closeDb } from '../src/db/database.js';
import { saveNote } from '../src/tools/saveNote.js';
import { searchNotes } from '../src/tools/searchNotes.js';
import { createTask } from '../src/tools/createTask.js';
import { listTasks } from '../src/tools/listTasks.js';
import { markTaskDone } from '../src/tools/markTaskDone.js';
import { webSearch, clearWebSearchCache } from '../src/tools/webSearch.js';
import { executeTool, toolDefinitions } from '../src/tools/index.js';

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

        test('rejects non-string text', async () => {
            const result = await saveNote({ text: 12345 });
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

        test('rejects empty query', async () => {
            const result = await searchNotes({ query: '' });
            assert.equal(result.success, false);
        });

        test('rejects missing query', async () => {
            const result = await searchNotes({});
            assert.equal(result.success, false);
        });

        test('applies limit parameter', async () => {
            await saveNote({ text: 'first note about apples' });
            await saveNote({ text: 'second note about apples and oranges' });
            await saveNote({ text: 'third note about apples' });
            const result = await searchNotes({ query: 'apples', limit: 2 });
            assert.equal(result.data.results.length, 2);
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

        test('rejects empty title', async () => {
            const result = await createTask({ title: '' });
            assert.equal(result.success, false);
        });

        test('rejects missing title', async () => {
            const result = await createTask({});
            assert.equal(result.success, false);
        });

        test('parses ISO date format', async () => {
            const result = await createTask({ title: 'Meeting', due_date: '2026-11-15' });
            assert.equal(result.success, true);
            assert.equal(result.data.due_date, '2026-11-15');
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

        test('returns tasks in creation order (most recent first)', async () => {
            const t1 = await createTask({ title: 'First task' });
            const t2 = await createTask({ title: 'Second task' });
            const result = await listTasks({});
            const ids = result.data.tasks.map(t => t.id).reverse();
            const foundT1 = ids.indexOf(t1.data.id) >= 0;
            const foundT2 = ids.indexOf(t2.data.id) >= 0;
            assert.ok(foundT1 && foundT2);
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

        test('rejects invalid id type', async () => {
            const result = await markTaskDone({ id: 'not-a-number' });
            assert.equal(result.success, false);
        });

        test('rejects missing id', async () => {
            const result = await markTaskDone({});
            assert.equal(result.success, false);
        });
    });

    describe('web_search', () => {
        const originalFetch = globalThis.fetch;
        const originalUrl = process.env.SEARXNG_URL;

        beforeEach(() => {
            clearWebSearchCache();
            process.env.SEARXNG_URL = 'http://searx.test:8080';
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
            clearWebSearchCache();
            if (originalUrl === undefined) {
                delete process.env.SEARXNG_URL;
            } else {
                process.env.SEARXNG_URL = originalUrl;
            }
        });

        test('normalizes, dedupes and limits results', async () => {
            globalThis.fetch = async url => {
                assert.match(url.toString(), /^http:\/\/searx\.test:8080\/search\?/);
                assert.equal(url.searchParams.get('format'), 'json');
                return new Response(JSON.stringify({
                    results: [
                        { title: 'First', url: 'https://first.example', content: 'first snippet' },
                        { title: 'Duplicate', url: 'https://first.example', content: 'duplicate' },
                        { title: 'Second', url: 'https://second.example', content: 'second snippet' },
                        { title: 'Third', url: 'https://third.example', content: 'third snippet' },
                    ],
                }), { status: 200 });
            };

            const result = await webSearch({ query: 'kioo ai', num_results: 2 });
            assert.equal(result.success, true);
            assert.equal(result.data.cached, false);
            assert.deepEqual(result.data.results, [
                { title: 'First', url: 'https://first.example', snippet: 'first snippet' },
                { title: 'Second', url: 'https://second.example', snippet: 'second snippet' },
            ]);
        });

        test('caches repeated queries', async () => {
            let calls = 0;
            globalThis.fetch = async () => {
                calls += 1;
                return new Response(JSON.stringify({
                    results: [{ title: 'Cached', url: 'https://cached.example', content: 'cached snippet' }],
                }), { status: 200 });
            };

            const first = await webSearch({ query: 'cached query', num_results: 1 });
            const second = await webSearch({ query: 'cached query', num_results: 1 });

            assert.equal(calls, 1);
            assert.equal(first.data.cached, false);
            assert.equal(second.data.cached, true);
            assert.deepEqual(second.data.results, first.data.results);
        });

        test('rejects invalid input', async () => {
            assert.equal((await webSearch({ query: '' })).success, false);
            assert.equal((await webSearch({ query: 'x', num_results: 100 })).success, false);
        });

        test('reports backend errors', async () => {
            globalThis.fetch = async () => new Response('unavailable', { status: 502 });
            const result = await webSearch({ query: 'error query' });
            assert.equal(result.success, false);
            assert.match(result.error, /HTTP 502/);
        });

        test('rejects invalid backend payloads', async () => {
            globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
            const result = await webSearch({ query: 'invalid payload' });
            assert.equal(result.success, false);
            assert.match(result.error, /invalid response/i);
        });

        test('reports network failures', async () => {
            globalThis.fetch = async () => { throw new Error('boom'); };
            const result = await webSearch({ query: 'network query' });
            assert.equal(result.success, false);
            assert.match(result.error, /Search request failed/);
        });

        test('dispatches through executeTool', async () => {
            globalThis.fetch = async () => new Response(JSON.stringify({
                results: [{ title: 'Dispatch', url: 'https://dispatch.example', content: 'ok' }],
            }), { status: 200 });

            const result = await executeTool('web_search', { query: 'dispatch query' });
            assert.equal(result.success, true);
        });
    });

    describe('executeTool', () => {
        test('dispatches to save_note correctly', async () => {
            const result = await executeTool('save_note', { text: 'test note' });
            assert.equal(result.success, true);
        });

        test('dispatches to search_notes correctly', async () => {
            const result = await executeTool('search_notes', { query: 'test' });
            assert.equal(result.success, true);
        });

        test('dispatches to create_task correctly', async () => {
            const result = await executeTool('create_task', { title: 'test task' });
            assert.equal(result.success, true);
        });

        test('dispatches to list_tasks correctly', async () => {
            const result = await executeTool('list_tasks', {});
            assert.equal(result.success, true);
        });

        test('dispatches to mark_task_done correctly', async () => {
            const created = await executeTool('create_task', { title: 'test' });
            const result = await executeTool('mark_task_done', { id: created.data.id });
            assert.equal(result.success, true);
        });

        test('returns error for unknown tool', async () => {
            const result = await executeTool('nonexistent_tool', {});
            assert.equal(result.success, false);
            assert.ok(result.error?.includes('Unknown tool'));
        });

        test('returns error for shell_exec', async () => {
            const result = await executeTool('shell_exec', { cmd: 'ls' });
            assert.equal(result.success, false);
        });

        test('returns error for sql_exec', async () => {
            const result = await executeTool('sql_exec', { query: 'DROP TABLE notes' });
            assert.equal(result.success, false);
        });

        test('returns error for file_write', async () => {
            const result = await executeTool('file_write', { path: '/etc/passwd', content: 'hacked' });
            assert.equal(result.success, false);
        });
    });

    describe('toolDefinitions', () => {
        test('exports 6 tools', () => {
            assert.equal(toolDefinitions.length, 6);
        });

        test('all tools have required fields', () => {
            for (const def of toolDefinitions) {
                assert.ok(def.name);
                assert.ok(def.description);
                assert.ok(def.parameters);
            }
        });

        test('all tool names match expected set', () => {
            const names = toolDefinitions.map(d => d.name).sort();
            assert.deepEqual(names, ['create_task', 'list_tasks', 'mark_task_done', 'save_note', 'search_notes', 'web_search']);
        });

        test('no dangerous tools exposed', () => {
            const names = toolDefinitions.map(d => d.name);
            const dangerous = ['shell_exec', 'sql_exec', 'file_write', 'file_read', 'system'];
            for (const d of dangerous) {
                assert.ok(!names.includes(d), `Dangerous tool "${d}" should not be in definitions`);
            }
        });
    });

    describe('Persistence across process restarts', () => {
        test('data survives closeDb + getDb cycle', async () => {
            await saveNote({ text: 'persistent note' });
            await createTask({ title: 'persistent task' });

            closeDb();

            const db2 = getDb();
            const notes = db2.prepare('SELECT COUNT(*) as count FROM notes').get();
            const tasks = db2.prepare('SELECT COUNT(*) as count FROM tasks').get();
            assert.equal(notes.count, 1);
            assert.equal(tasks.count, 1);
            closeDb();
        });

        test('data survives full DB file recreation', async () => {
            const created = await createTask({ title: 'survives restart' });

            closeDb();

            await createTask({ title: 'after restart' });

            const allTasks = await listTasks({});
            assert.equal(allTasks.data.tasks.length, 2);
            assert.ok(allTasks.data.tasks.some(t => t.id === created.data.id));
        });
    });

    describe('SQL injection safety', () => {
        test('save_note uses parameterized query', async () => {
            const result = await saveNote({ text: "'; DROP TABLE notes; --" });
            assert.equal(result.success, true);

            const db = getDb();
            const count = db.prepare('SELECT COUNT(*) as count FROM notes').get();
            assert.equal(count.count, 1);
        });

        test('search_notes uses parameterized query', async () => {
            await saveNote({ text: 'normal note' });
            const result = await searchNotes({ query: "'; DROP TABLE notes; --" });
            assert.equal(result.success, true);

            const db = getDb();
            const count = db.prepare('SELECT COUNT(*) as count FROM notes').get();
            assert.equal(count.count, 1);
        });
    });
});
