import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { LeanGraph } from "../src";

describe("MERGE with SET bug", () => {
  let db: Awaited<ReturnType<typeof LeanGraph>>;

  beforeAll(async () => {
    db = await LeanGraph({ project: "nicefox-recettes-test", mode: "test" });
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    // Clean up before each test
    await db.execute("MATCH (u:User) DETACH DELETE u");
  });

  it("should persist properties with MERGE + SET", async () => {
    // Test MERGE with full SET
    await db.execute("MERGE (u:User {id: $id}) SET u.email = $email, u.name = $name, u.role = $role", {
      id: "test-user",
      email: "test@example.com",
      name: "Test User",
      role: "user"
    });

    // Query all properties
    const result = await db.query("MATCH (u:User {id: $id}) RETURN u.id, u.email, u.name, u.role", {
      id: "test-user"
    });

    expect(result).toHaveLength(1);
    expect(result[0]["u.id"]).toBe("test-user");
    expect(result[0]["u.email"]).toBe("test@example.com");
    expect(result[0]["u.name"]).toBe("Test User");
    expect(result[0]["u.role"]).toBe("user");
  });
});
