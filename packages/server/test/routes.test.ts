import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../src/routes";
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

  describe("POST /query/:env/:project", () => {
    it("executes valid Cypher query", async () => {
      // First create some data
      await request("POST", "/query/test/myproject", {
        cypher: "CREATE (n:Person {name: 'Alice'})",
      });

      // Then query it
      const { status, json } = await request("POST", "/query/test/myproject", {
        cypher: "MATCH (n:Person) RETURN n",
      });

      expect(status).toBe(200);
      expect((json as any).success).toBe(true);
      expect((json as any).data).toHaveLength(1);
    });

    it("returns results with meta", async () => {
      await request("POST", "/query/test/myproject", {
        cypher: "CREATE (n:Person {name: 'Alice'})",
      });

      const { json } = await request("POST", "/query/test/myproject", {
        cypher: "MATCH (n:Person) RETURN n",
      });

      expect((json as any).meta).toBeDefined();
      expect((json as any).meta.count).toBe(1);
      expect((json as any).meta.time_ms).toBeGreaterThanOrEqual(0);
    });

    it("handles query parameters", async () => {
      await request("POST", "/query/test/myproject", {
        cypher: "CREATE (n:Person {name: $name})",
        params: { name: "Bob" },
      });

      const { json } = await request("POST", "/query/test/myproject", {
        cypher: "MATCH (n:Person {name: $name}) RETURN n",
        params: { name: "Bob" },
      });

      expect((json as any).data).toHaveLength(1);
    });

    it("returns 400 for invalid Cypher", async () => {
      const { status, json } = await request("POST", "/query/test/myproject", {
        cypher: "INVALID QUERY",
      });

      expect(status).toBe(400);
      expect((json as any).success).toBe(false);
      expect((json as any).error.message).toBeDefined();
    });

    it("returns 400 for missing body", async () => {
      const req = new Request("http://localhost/query/test/myproject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing cypher field", async () => {
      const { status, json } = await request("POST", "/query/test/myproject", {
        params: {},
      });

      expect(status).toBe(400);
      expect((json as any).error.message).toContain("cypher");
    });

    it("returns 400 for invalid environment", async () => {
      const { status, json } = await request(
        "POST",
        "/query/invalid/myproject",
        {
          cypher: "MATCH (n) RETURN n",
        }
      );

      expect(status).toBe(400);
      expect((json as any).error.message).toContain("environment");
    });

    it("isolates data between projects", async () => {
      await request("POST", "/query/test/project-a", {
        cypher: "CREATE (n:Person {name: 'Alice'})",
      });

      const { json } = await request("POST", "/query/test/project-b", {
        cypher: "MATCH (n:Person) RETURN n",
      });

      expect((json as any).data).toHaveLength(0);
    });

    it("isolates data between environments", async () => {
      await request("POST", "/query/production/myproject", {
        cypher: "CREATE (n:Person {name: 'Prod'})",
      });

      const { json } = await request("POST", "/query/test/myproject", {
        cypher: "MATCH (n:Person) RETURN n",
      });

      expect((json as any).data).toHaveLength(0);
    });

    it("creates project DB on first query", async () => {
      // Query a new project that doesn't exist yet
      const { status, json } = await request("POST", "/query/test/newproject", {
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
      expect((json as any).data.projects).toEqual({});
    });

    it("returns list of active projects", async () => {
      await request("POST", "/query/test/project-a", {
        cypher: "MATCH (n) RETURN n",
      });
      await request("POST", "/query/production/project-b", {
        cypher: "MATCH (n) RETURN n",
      });

      const { json } = await request("GET", "/admin/list");

      expect((json as any).data.projects["project-a"]).toContain("test");
      expect((json as any).data.projects["project-b"]).toContain("production");
    });
  });

  describe("POST /admin/projects/:env/:project", () => {
    it("creates a new project database", async () => {
      const { status, json } = await request(
        "POST",
        "/admin/projects/test/newproject"
      );

      expect(status).toBe(200);
      expect((json as any).success).toBe(true);

      // Verify it's in the list
      const { json: listJson } = await request("GET", "/admin/list");
      expect((listJson as any).data.projects["newproject"]).toContain("test");
    });

    it("returns 400 for invalid environment", async () => {
      const { status, json } = await request(
        "POST",
        "/admin/projects/invalid/newproject"
      );

      expect(status).toBe(400);
    });
  });

  describe("POST /admin/wipe/:project", () => {
    it("wipes test database", async () => {
      // Create some data
      await request("POST", "/query/test/myproject", {
        cypher: "CREATE (n:Person {name: 'Alice'})",
      });

      // Verify data exists
      let result = await request("POST", "/query/test/myproject", {
        cypher: "MATCH (n:Person) RETURN n",
      });
      expect((result.json as any).data).toHaveLength(1);

      // Wipe
      const { status, json } = await request("POST", "/admin/wipe/myproject");
      expect(status).toBe(200);
      expect((json as any).success).toBe(true);

      // Verify data is gone
      result = await request("POST", "/query/test/myproject", {
        cypher: "MATCH (n:Person) RETURN n",
      });
      expect((result.json as any).data).toHaveLength(0);
    });
  });

  describe("Error responses", () => {
    it("returns error with position for parse errors", async () => {
      const { json } = await request("POST", "/query/test/myproject", {
        cypher: "CREATE (n:Person",
      });

      expect((json as any).success).toBe(false);
      expect((json as any).error.position).toBeDefined();
      expect((json as any).error.line).toBeDefined();
      expect((json as any).error.column).toBeDefined();
    });
  });
});
