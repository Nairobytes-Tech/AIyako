import { z } from 'zod';
import { getDb } from '../db/database.js';

export const saveNoteSchema = z.object({
    text: z.string().min(1, 'Note text is required'),
});

export async function saveNote(input) {
    const parsed = saveNoteSchema.safeParse(input);
    if (!parsed.success) {
        const errors = parsed.error.issues || parsed.error.errors || [];
        const msg = errors.length > 0 ? errors[0].message : 'Validation failed';
        return { success: false, error: msg };
    }

    const db = getDb();
    const stmt = db.prepare('INSERT INTO notes (content) VALUES (?)');
    const result = stmt.run(parsed.data.text);

    return {
        success: true,
        data: {
            id: Number(result.lastInsertRowid),
            content: parsed.data.text,
            saved_at: new Date().toISOString(),
        },
    };
}
