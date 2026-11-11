import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = path.join(process.cwd(), 'data', 'kioo.db');

const ensureDataDir = () => {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

function migrate(db) {
    const addColumnIfMissing = (table, column, definition) => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        if (!columns.includes(column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
    };

    addColumnIfMissing('messages', 'tool_calls', 'TEXT');
    addColumnIfMissing('messages', 'tool_call_id', 'TEXT');
    addColumnIfMissing('approvals', 'tool_call_id', 'TEXT');
    addColumnIfMissing('approvals', 'result', 'TEXT');
}

let _db = null;

export function getDb() {
    if (_db !== null) {
        return _db;
    }
    ensureDataDir();
    _db = new DatabaseSync(DB_PATH);
    _db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            due_date TEXT,
            completed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            title TEXT,
            status TEXT NOT NULL DEFAULT 'idle',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            tool_name TEXT,
            tool_args TEXT,
            tool_calls TEXT,
            tool_call_id TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, created_at);
        CREATE TABLE IF NOT EXISTS goals (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            progress TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_goals_session ON goals (session_id, created_at);
        CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            title TEXT,
            content TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts (session_id, created_at);
        CREATE TABLE IF NOT EXISTS approvals (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            tool_args TEXT,
            tool_call_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            executed INTEGER NOT NULL DEFAULT 0,
            result TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals (session_id, created_at);
    `);

    migrate(_db);

    return _db;
}

export function closeDb() {
    if (_db !== null) {
        _db.close();
        _db = null;
    }
}
