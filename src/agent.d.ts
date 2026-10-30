import type { ToolResult } from '../tools/index.js';
import type { ToolName } from '../types/index.js';

export interface AgentOptions {
    modelPath?: string;
    maxIterations?: number;
    temperature?: number;
}

export interface AgentResult {
    success: boolean;
    message?: string;
    error?: string;
}

export declare function runAgent(userInput: string, options?: AgentOptions): Promise<AgentResult>;
