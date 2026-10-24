import { z } from 'zod';
import { getDb } from '../db/database.js';

export const searchNotesSchema = z.object({
    query: z.string().min(1, 'Search query is required'),
    limit: z.number().int().min(1).max(50).optional().default(10),
});

export async function searchNotes(input) {
    const parsed = searchNotesSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: parsed.error.errors[0].message };
    }

    const db = getDb();
    const { query, limit } = parsed.data;

    const allStmt = db.prepare(
        'SELECT n.id, n.content, n.created_at FROM notes n WHERE n.content LIKE ? ORDER BY n.created_at DESC LIMIT ?'
    );
    const allResults = allStmt.all(`%${query}%`, limit);

    if (allResults.length > 0) {
        return {
            success: true,
            data: {
                results: allResults.map(r => ({
                    id: Number(r.id),
                    content: r.content,
                    created_at: r.created_at,
                })),
            },
        };
    }

    const fuzzyStmt = db.prepare(
        "SELECT n.id, n.content, n.created_at FROM notes n WHERE n.content LIKE ? AND n.content LIKE ? ORDER BY n.created_at DESC LIMIT ?"
    );
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
    let fuzzyResults = [];

    if (keywords.length > 0) {
        for (const kw of keywords) {
            const pattern = `%${kw}%`;
            const matches = fuzzyStmt.all(pattern, pattern, limit);
            fuzzyResults = fuzzyResults.concat(matches);
        }
        fuzzyResults = fuzzyResults.slice(0, limit);
    }

    return {
        success: true,
        data: {
            results: fuzzyResults.map(r => ({
                id: Number(r.id),
                content: r.content,
                created_at: r.created_at,
            })),
        },
    };
}
