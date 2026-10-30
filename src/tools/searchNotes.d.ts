import type { SearchNotesInput, SearchNotesResult } from '../types/index.js';
import type { z } from 'zod';

export declare const searchNotesSchema: z.ZodObject<{
    query: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
}>;

export declare function searchNotes(input: SearchNotesInput): Promise<SearchNotesResult>;
