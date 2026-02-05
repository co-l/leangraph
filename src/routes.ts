// HTTP Routes using Hono

import { Hono, Context } from "hono";
import { cors } from "hono/cors";
import { DatabaseManager, GraphDatabase } from "./db.js";
import { Executor, QueryResponse } from "./executor.js";
import { ApiKeyStore, authMiddleware } from "./auth.js";

// ============================================================================
// Types
// ============================================================================

export interface QueryRequest {
  cypher: string;
  params?: Record<string, unknown>;
}

export interface AppContext {
  dbManager: DatabaseManager;
}

// ============================================================================
// Security: CORS Configuration
// ============================================================================

/**
 * Default CORS configuration - restrictive by default.
 * In production, configure with specific allowed origins.
 */
const DEFAULT_CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS?.split(",") || [DEFAULT_CORS_ORIGIN];

// ============================================================================
// Security: Project Name Validation
// ============================================================================

/**
 * Validate a project name to prevent path traversal and other attacks.
 * Only allows alphanumeric characters, hyphens, underscores, and dots (not leading).
 */
const PROJECT_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_PROJECT_NAME_LENGTH = 64;

function isValidProjectName(name: string): boolean {
  if (!name || name.length > MAX_PROJECT_NAME_LENGTH) return false;
  if (!PROJECT_NAME_REGEX.test(name)) return false;
  // Reject names that could be path traversal even if regex passes
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return false;
  return true;
}

// ============================================================================
// Security: Rate Limiting
// ============================================================================

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX || "10000", 10); // per minute
const RATE_LIMIT_MAX_ENTRIES = 100_000; // Maximum tracked IPs to prevent memory exhaustion
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60_000; // Cleanup every 5 minutes

// Periodic cleanup of expired rate limit entries to prevent memory exhaustion
// from distributed attacks using many unique IPs.
let rateLimitCleanupTimer: ReturnType<typeof setInterval> | null = null;

function startRateLimitCleanup(): void {
  if (rateLimitCleanupTimer) return;
  rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
      if (now > entry.resetTime) {
        rateLimitMap.delete(key);
      }
    }
  }, RATE_LIMIT_CLEANUP_INTERVAL_MS);
  // Allow the process to exit even if the timer is running
  if (rateLimitCleanupTimer && typeof rateLimitCleanupTimer === "object" && "unref" in rateLimitCleanupTimer) {
    rateLimitCleanupTimer.unref();
  }
}

