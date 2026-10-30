import type { SaveNoteInput, SaveNoteResult } from '../types/index.js';
import type { z } from 'zod';

export declare const saveNoteSchema: z.ZodObject<{
    text: z.ZodString;
}>;

export declare function saveNote(input: SaveNoteInput): Promise<SaveNoteResult>;
