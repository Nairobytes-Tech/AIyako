import type { ListTasksInput, ListTasksResult } from '../types/index.js';
import type { z } from 'zod';

export declare const listTasksSchema: z.ZodObject<{
    completed: z.ZodOptional<z.ZodBoolean>;
}>;

export declare function listTasks(input: ListTasksInput): Promise<ListTasksResult>;
