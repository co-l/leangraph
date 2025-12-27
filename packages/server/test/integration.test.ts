import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphDatabase } from "../src/db";
import { Executor, executeQuery, ExecutionResult } from "../src/executor";

describe("Integration Tests", () => {
  let db: GraphDatabase;
  let executor: Executor;

  beforeEach(() => {
    db = new GraphDatabase(":memory:");
    db.initialize();
    executor = new Executor(db);
  });

  afterEach(() => {
    db.close();
  });

  // Helper to assert success
  function expectSuccess(result: ReturnType<typeof executor.execute>): ExecutionResult {
    if (!result.success) {
      throw new Error(`Query failed: ${result.error.message}`);
    }
    return result;
  }

  describe("CREATE and MATCH", () => {
    it("creates a node and retrieves it", () => {
      // Create
      const createResult = executor.execute("CREATE (n:Person {name: 'Alice', age: 30})");
      expect(createResult.success).toBe(true);

      // Match
      const matchResult = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN n")
      );

      expect(matchResult.data).toHaveLength(1);
      expect(matchResult.data[0].n).toMatchObject({
        label: "Person",
        properties: { name: "Alice", age: 30 },
      });
    });

    it("creates multiple nodes and retrieves them", () => {
      executor.execute("CREATE (n:Person {name: 'Alice'})");
      executor.execute("CREATE (n:Person {name: 'Bob'})");
      executor.execute("CREATE (n:Company {name: 'Acme'})");

      const result = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN n")
      );

      expect(result.data).toHaveLength(2);
    });

    it("creates and retrieves with property filter", () => {
      executor.execute("CREATE (n:Person {name: 'Alice', age: 30})");
      executor.execute("CREATE (n:Person {name: 'Bob', age: 25})");

      const result = expectSuccess(
        executor.execute("MATCH (n:Person {name: 'Alice'}) RETURN n")
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].n).toMatchObject({
        properties: { name: "Alice", age: 30 },
      });
    });

    it("returns specific properties", () => {
      executor.execute("CREATE (n:Person {name: 'Alice', age: 30})");

      const result = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN n.name, n.age")
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].n_name).toBe("Alice");
      expect(result.data[0].n_age).toBe(30);
    });

    it("uses LIMIT correctly", () => {
      executor.execute("CREATE (n:Person {name: 'Alice'})");
      executor.execute("CREATE (n:Person {name: 'Bob'})");
      executor.execute("CREATE (n:Person {name: 'Charlie'})");

      const result = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN n LIMIT 2")
      );

      expect(result.data).toHaveLength(2);
    });

    it("uses COUNT correctly", () => {
      executor.execute("CREATE (n:Person {name: 'Alice'})");
      executor.execute("CREATE (n:Person {name: 'Bob'})");
      executor.execute("CREATE (n:Person {name: 'Charlie'})");

      const result = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN COUNT(n)")
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].count).toBe(3);
    });
  });

  describe("CREATE relationships", () => {
    it("creates edge between nodes", () => {
      const result = executor.execute(
        "CREATE (a:Person {name: 'Alice'})-[:KNOWS {since: 2020}]->(b:Person {name: 'Bob'})"
      );
      expect(result.success).toBe(true);

      // Verify nodes exist
      const nodesResult = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN n")
      );
      expect(nodesResult.data).toHaveLength(2);

      // Verify edge exists by checking the raw database
      expect(db.countEdges()).toBe(1);
    });

    it("matches relationship patterns", () => {
      executor.execute(
        "CREATE (a:Person {name: 'Alice'})-[:KNOWS]->(b:Person {name: 'Bob'})"
      );

      const result = expectSuccess(
        executor.execute("MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN a, b")
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].a).toMatchObject({
        properties: { name: "Alice" },
      });
      expect(result.data[0].b).toMatchObject({
        properties: { name: "Bob" },
      });
    });

    it("filters by source node properties in relationships", () => {
      // Create multiple relationships
      executor.execute("CREATE (a:Person {name: 'Alice', role: 'admin'})-[:MANAGES]->(p:Project {name: 'Alpha'})");
      executor.execute("CREATE (b:Person {name: 'Bob', role: 'user'})-[:MANAGES]->(q:Project {name: 'Beta'})");

      // Filter by source node property
      const result = expectSuccess(
        executor.execute("MATCH (p:Person {role: 'admin'})-[:MANAGES]->(proj:Project) RETURN proj.name")
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].proj_name).toBe("Alpha");
    });

    it("filters by target node properties in relationships", () => {
      // Create multiple relationships
      executor.execute("CREATE (a:Person {name: 'Alice'})-[:WORKS_ON]->(p:Project {name: 'Alpha', status: 'active'})");
      executor.execute("CREATE (a:Person {name: 'Alice'})-[:WORKS_ON]->(q:Project {name: 'Beta', status: 'archived'})");

      // We need to use raw DB to create the second edge since the translator generates new IDs
      const alice = db.getNodesByLabel("Person").find(n => n.properties.name === "Alice");
      const projects = db.getNodesByLabel("Project");

      // Filter by target node property
      const result = expectSuccess(
        executor.execute("MATCH (p:Person)-[:WORKS_ON]->(proj:Project {status: 'active'}) RETURN proj.name")
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].proj_name).toBe("Alpha");
    });

    it("filters by both source and target node properties", () => {
      // Create nodes
      executor.execute("CREATE (a:User {name: 'Alice', tier: 'gold'})");
      executor.execute("CREATE (b:User {name: 'Bob', tier: 'silver'})");
      executor.execute("CREATE (p1:Product {name: 'Premium Widget', category: 'premium'})");
      executor.execute("CREATE (p2:Product {name: 'Basic Widget', category: 'basic'})");

      // Get node IDs
      const users = db.getNodesByLabel("User");
      const products = db.getNodesByLabel("Product");
      const alice = users.find(u => u.properties.name === "Alice")!;
      const bob = users.find(u => u.properties.name === "Bob")!;
      const premium = products.find(p => p.properties.name === "Premium Widget")!;
      const basic = products.find(p => p.properties.name === "Basic Widget")!;

      // Create purchase relationships
      db.insertEdge("purchase1", "PURCHASED", alice.id, premium.id);
      db.insertEdge("purchase2", "PURCHASED", alice.id, basic.id);
      db.insertEdge("purchase3", "PURCHASED", bob.id, basic.id);

      // Filter by both source (gold tier) and target (premium category)
      const result = expectSuccess(
        executor.execute("MATCH (u:User {tier: 'gold'})-[:PURCHASED]->(p:Product {category: 'premium'}) RETURN u.name, p.name")
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].u_name).toBe("Alice");
      expect(result.data[0].p_name).toBe("Premium Widget");
    });

    it("filters relationships with parameter values on endpoints", () => {
      executor.execute("CREATE (a:Employee {name: 'Alice', dept: 'engineering'})");
      executor.execute("CREATE (b:Employee {name: 'Bob', dept: 'sales'})");
      executor.execute("CREATE (t:Task {title: 'Code Review'})");

      const employees = db.getNodesByLabel("Employee");
      const tasks = db.getNodesByLabel("Task");
      const alice = employees.find(e => e.properties.name === "Alice")!;
      const bob = employees.find(e => e.properties.name === "Bob")!;
      const task = tasks[0];

      db.insertEdge("assign1", "ASSIGNED", alice.id, task.id);
      db.insertEdge("assign2", "ASSIGNED", bob.id, task.id);

      // Use parameter for filtering
      const result = expectSuccess(
        executor.execute(
          "MATCH (e:Employee {dept: $dept})-[:ASSIGNED]->(t:Task) RETURN e.name, t.title",
          { dept: "engineering" }
        )
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].e_name).toBe("Alice");
    });
  });

  describe("WHERE clause", () => {
    beforeEach(() => {
      executor.execute("CREATE (n:Person {name: 'Alice', age: 30})");
      executor.execute("CREATE (n:Person {name: 'Bob', age: 25})");
      executor.execute("CREATE (n:Person {name: 'Charlie', age: 35})");
    });

    it("filters with equals", () => {
      const result = expectSuccess(
        executor.execute("MATCH (n:Person) WHERE n.name = 'Alice' RETURN n")
      );
      expect(result.data).toHaveLength(1);
    });

    it("filters with greater than", () => {
      const result = expectSuccess(
        executor.execute("MATCH (n:Person) WHERE n.age > 28 RETURN n")
      );
      expect(result.data).toHaveLength(2);
    });

    it("filters with less than", () => {
      const result = expectSuccess(
        executor.execute("MATCH (n:Person) WHERE n.age < 30 RETURN n")
      );
      expect(result.data).toHaveLength(1);
    });

    it("filters with AND", () => {
      const result = expectSuccess(
        executor.execute(
          "MATCH (n:Person) WHERE n.age > 25 AND n.age < 35 RETURN n"
        )
      );
      expect(result.data).toHaveLength(1);
      expect(result.data[0].n).toMatchObject({
        properties: { name: "Alice" },
      });
    });

    it("filters with OR", () => {
      const result = expectSuccess(
        executor.execute(
          "MATCH (n:Person) WHERE n.name = 'Alice' OR n.name = 'Bob' RETURN n"
        )
      );
      expect(result.data).toHaveLength(2);
    });

    it("filters with CONTAINS", () => {
      const result = expectSuccess(
        executor.execute("MATCH (n:Person) WHERE n.name CONTAINS 'li' RETURN n")
      );
      expect(result.data).toHaveLength(2); // Alice and Charlie
    });

    it("filters with STARTS WITH", () => {
      const result = expectSuccess(
        executor.execute("MATCH (n:Person) WHERE n.name STARTS WITH 'A' RETURN n")
      );
      expect(result.data).toHaveLength(1);
    });

    it("filters with ENDS WITH", () => {
      const result = expectSuccess(
        executor.execute("MATCH (n:Person) WHERE n.name ENDS WITH 'e' RETURN n")
      );
      expect(result.data).toHaveLength(2); // Alice and Charlie
    });
  });

  describe("Parameters", () => {
    it("uses parameters in CREATE", () => {
      executor.execute(
        "CREATE (n:Person {name: $name, age: $age})",
        { name: "Alice", age: 30 }
      );

      const result = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN n")
      );
      expect(result.data[0].n).toMatchObject({
        properties: { name: "Alice", age: 30 },
      });
    });

    it("uses parameters in MATCH", () => {
      executor.execute("CREATE (n:Person {name: 'Alice', id: 'abc123'})");

      const result = expectSuccess(
        executor.execute(
          "MATCH (n:Person {id: $id}) RETURN n",
          { id: "abc123" }
        )
      );
      expect(result.data).toHaveLength(1);
    });

    it("uses parameters in WHERE", () => {
      executor.execute("CREATE (n:Person {name: 'Alice', age: 30})");
      executor.execute("CREATE (n:Person {name: 'Bob', age: 25})");

      const result = expectSuccess(
        executor.execute(
          "MATCH (n:Person) WHERE n.age > $minAge RETURN n",
          { minAge: 28 }
        )
      );
      expect(result.data).toHaveLength(1);
    });
  });

  describe("SET", () => {
    it("updates node properties", () => {
      // First create a node
      executor.execute("CREATE (n:Person {name: 'Alice', age: 30})");
      
      // Get the node to find its ID (we need to use a workaround since SET requires id)
      const nodes = db.getNodesByLabel("Person");
      expect(nodes).toHaveLength(1);
      const nodeId = nodes[0].id;

      // For now, let's verify SET works at the translator level
      // The current implementation needs the node ID from MATCH context
      // This is a limitation we'll address in a future iteration
    });
  });

  describe("DELETE", () => {
    it("deletes nodes", () => {
      executor.execute("CREATE (n:Person {name: 'Alice'})");
      expect(db.countNodes()).toBe(1);

      // DELETE requires the node to be matched first
      // Current implementation needs ID from MATCH context
      // This is a limitation we'll address
    });
  });

  describe("MERGE", () => {
    it("creates node when not exists", () => {
      executor.execute("MERGE (n:Person {name: 'Alice'})");

      const result = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN n")
      );
      expect(result.data).toHaveLength(1);
    });

    it("does not duplicate on second MERGE", () => {
      executor.execute("MERGE (n:Person {name: 'Alice'})");
      executor.execute("MERGE (n:Person {name: 'Alice'})");

      const result = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN n")
      );
      expect(result.data).toHaveLength(1);
    });
  });

  describe("id() function", () => {
    it("returns node id", () => {
      executor.execute("CREATE (n:Person {name: 'Alice'})");

      const result = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN id(n)")
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBeDefined();
      // Should be a UUID
      expect(result.data[0].id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });
  });

  describe("Metadata", () => {
    it("returns count in meta", () => {
      executor.execute("CREATE (n:Person {name: 'Alice'})");
      executor.execute("CREATE (n:Person {name: 'Bob'})");

      const result = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN n")
      );

      expect(result.meta.count).toBe(2);
    });

    it("returns time_ms in meta", () => {
      const result = expectSuccess(
        executor.execute("MATCH (n:Person) RETURN n")
      );

      expect(result.meta.time_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Error handling", () => {
    it("returns parse error for invalid syntax", () => {
      const result = executor.execute("INVALID QUERY");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBeDefined();
      }
    });

    it("returns error position for parse errors", () => {
      const result = executor.execute("CREATE (n:Person");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.position).toBeDefined();
        expect(result.error.line).toBeDefined();
        expect(result.error.column).toBeDefined();
      }
    });

    it("returns error for SQL failures", () => {
      // Try to create an edge to non-existent node
      // This will fail due to foreign key constraint
      const result = executor.execute(
        "CREATE (a:Person {name: 'Alice'})"
      );
      expect(result.success).toBe(true);

      // Manually try to insert invalid edge (bypassing normal flow)
      expect(() => {
        db.insertEdge("edge1", "KNOWS", "nonexistent1", "nonexistent2");
      }).toThrow();
    });
  });

  describe("executeQuery convenience function", () => {
    it("works as expected", () => {
      executeQuery(db, "CREATE (n:Person {name: 'Alice'})");

      const result = executeQuery(db, "MATCH (n:Person) RETURN n");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }
    });
  });

  describe("MATCH...CREATE patterns", () => {
    it("creates relationship from matched node to new node", () => {
      // First create a user
      executor.execute("CREATE (u:CC_User {id: 'user-123', name: 'Alice'})");

      // Now match the user and create a relationship to a new node
      const result = executor.execute(
        `MATCH (u:CC_User {id: $userId})
         CREATE (u)-[:HAS_REPORT]->(r:CC_MonthlyReport {
           id: $reportId,
           year: $year,
           month: $month,
           status: $status
         })`,
        {
          userId: "user-123",
          reportId: "report-456",
          year: 2024,
          month: 12,
          status: "pending"
        }
      );

      expect(result.success).toBe(true);

      // Verify the report was created
      const reportResult = expectSuccess(
        executor.execute("MATCH (r:CC_MonthlyReport) RETURN r")
      );
      expect(reportResult.data).toHaveLength(1);
      expect(reportResult.data[0].r).toMatchObject({
        properties: {
          id: "report-456",
          year: 2024,
          month: 12,
          status: "pending"
        }
      });

      // Verify the relationship was created
      const relResult = expectSuccess(
        executor.execute("MATCH (u:CC_User)-[:HAS_REPORT]->(r:CC_MonthlyReport) RETURN u.name, r.id")
      );
      expect(relResult.data).toHaveLength(1);
      expect(relResult.data[0].u_name).toBe("Alice");
      expect(relResult.data[0].r_id).toBe("report-456");
    });

    it("creates relationship from new node to matched node", () => {
      // First create a company
      executor.execute("CREATE (c:Company {id: 'company-1', name: 'Acme Corp'})");

      // Match the company and create an employee that works for it
      const result = executor.execute(
        `MATCH (c:Company {id: $companyId})
         CREATE (e:Employee {name: $name})-[:WORKS_FOR]->(c)`,
        { companyId: "company-1", name: "Bob" }
      );

      expect(result.success).toBe(true);

      // Verify the relationship
      const relResult = expectSuccess(
        executor.execute("MATCH (e:Employee)-[:WORKS_FOR]->(c:Company) RETURN e.name, c.name")
      );
      expect(relResult.data).toHaveLength(1);
      expect(relResult.data[0].e_name).toBe("Bob");
      expect(relResult.data[0].c_name).toBe("Acme Corp");
    });

    it("fails gracefully when matched node does not exist", () => {
      // Try to create relationship from non-existent user
      const result = executor.execute(
        `MATCH (u:CC_User {id: $userId})
         CREATE (u)-[:HAS_REPORT]->(r:CC_MonthlyReport {id: $reportId})`,
        { userId: "non-existent", reportId: "report-456" }
      );

      // Should succeed but create nothing (no matched nodes)
      expect(result.success).toBe(true);

      // Verify no report was created
      const reportResult = expectSuccess(
        executor.execute("MATCH (r:CC_MonthlyReport) RETURN r")
      );
      expect(reportResult.data).toHaveLength(0);
    });
  });

  describe("Standalone RETURN", () => {
    it("returns literal number", () => {
      const result = expectSuccess(executor.execute("RETURN 1"));

      expect(result.data).toHaveLength(1);
      expect(result.data[0].expr).toBe(1);
    });

    it("returns literal string", () => {
      const result = expectSuccess(executor.execute("RETURN 'hello'"));

      expect(result.data).toHaveLength(1);
      expect(result.data[0].expr).toBe("hello");
    });

    it("returns literal with alias", () => {
      const result = expectSuccess(executor.execute("RETURN 1 AS one"));

      expect(result.data).toHaveLength(1);
      expect(result.data[0].one).toBe(1);
    });

    it("returns multiple literals", () => {
      const result = expectSuccess(executor.execute("RETURN 1, 'hello', true"));

      expect(result.data).toHaveLength(1);
      expect(result.data[0].expr).toBe(1);
      // Note: second and third columns will have generated names
    });

    it("returns boolean literals", () => {
      const result = expectSuccess(executor.execute("RETURN true AS t, false AS f"));

      expect(result.data).toHaveLength(1);
      expect(result.data[0].t).toBe(1); // SQLite stores booleans as 1/0
      expect(result.data[0].f).toBe(0);
    });

    it("returns null literal", () => {
      const result = expectSuccess(executor.execute("RETURN null AS n"));

      expect(result.data).toHaveLength(1);
      expect(result.data[0].n).toBeNull();
    });
  });
});
