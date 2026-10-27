import { z } from 'zod';
import { getDb } from '../db/database.js';

export const listTasksSchema = z.object({
    completed: z.boolean().optional(),
});

export async function listTasks(input) {
    const parsed = listTasksSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: parsed.error.errors[0].message };
    }

    const db = getDb();

    if (parsed.data.completed === undefined) {
        const stmt = db.prepare(
            'SELECT id, title, due_date, completed, created_at FROM tasks ORDER BY created_at DESC'
        );
        const tasks = stmt.all();
        return {
            success: true,
            data: {
                tasks: tasks.map(t => ({
                    id: Number(t.id),
                    title: t.title,
                    due_date: t.due_date,
                    completed: Boolean(t.completed),
                    created_at: t.created_at,
                })),
            },
        };
    }

    const stmt = db.prepare(
        'SELECT id, title, due_date, completed, created_at FROM tasks WHERE completed = ? ORDER BY created_at DESC'
    );
    const tasks = stmt.all(parsed.data.completed ? 1 : 0);
    return {
        success: true,
        data: {
            tasks: tasks.map(t => ({
                id: Number(t.id),
                title: t.title,
                due_date: t.due_date,
                completed: Boolean(t.completed),
                created_at: t.created_at,
            })),
        },
    };
}
