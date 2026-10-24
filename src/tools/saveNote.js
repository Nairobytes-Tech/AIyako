import { z } from 'zod';
import { getDb } from '../db/database.js';

export const saveNoteSchema = z.object({
    text: z.string().min(1, 'Note text is required'),
});

export async function saveNote(input) {
    const parsed = saveNoteSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: parsed.error.errors[0].message };
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
