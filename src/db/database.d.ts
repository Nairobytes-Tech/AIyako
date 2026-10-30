export interface NoteRecord {
    id: number;
    content: string;
    created_at: string;
    updated_at: string;
}

export interface TaskRecord {
    id: number;
    title: string;
    due_date: string | null;
    completed: number;
    created_at: string;
    updated_at: string;
}

export interface Database {
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
}

export interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown | undefined;
    run(...params: unknown[]): { lastInsertRowid: bigint; changes: number };
    iterate<RowType = unknown>(...params: unknown[]): IterableIterator<RowType>;
}

export declare function getDb(): Database;
export declare function closeDb(): void;
