export interface ToolResultLike {
    success?: boolean;
    error?: string;
    data?: unknown;
}

export declare function formatToolResult(
    name: string,
    result: ToolResultLike | null | undefined,
    args?: Record<string, unknown>
): string;

export declare function formatHistoryForModel<T>(history: T[]): T[];
