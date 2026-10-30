import type { MarkTaskDoneInput, MarkTaskDoneResult } from '../types/index.js';
import type { z } from 'zod';

export declare const markTaskDoneSchema: z.ZodObject<{
    id: z.ZodNumber;
}>;

export declare function markTaskDone(input: MarkTaskDoneInput): Promise<MarkTaskDoneResult>;
