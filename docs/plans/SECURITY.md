# Security Manual Fix Plan

Remaining items from the security assessment of `https://leangraph.io` (Feb 2026).
Automated fixes (maxHops cap, SQL LIMIT guard, rate limiter hardening, HSTS on API) were applied in commit `8e20f0f`.

---

## 1. nginx: Fix Host Header Injection

**Severity:** MEDIUM

The default server block accepts any `Host` header and uses it in redirects (`Location: https://evil.com/...`).

Add a catch-all default server that rejects unknown hosts:

```nginx
server {
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    return 444;
}

server {
    listen 80 default_server;
    server_name _;
    return 444;
}
```

Ensure the real site block has an explicit `server_name leangraph.io;`.

## 2. nginx: Add Security Headers to Static Files

**Severity:** LOW

Static files served by nginx are missing CSP, Permissions-Policy, and HSTS. Add to the site server block:

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
```

## 3. nginx: Remove Duplicate Headers on Proxied Paths

**Severity:** LOW

API responses get conflicting headers from both nginx and Hono (e.g. `X-Frame-Options: SAMEORIGIN` vs `DENY`). Hide nginx's copies for proxied paths:

```nginx
location ~ ^/(health|api/health|query) {
    proxy_pass http://127.0.0.1:3000;
    proxy_hide_header X-Frame-Options;
    proxy_hide_header X-XSS-Protection;
    proxy_hide_header X-Content-Type-Options;
    proxy_hide_header Referrer-Policy;
}
```

## 4. Application: Add Query Execution Timeout

**Severity:** HIGH

`better-sqlite3` runs synchronously, so a single expensive query blocks the entire event loop.

**Option A** (quick): Set `proxy_read_timeout 10s` in nginx. Combined with the maxHops cap and SQL LIMIT already in place, this bounds the worst-case client wait.

**Option B** (thorough): Move query execution to a `worker_threads` thread. Use `setTimeout` + `db.interrupt()` to kill queries exceeding a time budget.

## 5. Application: Harden Regex Engine

**Severity:** MEDIUM

The `cypher_regex` function (`src/db.ts:607`) uses JavaScript's `RegExp`, which is vulnerable to catastrophic backtracking despite the nested-quantifier heuristic. Replace with RE2:

```bash
npm install re2-wasm
```

Then swap `new RegExp(pattern, flags)` for the RE2 equivalent in `src/db.ts`. This guarantees linear-time matching and eliminates all ReDoS risk from the `=~` operator.

## 6. SSH: Disable Password Authentication

**Severity:** INFO

In `/etc/ssh/sshd_config`:

```
PasswordAuthentication no
```

Then `systemctl restart sshd`.
