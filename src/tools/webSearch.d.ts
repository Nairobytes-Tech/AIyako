import type { WebSearchInput, WebSearchResult } from '../types/index.js';
import type { z } from 'zod';

export declare const webSearchSchema: z.ZodObject<{
    query: z.ZodString;
    num_results: z.ZodOptional<z.ZodNumber>;
}>;

export declare function webSearch(input: WebSearchInput): Promise<WebSearchResult>;

export declare function clearWebSearchCache(): void;
