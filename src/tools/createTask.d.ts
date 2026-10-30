import type { CreateTaskInput, CreateTaskResult } from '../types/index.js';
import type { z } from 'zod';

export declare const createTaskSchema: z.ZodObject<{
    title: z.ZodString;
    due_date: z.ZodOptional<z.ZodString>;
}>;

export declare function createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
