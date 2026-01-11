// HTTP Routes using Hono

import { Hono } from "hono";
import { DatabaseManager, GraphDatabase } from "./db.js";
import { Executor, QueryResponse } from "./executor.js";
import { BackupManager, BackupStatus } from "./backup.js";
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
// Create App
// ============================================================================

export function createApp(
  dbManager: DatabaseManager, 
  dataPath?: string, 
  backupManager?: BackupManager,
  apiKeyStore?: ApiKeyStore
): Hono {
  const app = new Hono();

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

    // Get database for this project
    const db = dbManager.getDatabase(project);

    // Execute query
    const executor = new Executor(db);
    const result = executor.execute(body.cypher, body.params || {});

    if (!result.success) {
      return c.json(result, 400);
    }

    return c.json(result);
  });

  // ============================================================================
  // Admin Endpoints
  // ============================================================================

  app.get("/admin/list", (c) => {
    const projects = dbManager.listDatabases();

    return c.json({
      success: true,
      data: { projects },
    });
  });

  app.post("/admin/projects/:project", (c) => {
    const project = c.req.param("project");

    // Creating a database just by accessing it
    dbManager.getDatabase(project);

    return c.json({
      success: true,
      message: `Created database for ${project}`,
    });
  });

  app.post("/admin/wipe/:project", (c) => {
    const project = c.req.param("project");

    const db = dbManager.getDatabase(project);

    // Clear all data
    db.execute("DELETE FROM edges");
    db.execute("DELETE FROM nodes");

    return c.json({
      success: true,
      message: `Wiped database for ${project}`,
    });
  });

  // ============================================================================
  // Backup Endpoints
  // ============================================================================

  app.get("/admin/backup", (c) => {
    if (!backupManager) {
      return c.json(
        {
          success: false,
          error: { message: "Backup not configured. Set backupPath in server options." },
        },
        400
      );
    }

    const status = backupManager.getBackupStatus();
    return c.json({
      success: true,
      data: status,
    });
  });

  app.post("/admin/backup", async (c) => {
    if (!backupManager || !dataPath) {
      return c.json(
        {
          success: false,
          error: { message: "Backup not configured. Set backupPath in server options." },
        },
        400
      );
    }

    // Get optional project param for single project backup
    const project = c.req.query("project");

    if (project) {
      // Backup single project
      const sourcePath = `${dataPath}/${project}.db`;
      const result = await backupManager.backupDatabase(sourcePath, project);

      if (!result.success) {
        return c.json(
          {
            success: false,
            error: { message: result.error },
          },
          400
        );
      }

      return c.json({
        success: true,
        data: {
          project: result.project,
          backupPath: result.backupPath,
          sizeBytes: result.sizeBytes,
          durationMs: result.durationMs,
        },
      });
    }

    // Backup all databases
    const results = await backupManager.backupAll(dataPath);
    
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return c.json({
      success: failed.length === 0,
      data: {
        total: results.length,
        successful: successful.length,
        failed: failed.length,
        backups: successful.map(r => ({
          project: r.project,
          backupPath: r.backupPath,
          sizeBytes: r.sizeBytes,
          durationMs: r.durationMs,
        })),
        errors: failed.map(r => ({
          project: r.project,
          error: r.error,
        })),
      },
    });
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
  const backupManager = backupPath ? new BackupManager(backupPath) : undefined;
  
  // Set up API key authentication if keys are provided
  let apiKeyStore: ApiKeyStore | undefined;
  if (apiKeys) {
    apiKeyStore = new ApiKeyStore();
    apiKeyStore.loadKeys(apiKeys);
  }

  const app = createApp(dbManager, dataPath, backupManager, apiKeyStore);

  return {
    app,
    dbManager,
    backupManager,
    apiKeyStore,
    port,
    fetch: app.fetch,
  };
}
