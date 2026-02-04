// HTTP Routes using Hono

import { Hono } from "hono";
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
// Create App
// ============================================================================

export function createApp(
  dbManager: DatabaseManager,
  apiKeyStore?: ApiKeyStore
): Hono {
  const app = new Hono();

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