function checkRateLimit(identifier: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(identifier);

  if (!entry || now > entry.resetTime) {
    // Prevent unbounded growth: if the map is too large, reject new entries
    if (!entry && rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
      // Evict expired entries first
      for (const [key, e] of rateLimitMap) {
        if (now > e.resetTime) rateLimitMap.delete(key);
      }
      // If still at capacity after cleanup, reject to prevent memory exhaustion
      if (rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
        return { allowed: false, retryAfter: 60 };
      }
    }
    // New window
    rateLimitMap.set(identifier, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
  }

  entry.count++;
  return { allowed: true };
}

/**
 * Trust proxy headers only when TRUST_PROXY env var is set.
 * Without a trusted proxy, X-Forwarded-For can be spoofed to bypass rate limits.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1";

function getClientIdentifier(c: Context): string {
  if (TRUST_PROXY) {
    // Only trust proxy headers when explicitly configured
    const forwardedFor = c.req.header("X-Forwarded-For");
    if (forwardedFor) {
      return forwardedFor.split(",")[0].trim();
    }
    const realIp = c.req.header("X-Real-Ip");
    if (realIp) return realIp;
  }
  // Default: use remote address from the connection
  // Hono provides this via c.env or the underlying request
  const connInfo = c.req.raw;
  // @ts-ignore - Node.js socket info
  const remoteAddr = connInfo?.socket?.remoteAddress;
  return remoteAddr || "unknown";
}

// ============================================================================
// Create App
// ============================================================================

export function createApp(
  dbManager: DatabaseManager,
  apiKeyStore?: ApiKeyStore
): Hono {
  const app = new Hono();

  // CORS middleware - must be before other middleware
  app.use("*", cors({
    origin: (origin) => {
      // Requests with no origin (curl, server-to-server) get no CORS header
      // This prevents browsers from caching a wildcard Access-Control-Allow-Origin
      if (!origin) return DEFAULT_CORS_ORIGIN;
      // Check if origin is in allowed list
      if (ALLOWED_ORIGINS.includes(origin)) return origin;
      // Default: deny
      return null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400, // 24 hours
  }));

  // Start rate limit cleanup timer
  startRateLimitCleanup();

  // Security headers middleware
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("X-XSS-Protection", "0"); // Disabled in favor of CSP; legacy header can cause issues
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // HSTS: Instruct browsers to always use HTTPS (1 year, include subdomains)
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  });

  // Add auth middleware if API key store is provided
  if (apiKeyStore && apiKeyStore.hasKeys()) {
    app.use("*", authMiddleware(apiKeyStore));
  }

  // ============================================================================
  // Health Check
  // ============================================================================

  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ============================================================================
  // Query Endpoint
  // ============================================================================

  app.post("/query/:project", async (c) => {
    // Rate limiting check
    const clientId = getClientIdentifier(c);
    const rateLimit = checkRateLimit(clientId);
    if (!rateLimit.allowed) {
      c.header("Retry-After", String(rateLimit.retryAfter));
      return c.json(
        {
          success: false,
          error: { message: "Rate limit exceeded. Please try again later." },
        },
        429
      );
    }

    // Content-Type validation
    const contentType = c.req.header("Content-Type");
    if (!contentType || !contentType.includes("application/json")) {
      return c.json(
        {
          success: false,
          error: { message: "Content-Type must be application/json" },
        },
        415
      );
    }

    const project = c.req.param("project");

    // Validate project name to prevent path traversal
    if (!isValidProjectName(project)) {
      return c.json(
        {
          success: false,
          error: { message: "Invalid project name" },
        },
        400
      );
    }

    // Parse request body
    let body: QueryRequest;
    try {
      body = await c.req.json<QueryRequest>();
    } catch (e) {
      return c.json(
        {
          success: false,
          error: { message: "Invalid JSON body" },
        },
        400
      );
    }

    // Validate request
    if (!body.cypher || typeof body.cypher !== "string") {
      return c.json(
        {
          success: false,
          error: { message: "Missing or invalid 'cypher' field" },
        },
        400
      );
    }

    // Limit query size to prevent stack overflow / resource exhaustion
    const MAX_QUERY_LENGTH = 100_000;
    if (body.cypher.length > MAX_QUERY_LENGTH) {
      return c.json(
        {
          success: false,
          error: { message: `Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters` },
        },
        400
      );
    }

    // Get database for this project
    const db = dbManager.getDatabase(project);

    // Execute query
    const executor = new Executor(db);
    const result = executor.execute(body.cypher, body.params || {});

    if (!result.success) {
      // Sanitize internal error messages to prevent information disclosure
      const safeMessage = result.error.message
        .replace(/Maximum call stack size exceeded/g, "Query too complex or deeply nested")
        .replace(/SQLITE_ERROR: /g, "")
        .replace(/at .+\(.+\)/g, ""); // Strip stack trace fragments
      return c.json({
        success: false,
        error: {
          message: safeMessage,
          ...(result.error.position !== undefined && { position: result.error.position }),
          ...(result.error.line !== undefined && { line: result.error.line }),
          ...(result.error.column !== undefined && { column: result.error.column }),
        },
      }, 400);
    }

    return c.json(result);
  });

  return app;
}

// ============================================================================
// Server Factory
// ============================================================================

export interface ServerOptions {
  port?: number;
  dataPath?: string;
  backupPath?: string;
  apiKeys?: Record<string, { project?: string; admin?: boolean }>;
}

export function createServer(options: ServerOptions = {}) {
  const { port = 3000, dataPath = ":memory:", backupPath, apiKeys } = options;

  const dbManager = new DatabaseManager(dataPath);

  // Set up API key authentication if keys are provided
  let apiKeyStore: ApiKeyStore | undefined;
  if (apiKeys) {
    apiKeyStore = new ApiKeyStore();
    apiKeyStore.loadKeys(apiKeys);
  }

  const app = createApp(dbManager, apiKeyStore);

  return {
    app,
    dbManager,
    apiKeyStore,
    port,
    fetch: app.fetch,
  };
}
