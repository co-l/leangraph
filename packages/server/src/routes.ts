// HTTP Routes using Hono

import { Hono } from "hono";
import { DatabaseManager, GraphDatabase } from "./db";
import { Executor, QueryResponse } from "./executor";

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

export function createApp(dbManager: DatabaseManager): Hono {
  const app = new Hono();

  // ============================================================================
  // Health Check
  // ============================================================================

  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ============================================================================
  // Query Endpoint
  // ============================================================================

  app.post("/query/:env/:project", async (c) => {
    const env = c.req.param("env");
    const project = c.req.param("project");

    // Validate environment
    if (env !== "production" && env !== "test") {
      return c.json(
        {
          success: false,
          error: {
            message: `Invalid environment: ${env}. Must be 'production' or 'test'`,
          },
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

    // Get database for this project/env
    const db = dbManager.getDatabase(project, env);

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
    const databases = dbManager.listDatabases();
    const projects: Record<string, string[]> = {};

    for (const key of databases) {
      const [env, project] = key.split("/");
      if (!projects[project]) {
        projects[project] = [];
      }
      projects[project].push(env);
    }

    return c.json({
      success: true,
      data: { projects },
    });
  });

  app.post("/admin/projects/:env/:project", (c) => {
    const env = c.req.param("env");
    const project = c.req.param("project");

    if (env !== "production" && env !== "test") {
      return c.json(
        {
          success: false,
          error: { message: `Invalid environment: ${env}` },
        },
        400
      );
    }

    // Creating a database just by accessing it
    dbManager.getDatabase(project, env);

    return c.json({
      success: true,
      message: `Created database for ${project} in ${env}`,
    });
  });

  app.post("/admin/wipe/:project", (c) => {
    const project = c.req.param("project");

    // Only allow wiping test databases
    const db = dbManager.getDatabase(project, "test");

    // Clear all data
    db.execute("DELETE FROM edges");
    db.execute("DELETE FROM nodes");

    return c.json({
      success: true,
      message: `Wiped test database for ${project}`,
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
}

export function createServer(options: ServerOptions = {}) {
  const { port = 3000, dataPath = ":memory:" } = options;

  const dbManager = new DatabaseManager(dataPath);
  const app = createApp(dbManager);

  return {
    app,
    dbManager,
    port,
    fetch: app.fetch,
  };
}
