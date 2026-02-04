import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp, createServer } from "../src/routes";
import { DatabaseManager } from "../src/db";

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
