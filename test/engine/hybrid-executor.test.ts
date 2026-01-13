import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphDatabase } from "../../src/db.js";
import { HybridExecutor } from "../../src/engine/hybrid-executor.js";
import { Executor } from "../../src/executor.js";

describe("HybridExecutor", () => {
  let db: GraphDatabase;
  let hybridExecutor: HybridExecutor;
  let sqlExecutor: Executor;

  beforeEach(() => {
    db = new GraphDatabase(":memory:");
    db.initialize();
    hybridExecutor = new HybridExecutor(db);
    sqlExecutor = new Executor(db);
  });

  afterEach(() => {
    db.close();
  });

  // Helper to set up test data matching the target query pattern:
  // (a:Person {name})-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
  function setupTargetPattern() {
    // Create a network:
    //
    //   (alice:Person)--[:KNOWS]->(bob:Person)--[:KNOWS]->(charlie:Person)
    //         |                       |                        |
    //         |                       v [:WORKS_AT]            v [:WORKS_AT]
    //         |                  (acme:Company)           (globex:Company)
    //         |
    //         v [:KNOWS]
    //   (diana:Person)--[:WORKS_AT]->(startup:Company)
    //
    db.insertNode("alice", "Person", { name: "Alice", age: 30 });
    db.insertNode("bob", "Person", { name: "Bob", age: 25 });
    db.insertNode("charlie", "Person", { name: "Charlie", age: 35 });
    db.insertNode("diana", "Person", { name: "Diana", age: 22 });
    db.insertNode("acme", "Company", { name: "Acme Corp", founded: 2010 });
    db.insertNode("globex", "Company", { name: "Globex Inc", founded: 2015 });
    db.insertNode("startup", "Company", { name: "Startup LLC", founded: 2020 });

    db.insertEdge("e1", "KNOWS", "alice", "bob", { since: 2020 });
    db.insertEdge("e2", "KNOWS", "bob", "charlie", { since: 2021 });
    db.insertEdge("e3", "KNOWS", "alice", "diana", { since: 2019 });
    db.insertEdge("e4", "WORKS_AT", "bob", "acme", { role: "Engineer" });
    db.insertEdge("e5", "WORKS_AT", "charlie", "globex", { role: "Manager" });
    db.insertEdge("e6", "WORKS_AT", "diana", "startup", { role: "Founder" });
  }

  describe("executeVarLengthPatternRaw()", () => {
    beforeEach(setupTargetPattern);

    it("should find basic variable-length pattern", () => {
      // Alice -[:KNOWS*1..1]-> Bob -[:WORKS_AT]-> Acme
      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "Alice" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 1,
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      expect(results).toHaveLength(2);
      // Alice -> Bob -> Acme
      // Alice -> Diana -> Startup
      const companyNames = results.map((r) => r.c.properties.name).sort();
      expect(companyNames).toEqual(["Acme Corp", "Startup LLC"]);
    });

    it("should handle variable-length depth 1..2", () => {
      // Alice -[:KNOWS*1..2]-> (Bob or Charlie) -[:WORKS_AT]-> Company
      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "Alice" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 2,
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      // Depth 1: Alice->Bob->Acme, Alice->Diana->Startup
      // Depth 2: Alice->Bob->Charlie->Globex
      expect(results).toHaveLength(3);
      const companyNames = results.map((r) => r.c.properties.name).sort();
      expect(companyNames).toEqual(["Acme Corp", "Globex Inc", "Startup LLC"]);
    });

    it("should apply middle node filter", () => {
      // Alice -[:KNOWS*1..2]-> b:Person WHERE b.age > 25 -[:WORKS_AT]-> Company
      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "Alice" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 2,
        varDirection: "out",
        middleLabel: "Person",
        middleFilter: (node) => (node.properties.age as number) > 25,
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      // Only Charlie (age 35) passes the filter at depth 2
      expect(results).toHaveLength(1);
      expect(results[0].b.properties.name).toBe("Charlie");
      expect(results[0].c.properties.name).toBe("Globex Inc");
    });

    it("should handle no matches", () => {
      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "Nobody" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 3,
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      expect(results).toEqual([]);
    });

    it("should handle minDepth > 1", () => {
      // Only depth 2 paths: Alice->Bob->Charlie->Globex
      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "Alice" },
        varEdgeType: "KNOWS",
        varMinDepth: 2,
        varMaxDepth: 2,
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      expect(results).toHaveLength(1);
      expect(results[0].b.properties.name).toBe("Charlie");
    });

    it("should verify middle node has correct label", () => {
      // If middle node doesn't have Person label, shouldn't match
      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "Alice" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 1,
        varDirection: "out",
        middleLabel: "Company", // Wrong label - no Person named Alice knows a Company directly
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      expect(results).toEqual([]);
    });

    it("should verify final node has correct label", () => {
      // Looking for Person at the end instead of Company
      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "Alice" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 1,
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Person", // Wrong - WORKS_AT goes to Company
      });

      expect(results).toEqual([]);
    });
  });

  describe("executeVarLengthPattern()", () => {
    beforeEach(setupTargetPattern);

    it("should return property values in correct format", () => {
      const results = hybridExecutor.executeVarLengthPattern({
        anchorLabel: "Person",
        anchorProps: { name: "Alice" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 1,
        varDirection: "out",
        middleLabel: "Person",
        middleFilter: (node) => (node.properties.age as number) > 24,
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      // Should have a, b, c properties with their respective values
      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty("a");
      expect(results[0]).toHaveProperty("b");
      expect(results[0]).toHaveProperty("c");
    });
  });

  describe("correctness vs SQL executor", () => {
    beforeEach(setupTargetPattern);

    it("should match SQL results for simple pattern", () => {
      // Run SQL query
      const sqlResponse = sqlExecutor.execute(
        `MATCH (a:Person {name: 'Alice'})-[:KNOWS]->(b:Person)-[:WORKS_AT]->(c:Company)
         RETURN a.name AS a_name, b.name AS b_name, c.name AS c_name
         ORDER BY b_name`
      );
      expect(sqlResponse.success).toBe(true);
      const sqlResults = (sqlResponse as { success: true; data: Record<string, unknown>[] }).data;

      // Run hybrid query
      const hybridResults = hybridExecutor.executeVarLengthPattern({
        anchorLabel: "Person",
        anchorProps: { name: "Alice" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 1,
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      // Compare counts
      expect(hybridResults.length).toBe(sqlResults.length);

      // Compare values (need to extract same properties)
      const sqlCompanyNames = sqlResults.map((r) => r.c_name).sort();
      const hybridCompanyNames = hybridResults
        .map((r) => (r.c as Record<string, unknown>).name)
        .sort();
      expect(hybridCompanyNames).toEqual(sqlCompanyNames);
    });

    it("should match SQL results for variable-length pattern", () => {
      // Run SQL query with var-length path
      const sqlResponse = sqlExecutor.execute(
        `MATCH (a:Person {name: 'Alice'})-[:KNOWS*1..2]->(b:Person)-[:WORKS_AT]->(c:Company)
         RETURN a.name AS a_name, b.name AS b_name, c.name AS c_name
         ORDER BY b_name`
      );
      expect(sqlResponse.success).toBe(true);
      const sqlResults = (sqlResponse as { success: true; data: Record<string, unknown>[] }).data;

      // Run hybrid query
      const hybridResults = hybridExecutor.executeVarLengthPattern({
        anchorLabel: "Person",
        anchorProps: { name: "Alice" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 2,
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      // Compare counts
      expect(hybridResults.length).toBe(sqlResults.length);

      // Compare middle node names
      const sqlMiddleNames = sqlResults.map((r) => r.b_name).sort();
      const hybridMiddleNames = hybridResults
        .map((r) => (r.b as Record<string, unknown>).name)
        .sort();
      expect(hybridMiddleNames).toEqual(sqlMiddleNames);
    });

    it("should match SQL results with WHERE filter", () => {
      // Run SQL query with WHERE
      const sqlResponse = sqlExecutor.execute(
        `MATCH (a:Person {name: 'Alice'})-[:KNOWS*1..2]->(b:Person)-[:WORKS_AT]->(c:Company)
         WHERE b.age > 25
         RETURN a.name AS a_name, b.name AS b_name, c.name AS c_name`
      );
      expect(sqlResponse.success).toBe(true);
      const sqlResults = (sqlResponse as { success: true; data: Record<string, unknown>[] }).data;

      // Run hybrid query with equivalent filter
      const hybridResults = hybridExecutor.executeVarLengthPattern({
        anchorLabel: "Person",
        anchorProps: { name: "Alice" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 2,
        varDirection: "out",
        middleLabel: "Person",
        middleFilter: (node) => (node.properties.age as number) > 25,
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      // Compare counts
      expect(hybridResults.length).toBe(sqlResults.length);

      // Both should only have Charlie (age 35)
      if (sqlResults.length > 0) {
        expect(sqlResults[0].b_name).toBe("Charlie");
        expect((hybridResults[0].b as Record<string, unknown>).name).toBe(
          "Charlie"
        );
      }
    });
  });

  describe("edge cases", () => {
    it("should handle cycles in the graph", () => {
      // Create a cycle: A -> B -> C -> A
      db.insertNode("a", "Person", { name: "A" });
      db.insertNode("b", "Person", { name: "B" });
      db.insertNode("c", "Person", { name: "C" });
      db.insertNode("company", "Company", { name: "Corp" });

      db.insertEdge("e1", "KNOWS", "a", "b", {});
      db.insertEdge("e2", "KNOWS", "b", "c", {});
      db.insertEdge("e3", "KNOWS", "c", "a", {}); // Cycle back
      db.insertEdge("e4", "WORKS_AT", "c", "company", {});

      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "A" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 5, // High depth but should not infinite loop
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      // Should find A -> B -> C -> Company (depth 2)
      // Should NOT infinite loop
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.b.properties.name === "C")).toBe(true);
    });

    it("should handle parallel edges", () => {
      db.insertNode("a", "Person", { name: "A" });
      db.insertNode("b", "Person", { name: "B" });
      db.insertNode("company", "Company", { name: "Corp" });

      // Two KNOWS edges between same nodes
      db.insertEdge("e1", "KNOWS", "a", "b", { type: "friend" });
      db.insertEdge("e2", "KNOWS", "a", "b", { type: "colleague" });
      db.insertEdge("e3", "WORKS_AT", "b", "company", {});

      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "A" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 1,
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      // Should find result via both edges (2 paths)
      expect(results).toHaveLength(2);
    });

    it("should handle self-loops", () => {
      db.insertNode("a", "Person", { name: "A" });
      db.insertNode("company", "Company", { name: "Corp" });

      db.insertEdge("e1", "KNOWS", "a", "a", {}); // Self-loop
      db.insertEdge("e2", "WORKS_AT", "a", "company", {});

      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "A" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 1,
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      // A -> A (via self-loop) -> Company
      expect(results).toHaveLength(1);
      expect(results[0].a.id).toBe("a");
      expect(results[0].b.id).toBe("a");
    });

    it("should handle bidirectional traversal", () => {
      db.insertNode("a", "Person", { name: "A" });
      db.insertNode("b", "Person", { name: "B" });
      db.insertNode("company", "Company", { name: "Corp" });

      // B knows A (reverse direction)
      db.insertEdge("e1", "KNOWS", "b", "a", {});
      db.insertEdge("e2", "WORKS_AT", "a", "company", {});

      // With direction "both", should find B -> A -> Company
      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "B" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 1,
        varDirection: "both", // Can traverse either direction
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      expect(results).toHaveLength(1);
      expect(results[0].b.properties.name).toBe("A");
    });

    it("should handle any edge type (null)", () => {
      db.insertNode("a", "Person", { name: "A" });
      db.insertNode("b", "Person", { name: "B" });
      db.insertNode("company", "Company", { name: "Corp" });

      db.insertEdge("e1", "FRIEND_OF", "a", "b", {}); // Different edge type
      db.insertEdge("e2", "WORKS_AT", "b", "company", {});

      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "A" },
        varEdgeType: null, // Any edge type
        varMinDepth: 1,
        varMaxDepth: 1,
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "WORKS_AT",
        finalDirection: "out",
        finalLabel: "Company",
      });

      expect(results).toHaveLength(1);
    });

    it("should handle incoming final edge direction", () => {
      db.insertNode("a", "Person", { name: "A" });
      db.insertNode("b", "Person", { name: "B" });
      db.insertNode("company", "Company", { name: "Corp" });

      db.insertEdge("e1", "KNOWS", "a", "b", {});
      // Company EMPLOYS B (reverse of WORKS_AT)
      db.insertEdge("e2", "EMPLOYS", "company", "b", {});

      const results = hybridExecutor.executeVarLengthPatternRaw({
        anchorLabel: "Person",
        anchorProps: { name: "A" },
        varEdgeType: "KNOWS",
        varMinDepth: 1,
        varMaxDepth: 1,
        varDirection: "out",
        middleLabel: "Person",
        finalEdgeType: "EMPLOYS",
        finalDirection: "in", // Incoming edge from Company
        finalLabel: "Company",
      });

      expect(results).toHaveLength(1);
      expect(results[0].c.properties.name).toBe("Corp");
    });
  });
});
