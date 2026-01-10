import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp, createServer } from "../src/routes";
import { DatabaseManager } from "../src/db";
import { BackupManager } from "../src/backup";
import * as fs from "fs";
import * as path from "path";

describe("HTTP Routes", () => {
  let dbManager: DatabaseManager;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    app = createApp(dbManager);
  });

  afterEach(() => {
    dbManager.closeAll();
  });

  // Helper to make requests
  async function request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; json: unknown }> {
    const req = new Request(`http://localhost${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    const res = await app.fetch(req);
    const json = await res.json();
    return { status: res.status, json };
  }

  describe("GET /health", () => {
    it("returns 200 OK", async () => {
      const { status, json } = await request("GET", "/health");

      expect(status).toBe(200);
      expect(json).toMatchObject({ status: "ok" });
    });

    it("includes timestamp", async () => {
      const { json } = await request("GET", "/health");

      expect((json as any).timestamp).toBeDefined();
    });
  });

  describe("POST /query/:project", () => {
    it("executes valid Cypher query", async () => {
      // First create some data
      await request("POST", "/query/myproject", {
        cypher: "CREATE (n:Person {name: 'Alice'})",
      });

      // Then query it
      const { status, json } = await request("POST", "/query/myproject", {
        cypher: "MATCH (n:Person) RETURN n",
      });

      expect(status).toBe(200);
      expect((json as any).success).toBe(true);
      expect((json as any).data).toHaveLength(1);
    });

    it("returns results with meta", async () => {
      await request("POST", "/query/myproject", {
        cypher: "CREATE (n:Person {name: 'Alice'})",
      });

      const { json } = await request("POST", "/query/myproject", {
        cypher: "MATCH (n:Person) RETURN n",
      });

      expect((json as any).meta).toBeDefined();
      expect((json as any).meta.count).toBe(1);
      expect((json as any).meta.time_ms).toBeGreaterThanOrEqual(0);
    });

    it("handles query parameters", async () => {
      await request("POST", "/query/myproject", {
        cypher: "CREATE (n:Person {name: $name})",
        params: { name: "Bob" },
      });

      const { json } = await request("POST", "/query/myproject", {
        cypher: "MATCH (n:Person {name: $name}) RETURN n",
        params: { name: "Bob" },
      });

      expect((json as any).data).toHaveLength(1);
    });

    it("returns 400 for invalid Cypher", async () => {
      const { status, json } = await request("POST", "/query/myproject", {
        cypher: "INVALID QUERY",
      });

      expect(status).toBe(400);
      expect((json as any).success).toBe(false);
      expect((json as any).error.message).toBeDefined();
    });

    it("returns 400 for missing body", async () => {
      const req = new Request("http://localhost/query/myproject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing cypher field", async () => {
      const { status, json } = await request("POST", "/query/myproject", {
        params: {},
      });

      expect(status).toBe(400);
      expect((json as any).error.message).toContain("cypher");
    });

    it("isolates data between projects", async () => {
      await request("POST", "/query/project-a", {
        cypher: "CREATE (n:Person {name: 'Alice'})",
      });

      const { json } = await request("POST", "/query/project-b", {
        cypher: "MATCH (n:Person) RETURN n",
      });

      expect((json as any).data).toHaveLength(0);
    });

    it("creates project DB on first query", async () => {
      // Query a new project that doesn't exist yet
      const { status, json } = await request("POST", "/query/newproject", {
        cypher: "MATCH (n:Person) RETURN n",
      });

      expect(status).toBe(200);
      expect((json as any).data).toHaveLength(0);
    });
  });

  describe("GET /admin/list", () => {
    it("returns empty list initially", async () => {
      const { status, json } = await request("GET", "/admin/list");

      expect(status).toBe(200);
      expect((json as any).success).toBe(true);
      expect((json as any).data.projects).toEqual([]);
    });

    it("returns list of active projects", async () => {
      await request("POST", "/query/project-a", {
        cypher: "MATCH (n) RETURN n",
      });
      await request("POST", "/query/project-b", {
        cypher: "MATCH (n) RETURN n",
      });

      const { json } = await request("GET", "/admin/list");

      expect((json as any).data.projects).toContain("project-a");
      expect((json as any).data.projects).toContain("project-b");
    });
  });

  describe("POST /admin/projects/:project", () => {
    it("creates a new project database", async () => {
      const { status, json } = await request(
        "POST",
        "/admin/projects/newproject"
      );

      expect(status).toBe(200);
      expect((json as any).success).toBe(true);

      // Verify it's in the list
      const { json: listJson } = await request("GET", "/admin/list");
      expect((listJson as any).data.projects).toContain("newproject");
    });
  });

  describe("POST /admin/wipe/:project", () => {
    it("wipes database", async () => {
      // Create some data
      await request("POST", "/query/myproject", {
        cypher: "CREATE (n:Person {name: 'Alice'})",
      });

      // Verify data exists
      let result = await request("POST", "/query/myproject", {
        cypher: "MATCH (n:Person) RETURN n",
      });
      expect((result.json as any).data).toHaveLength(1);

      // Wipe
      const { status, json } = await request("POST", "/admin/wipe/myproject");
      expect(status).toBe(200);
      expect((json as any).success).toBe(true);

      // Verify data is gone
      result = await request("POST", "/query/myproject", {
        cypher: "MATCH (n:Person) RETURN n",
      });
      expect((result.json as any).data).toHaveLength(0);
    });
  });

  describe("Error responses", () => {
    it("returns error with position for parse errors", async () => {
      const { json } = await request("POST", "/query/myproject", {
        cypher: "CREATE (n:Person",
      });

      expect((json as any).success).toBe(false);
      expect((json as any).error.position).toBeDefined();
      expect((json as any).error.line).toBeDefined();
      expect((json as any).error.column).toBeDefined();
    });
  });
});

describe("Backup Routes", () => {
  const testDir = path.join(process.cwd(), "test-routes-backup-data");
  const dataPath = path.join(testDir, "data");
  const backupPath = path.join(testDir, "backups");

  let dbManager: DatabaseManager;
  let backupManager: BackupManager;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    // Create test directories
    fs.mkdirSync(dataPath, { recursive: true });
    fs.mkdirSync(backupPath, { recursive: true });

    dbManager = new DatabaseManager(dataPath);
    backupManager = new BackupManager(backupPath);
    app = createApp(dbManager, dataPath, backupManager);
  });

  afterEach(() => {
    dbManager.closeAll();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; json: unknown }> {
    const req = new Request(`http://localhost${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    const res = await app.fetch(req);
    const json = await res.json();
    return { status: res.status, json };
  }

  describe("GET /admin/backup", () => {
    it("returns backup status", async () => {
      const { status, json } = await request("GET", "/admin/backup");

      expect(status).toBe(200);
      expect((json as any).success).toBe(true);
      expect((json as any).data.totalBackups).toBe(0);
    });

    it("returns 400 when backup not configured", async () => {
      const noBackupApp = createApp(dbManager, dataPath, undefined);
      const req = new Request("http://localhost/admin/backup", { method: "GET" });
      const res = await noBackupApp.fetch(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect((json as any).error.message).toContain("not configured");
    });
  });

  describe("POST /admin/backup", () => {
    it("backs up a single project", async () => {
      // Create a database with data
      const db = dbManager.getDatabase("myproject");
      db.insertNode("n1", "Person", { name: "Alice" });

      const { status, json } = await request("POST", "/admin/backup?project=myproject");

      expect(status).toBe(200);
      expect((json as any).success).toBe(true);
      expect((json as any).data.project).toBe("myproject");
      expect((json as any).data.backupPath).toBeDefined();
      expect((json as any).data.sizeBytes).toBeGreaterThan(0);
    });

    it("returns error for non-existent project", async () => {
      const { status, json } = await request("POST", "/admin/backup?project=nonexistent");

      expect(status).toBe(400);
      expect((json as any).success).toBe(false);
      expect((json as any).error.message).toContain("not found");
    });

    it("backs up all databases", async () => {
      // Create multiple databases
      const db1 = dbManager.getDatabase("project1");
      db1.insertNode("n1", "Test", {});
      const db2 = dbManager.getDatabase("project2");
      db2.insertNode("n2", "Test", {});

      const { status, json } = await request("POST", "/admin/backup");

      expect(status).toBe(200);
      expect((json as any).success).toBe(true);
      expect((json as any).data.total).toBe(2);
      expect((json as any).data.successful).toBe(2);
      expect((json as any).data.failed).toBe(0);
      expect((json as any).data.backups).toHaveLength(2);
    });

    it("returns 400 when backup not configured", async () => {
      const noBackupApp = createApp(dbManager, dataPath, undefined);
      const req = new Request("http://localhost/admin/backup", { method: "POST" });
      const res = await noBackupApp.fetch(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect((json as any).error.message).toContain("not configured");
    });
  });
});

describe("API Key Authentication", () => {
  it("enforces authentication when API keys are configured", async () => {
    const server = createServer({
      dataPath: ":memory:",
      apiKeys: {
        "test-api-key": { project: "myproject" },
      },
    });

    // Request to query endpoint without API key should fail
    const reqWithoutKey = new Request("http://localhost/query/myproject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cypher: "MATCH (n) RETURN n" }),
    });
    const resWithoutKey = await server.app.fetch(reqWithoutKey);
    expect(resWithoutKey.status).toBe(401);

    // Request with valid API key should succeed
    const reqWithKey = new Request("http://localhost/query/myproject", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-api-key",
      },
      body: JSON.stringify({ cypher: "MATCH (n) RETURN n" }),
    });
    const resWithKey = await server.app.fetch(reqWithKey);
    expect(resWithKey.status).toBe(200);

    server.dbManager.closeAll();
  });

  it("allows all requests when no API keys are configured", async () => {
    const server = createServer({ dataPath: ":memory:" });

    const req = new Request("http://localhost/query/myproject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cypher: "MATCH (n) RETURN n" }),
    });
    const res = await server.app.fetch(req);

    expect(res.status).toBe(200);

    server.dbManager.closeAll();
  });

  it("skips authentication for health endpoint", async () => {
    const server = createServer({
      dataPath: ":memory:",
      apiKeys: {
        "test-api-key": { admin: true },
      },
    });

    // Health endpoint should work without auth
    const req = new Request("http://localhost/health", { method: "GET" });
    const res = await server.app.fetch(req);

    expect(res.status).toBe(200);

    server.dbManager.closeAll();
  });
});
