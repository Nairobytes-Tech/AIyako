# AIyako Auth + Profile

## Product rules

- The app is gated: agent APIs require a signed-in user when `KIOO_AUTH_ENABLED=1`.
- One account per email; the same account works across web and APK clients.
- `user.md` belongs to the account, not the device.
- Users can view and edit `user.md` from Profile.
- Sessions are server-side and revoked on logout, reset, or account deletion.

## Supported flows

- Email/password register and sign in.
- Google Sign-In when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
- Forgot/reset password.
- Refresh-token rotation on 401.
- Logout and account deletion.
- Phone OTP is intentionally deferred.

## Session model

- Access token: opaque, short-lived, stored as an httpOnly cookie.
- Refresh token: opaque, long-lived, stored as an httpOnly cookie.
- On app open, the UI checks `/auth/me`; on 401 it calls `/auth/refresh` once.
- Every agent request carries the authenticated `user_id`.
- Every chat turn loads that user's `user.md` and injects it into agent context.

For local development, `KIOO_DEV_RESET_TOKENS=1` returns the reset link in the
forgot-password response because no SMTP provider is configured. Set it to `0`
outside local development.

## Data

- `users`: `id`, `email`, `phone`, `name`, `password_hash`, `google_id`, `created_at`, `status`.
- `auth_sessions`: `id`, `user_id`, token hashes, device, expiry, revocation.
- `profiles`: `user_id`, `user_md`, `updated_at`.
- `password_resets`: token hash, user, expiry, usage timestamp.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/auth/config` | Auth provider availability |
| `POST` | `/auth/register` | Create account + session |
| `POST` | `/auth/login` | Sign in |
| `POST` | `/auth/refresh` | Rotate session tokens |
| `POST` | `/auth/logout` | Revoke session |
| `POST` | `/auth/forgot` | Issue reset token |
| `POST` | `/auth/reset` | Replace password + revoke sessions |
| `GET` | `/auth/google` | Start Google OAuth |
| `GET` | `/auth/google/callback` | Complete Google OAuth |
| `DELETE` | `/auth/account` | Delete account and data |
| `GET` / `PUT` | `/profile` | View/edit `user.md` |
