import { z } from 'zod';
import { getDb } from '../db/database.js';

export const markTaskDoneSchema = z.object({
    id: z.number().int().min(1),
});

export async function markTaskDone(input) {
    const parsed = markTaskDoneSchema.safeParse(input);
    if (!parsed.success) {
        const errors = parsed.error.issues || parsed.error.errors || [];
        const msg = errors.length > 0 ? errors[0].message : 'Validation failed';
        return { success: false, error: msg };
    }

    const db = getDb();
    const stmt = db.prepare('UPDATE tasks SET completed = 1 WHERE id = ?');
    const result = stmt.run(parsed.data.id);

    if (result.changes === 0) {
        return { success: false, error: `Task ${parsed.data.id} not found` };
    }

    const selectStmt = db.prepare('SELECT id, title, due_date, completed FROM tasks WHERE id = ?');
    const task = selectStmt.get(parsed.data.id);

    return {
        success: true,
        data: {
            id: Number(task.id),
            title: task.title,
            due_date: task.due_date,
            completed: Boolean(task.completed),
        },
    };
}
