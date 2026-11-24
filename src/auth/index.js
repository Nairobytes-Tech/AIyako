import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db/database.js';

export const USER_MD_TEMPLATE = `# About you

## Basics
- Name:
- Location:
- Timezone:

## Focus
- Work:
- Life:
- Learning:

## Preferences
- How Kioo should help:
- Tone:
- Things to avoid:
`;

function now() {
    return new Date().toISOString();
}

function expiresIn(ms) {
    return new Date(Date.now() + ms).toISOString();
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

export function hashToken(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const derived = scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
    if (typeof stored !== 'string' || !stored.startsWith('scrypt:')) return false;
    const [, salt, expected] = stored.split(':');
    if (!salt || !expected) return false;
    try {
        const derived = scryptSync(String(password), salt, 64);
        const expectedBuffer = Buffer.from(expected, 'hex');
        return expectedBuffer.length === derived.length && timingSafeEqual(expectedBuffer, derived);
    } catch {
        return false;
    }
}

function mapUser(row) {
    if (!row) return null;
    return {
        id: row.id,
        email: row.email,
        phone: row.phone || null,
        name: row.name,
        created_at: row.created_at,
        status: row.status,
        has_password: Boolean(row.password_hash),
        has_google: Boolean(row.google_id),
    };
}

export function getUserById(userId) {
    return mapUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

export function getUserByEmail(email) {
    return mapUser(getDb().prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)));
}

export function getUserByGoogleId(googleId) {
    if (!googleId) return null;
    return mapUser(getDb().prepare('SELECT * FROM users WHERE google_id = ?').get(String(googleId)));
}

export function createUser({ name, email, phone = null, password = null, googleId = null }) {
    const db = getDb();
    const user = {
        id: randomUUID(),
        email: normalizeEmail(email),
        phone: phone ? String(phone).trim() : null,
        name: String(name || '').trim() || 'Kioo user',
        password_hash: password ? hashPassword(password) : null,
        google_id: googleId ? String(googleId) : null,
        created_at: now(),
        status: 'active',
    };

    db.prepare(
        'INSERT INTO users (id, email, phone, name, password_hash, google_id, created_at, status) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        user.id,
        user.email,
        user.phone,
        user.name,
        user.password_hash,
        user.google_id,
        user.created_at,
        user.status
    );

    saveProfile(user.id, USER_MD_TEMPLATE);
    return getUserById(user.id);
}

export function getPasswordHash(userId) {
    const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    return row ? row.password_hash : null;
}

export function setUserPassword(userId, password) {
    return getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId).changes > 0;
}

export function setGoogleId(userId, googleId) {
    return getDb().prepare('UPDATE users SET google_id = ? WHERE id = ?').run(String(googleId), userId).changes > 0;
}

export function getProfile(userId) {
    const db = getDb();
    let row = db.prepare('SELECT user_md, updated_at FROM profiles WHERE user_id = ?').get(userId);
    if (!row) {
        saveProfile(userId, USER_MD_TEMPLATE);
        row = db.prepare('SELECT user_md, updated_at FROM profiles WHERE user_id = ?').get(userId);
    }
    return row;
}

export function saveProfile(userId, userMd) {
    const timestamp = now();
    getDb().prepare(
        'INSERT INTO profiles (user_id, user_md, updated_at) VALUES (?, ?, ?) '
        + 'ON CONFLICT(user_id) DO UPDATE SET user_md = excluded.user_md, updated_at = excluded.updated_at'
    ).run(userId, String(userMd), timestamp);
    return { user_md: String(userMd), updated_at: timestamp };
}

export function createAuthSession(userId, device, accessTtlMs, refreshTtlMs) {
    const db = getDb();
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const session = {
        id: randomUUID(),
        user_id: userId,
        access_token_hash: hashToken(accessToken),
        refresh_token_hash: hashToken(refreshToken),
        device: device ? String(device).slice(0, 200) : null,
        created_at: now(),
        expires_at: expiresIn(accessTtlMs),
        refresh_expires_at: expiresIn(refreshTtlMs),
    };

    db.prepare(
        'INSERT INTO auth_sessions (id, user_id, access_token_hash, refresh_token_hash, device, '
        + 'expires_at, refresh_expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)'
    ).run(
        session.id,
        session.user_id,
        session.access_token_hash,
        session.refresh_token_hash,
        session.device,
        session.expires_at,
        session.refresh_expires_at,
        session.created_at
    );

    db.prepare('DELETE FROM auth_sessions WHERE refresh_expires_at < ?').run(now());
    return { ...session, accessToken, refreshToken };
}

export function findAuthSessionByToken(token, kind = 'access') {
    const column = kind === 'refresh' ? 'refresh_token_hash' : 'access_token_hash';
    if (!token) return null;
    const row = getDb().prepare(
        `SELECT * FROM auth_sessions WHERE ${column} = ? AND revoked_at IS NULL`
    ).get(hashToken(token));
    if (!row) return null;
    const expiry = kind === 'refresh' ? row.refresh_expires_at : row.expires_at;
    if (Date.parse(expiry) <= Date.now()) return null;
    return row;
}

export function rotateAuthSession(session, device, accessTtlMs, refreshTtlMs) {
    getDb().prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), session.id);
    return createAuthSession(session.user_id, device || session.device, accessTtlMs, refreshTtlMs);
}

export function revokeAuthSession(sessionId) {
    if (!sessionId) return false;
    return getDb().prepare(
        'UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
    ).run(now(), sessionId).changes > 0;
}

export function revokeAllUserSessions(userId) {
    return getDb().prepare(
        'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
    ).run(now(), userId).changes;
}

export function createPasswordReset(userId, ttlMs) {
    const db = getDb();
    const token = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(userId, now());
    db.prepare(
        'INSERT INTO password_resets (token_hash, user_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)'
    ).run(hashToken(token), userId, expiresIn(ttlMs), now());
    return token;
}

export function consumePasswordReset(token) {
    if (!token) return null;
    const db = getDb();
    const row = db.prepare(
        'SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?'
    ).get(hashToken(token), now());
    if (!row) return null;
    db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
    return row.user_id;
}

export function deleteAccount(userId) {
    const db = getDb();
    const sessionIds = db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(userId).map(row => row.id);
    for (const sessionId of sessionIds) {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM goals WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM approvals WHERE session_id = ?').run(sessionId);
    }
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM profiles WHERE user_id = ?').run(userId);
    return db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes > 0;
}
