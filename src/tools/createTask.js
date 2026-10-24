import { z } from 'zod';
import { getDb } from '../db/database.js';

export const createTaskSchema = z.object({
    title: z.string().min(1, 'Task title is required'),
    due_date: z.string().min(1, 'Due date cannot be empty').optional(),
});

function parseDueDate(dateStr) {
    if (!dateStr) return null;

    if (dateStr === 'tomorrow') {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        return d.toISOString().slice(0, 10);
    }

    try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
            return d.toISOString().slice(0, 10);
        }
    } catch {
        // fall through
    }

    return dateStr;
}

export async function createTask(input) {
    const parsed = createTaskSchema.safeParse(input);
    if (!parsed.success) {
        const errors = parsed.error.issues || parsed.error.errors || [];
        const msg = errors.length > 0 ? errors[0].message : 'Validation failed';
        return { success: false, error: msg };
    }

    const db = getDb();
    const dueDate = parseDueDate(parsed.data.due_date);
    const stmt = db.prepare(
        'INSERT INTO tasks (title, due_date) VALUES (?, ?)'
    );
    const result = stmt.run(
        parsed.data.title,
        dueDate
    );

    return {
        success: true,
        data: {
            id: Number(result.lastInsertRowid),
            title: parsed.data.title,
            due_date: dueDate,
            created_at: new Date().toISOString(),
        },
    };
}
