import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphDatabase } from "../../src/db.js";
import { HybridExecutor, PatternChainParams } from "../../src/engine/hybrid-executor.js";
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

  // ==========================================================================
  // Generalized Pattern Chain Tests
  // ==========================================================================

  describe("executePatternChain() - longer chains", () => {
    let db: GraphDatabase;
    let hybridExecutor: HybridExecutor;
    let sqlExecutor: Executor;

    beforeEach(() => {
      db = new GraphDatabase(":memory:");
      db.initialize();
      hybridExecutor = new HybridExecutor(db);
      sqlExecutor = new Executor(db);

      // Create a 4-node chain test graph:
      //
      //   (alice:Person)--[:KNOWS]->(bob:Person)--[:MANAGES]->(proj:Project)--[:USES]->(tech:Tech)
      //                                          |
      //                                          v [:MANAGES]
      //                                     (proj2:Project)--[:USES]->(tech2:Tech)
      //
      db.insertNode("alice", "Person", { name: "Alice", age: 30 });
      db.insertNode("bob", "Person", { name: "Bob", age: 25 });
      db.insertNode("charlie", "Person", { name: "Charlie", age: 35 });
      db.insertNode("proj1", "Project", { name: "Alpha", budget: 100000 });
      db.insertNode("proj2", "Project", { name: "Beta", budget: 50000 });
      db.insertNode("tech1", "Tech", { name: "TypeScript" });
      db.insertNode("tech2", "Tech", { name: "Rust" });

      db.insertEdge("e1", "KNOWS", "alice", "bob", {});
      db.insertEdge("e2", "KNOWS", "bob", "charlie", {});
      db.insertEdge("e3", "MANAGES", "bob", "proj1", {});
      db.insertEdge("e4", "MANAGES", "bob", "proj2", {});
      db.insertEdge("e5", "USES", "proj1", "tech1", {});
      db.insertEdge("e6", "USES", "proj2", "tech2", {});
    });

    afterEach(() => {
      db.close();
    });

    it("should handle 4-node chain: (a)-[*]->(b)-[:R1]->(c)-[:R2]->(d)", () => {
      // Pattern: (a:Person)-[:KNOWS*1..2]->(b:Person)-[:MANAGES]->(c:Project)-[:USES]->(d:Tech)
      const params: PatternChainParams = {
        anchor: { variable: "a", label: "Person" },
        anchorProps: { name: "Alice" },
        chain: [
          {
            hop: { edgeType: "KNOWS", direction: "out", minHops: 1, maxHops: 2 },
            node: { variable: "b", label: "Person" },
          },
          {
            hop: { edgeType: "MANAGES", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "c", label: "Project" },
          },
          {
            hop: { edgeType: "USES", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "d", label: "Tech" },
          },
        ],
      };

      const results = hybridExecutor.executePatternChain(params);

      // Expected paths:
      // Alice -> Bob (depth 1) -> proj1 -> tech1
      // Alice -> Bob (depth 1) -> proj2 -> tech2
      expect(results).toHaveLength(2);
      const techNames = results.map((r) => r.get("d")!.properties.name).sort();
      expect(techNames).toEqual(["Rust", "TypeScript"]);
    });

    it("should handle var-length in middle: (a)-[:R1]->(b)-[*]->(c)-[:R2]->(d)", () => {
      // Add intermediate nodes for multi-hop in the middle
      db.insertNode("lead", "Person", { name: "Lead" });
      db.insertEdge("e7", "KNOWS", "alice", "lead", {});
      db.insertEdge("e8", "REPORTS_TO", "lead", "bob", {});
      db.insertEdge("e9", "REPORTS_TO", "bob", "charlie", {});
      db.insertNode("proj3", "Project", { name: "Gamma" });
      db.insertEdge("e10", "MANAGES", "charlie", "proj3", {});
      db.insertEdge("e11", "USES", "proj3", "tech1", {});

      // Pattern: (a:Person)-[:KNOWS]->(b:Person)-[:REPORTS_TO*1..2]->(c:Person)-[:MANAGES]->(d:Project)
      const params: PatternChainParams = {
        anchor: { variable: "a", label: "Person" },
        anchorProps: { name: "Alice" },
        chain: [
          {
            hop: { edgeType: "KNOWS", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "b", label: "Person" },
          },
          {
            hop: { edgeType: "REPORTS_TO", direction: "out", minHops: 1, maxHops: 2 },
            node: { variable: "c", label: "Person" },
          },
          {
            hop: { edgeType: "MANAGES", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "d", label: "Project" },
          },
        ],
      };

      const results = hybridExecutor.executePatternChain(params);

      // Alice -> Lead -> Bob (depth 1) -> proj1/proj2
      // Alice -> Lead -> Bob -> Charlie (depth 2) -> proj3
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle var-length at end: (a)-[:R1]->(b)-[:R2]->(c)-[*]->(d)", () => {
      // Add more tech dependencies
      db.insertNode("lib1", "Tech", { name: "React" });
      db.insertNode("lib2", "Tech", { name: "Vite" });
      db.insertEdge("e12", "DEPENDS_ON", "tech1", "lib1", {});
      db.insertEdge("e13", "DEPENDS_ON", "lib1", "lib2", {});

      // Pattern: (a:Person)-[:KNOWS]->(b:Person)-[:MANAGES]->(c:Project)-[:USES|DEPENDS_ON*1..3]->(d:Tech)
      const params: PatternChainParams = {
        anchor: { variable: "a", label: "Person" },
        anchorProps: { name: "Alice" },
        chain: [
          {
            hop: { edgeType: "KNOWS", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "b", label: "Person" },
          },
          {
            hop: { edgeType: "MANAGES", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "c", label: "Project" },
          },
          {
            hop: { edgeType: null, direction: "out", minHops: 1, maxHops: 3 }, // any edge type
            node: { variable: "d", label: "Tech" },
          },
        ],
      };

      const results = hybridExecutor.executePatternChain(params);

      // Should find paths through USES and DEPENDS_ON
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("should handle 5-node chain", () => {
      // Add another level
      db.insertNode("vendor", "Company", { name: "Acme" });
      db.insertEdge("e14", "PROVIDED_BY", "tech1", "vendor", {});

      // (a:Person)-[*]->(b:Person)-[:MANAGES]->(c:Project)-[:USES]->(d:Tech)-[:PROVIDED_BY]->(e:Company)
      const params: PatternChainParams = {
        anchor: { variable: "a", label: "Person" },
        anchorProps: { name: "Alice" },
        chain: [
          {
            hop: { edgeType: "KNOWS", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "b", label: "Person" },
          },
          {
            hop: { edgeType: "MANAGES", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "c", label: "Project" },
          },
          {
            hop: { edgeType: "USES", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "d", label: "Tech" },
          },
          {
            hop: { edgeType: "PROVIDED_BY", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "e", label: "Company" },
          },
        ],
      };

      const results = hybridExecutor.executePatternChain(params);

      // Alice -> Bob -> proj1 -> tech1 -> vendor
      expect(results).toHaveLength(1);
      expect(results[0].get("e")!.properties.name).toBe("Acme");
    });

    it("should apply filter on intermediate node", () => {
      // Filter: only projects with budget > 75000
      const params: PatternChainParams = {
        anchor: { variable: "a", label: "Person" },
        anchorProps: { name: "Alice" },
        chain: [
          {
            hop: { edgeType: "KNOWS", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "b", label: "Person" },
          },
          {
            hop: { edgeType: "MANAGES", direction: "out", minHops: 1, maxHops: 1 },
            node: {
              variable: "c",
              label: "Project",
              filter: (node) => (node.properties.budget as number) > 75000,
            },
          },
          {
            hop: { edgeType: "USES", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "d", label: "Tech" },
          },
        ],
      };

      const results = hybridExecutor.executePatternChain(params);

      // Only proj1 (budget 100000) passes the filter
      expect(results).toHaveLength(1);
      expect(results[0].get("c")!.properties.name).toBe("Alpha");
      expect(results[0].get("d")!.properties.name).toBe("TypeScript");
    });

    it("should return empty for no matches", () => {
      const params: PatternChainParams = {
        anchor: { variable: "a", label: "Person" },
        anchorProps: { name: "Nobody" },
        chain: [
          {
            hop: { edgeType: "KNOWS", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "b", label: "Person" },
          },
        ],
      };

      const results = hybridExecutor.executePatternChain(params);
      expect(results).toEqual([]);
    });

    it("regression: 3-node pattern still works", () => {
      // Same as original (a)-[*]->(b)-[:R]->(c) pattern
      const params: PatternChainParams = {
        anchor: { variable: "a", label: "Person" },
        anchorProps: { name: "Alice" },
        chain: [
          {
            hop: { edgeType: "KNOWS", direction: "out", minHops: 1, maxHops: 2 },
            node: { variable: "b", label: "Person" },
          },
          {
            hop: { edgeType: "MANAGES", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "c", label: "Project" },
          },
        ],
      };

      const results = hybridExecutor.executePatternChain(params);

      // Alice -> Bob -> proj1/proj2
      expect(results).toHaveLength(2);
    });
  });

  describe("executePatternChain() - multiple variable-length", () => {
    let db: GraphDatabase;
    let hybridExecutor: HybridExecutor;
    let sqlExecutor: Executor;

    beforeEach(() => {
      db = new GraphDatabase(":memory:");
      db.initialize();
      hybridExecutor = new HybridExecutor(db);
      sqlExecutor = new Executor(db);

      // Create a graph for testing multiple var-length patterns:
      //
      //   (a)-->(b)-->(c)-->(d)-->(e)
      //    |         ^
      //    +---------+
      //
      db.insertNode("a", "Node", { name: "A", level: 0 });
      db.insertNode("b", "Node", { name: "B", level: 1 });
      db.insertNode("c", "Node", { name: "C", level: 2 });
      db.insertNode("d", "Node", { name: "D", level: 3 });
      db.insertNode("e", "Node", { name: "E", level: 4 });

      db.insertEdge("e1", "LINK", "a", "b", {});
      db.insertEdge("e2", "LINK", "b", "c", {});
      db.insertEdge("e3", "LINK", "a", "c", {}); // shortcut
      db.insertEdge("e4", "LINK", "c", "d", {});
      db.insertEdge("e5", "LINK", "d", "e", {});
    });

    afterEach(() => {
      db.close();
    });

    it("should handle two consecutive var-length: (a)-[*1..2]->(b)-[*1..2]->(c)", () => {
      const params: PatternChainParams = {
        anchor: { variable: "x", label: "Node" },
        anchorProps: { name: "A" },
        chain: [
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 2 },
            node: { variable: "y", label: "Node" },
          },
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 2 },
            node: { variable: "z", label: "Node" },
          },
        ],
      };

      const results = hybridExecutor.executePatternChain(params);

      // First var-length from A: B (1 hop), C (1 hop via shortcut, 2 hops via B)
      // Second var-length from each:
      //   From B: C (1), D (2)
      //   From C: D (1), E (2)
      // Combinations are numerous - just check we get results
      expect(results.length).toBeGreaterThanOrEqual(4);
    });

    it("should handle different bounds: (a)-[*1..2]->(b)-[*2..3]->(c)", () => {
      const params: PatternChainParams = {
        anchor: { variable: "x", label: "Node" },
        anchorProps: { name: "A" },
        chain: [
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 2 },
            node: { variable: "y", label: "Node" },
          },
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 2, maxHops: 3 },
            node: { variable: "z", label: "Node" },
          },
        ],
      };

      const results = hybridExecutor.executePatternChain(params);

      // First hop: B or C
      // Second hop: must be 2-3 hops, so from B: D (2), E (3); from C: E (2)
      // Should get some results with z being D or E
      expect(results.length).toBeGreaterThanOrEqual(1);
      const zNames = results.map((r) => r.get("z")!.properties.name);
      expect(zNames.every((n) => n === "D" || n === "E")).toBe(true);
    });

    it("should handle var + fixed + var: (a)-[*]->(b)-[:R]->(c)-[*]->(d)", () => {
      // Add a fixed-hop middle
      db.insertNode("hub", "Hub", { name: "Hub" });
      db.insertEdge("e6", "LINK", "b", "hub", {});
      db.insertEdge("e7", "CONNECT", "hub", "c", {});
      db.insertEdge("e8", "CONNECT", "hub", "d", {});

      const params: PatternChainParams = {
        anchor: { variable: "start", label: "Node" },
        anchorProps: { name: "A" },
        chain: [
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 2 },
            node: { variable: "mid1", label: "Hub" },
          },
          {
            hop: { edgeType: "CONNECT", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "mid2", label: "Node" },
          },
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 2 },
            node: { variable: "end", label: "Node" },
          },
        ],
      };

      const results = hybridExecutor.executePatternChain(params);

      // A -[*1..2]-> Hub -[:CONNECT]-> C/D -[*1..2]-> ...
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle three var-length hops", () => {
      const params: PatternChainParams = {
        anchor: { variable: "n0", label: "Node" },
        anchorProps: { name: "A" },
        chain: [
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "n1", label: "Node" },
          },
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "n2", label: "Node" },
          },
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 1 },
            node: { variable: "n3", label: "Node" },
          },
        ],
      };

      const results = hybridExecutor.executePatternChain(params);

      // A -> B -> C -> D or A -> C -> D -> E (via shortcut)
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle cycles without infinite loops", () => {
      // Add a cycle
      db.insertEdge("e_cycle", "LINK", "e", "a", {}); // E -> A creates cycle

      const params: PatternChainParams = {
        anchor: { variable: "x", label: "Node" },
        anchorProps: { name: "A" },
        chain: [
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 5 },
            node: { variable: "y", label: "Node" },
          },
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 5 },
            node: { variable: "z", label: "Node" },
          },
        ],
      };

      // Should complete without hanging
      const results = hybridExecutor.executePatternChain(params);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("should match SQL results for multi-var-length pattern", () => {
      // SQL query equivalent
      const sqlResult = sqlExecutor.execute(`
        MATCH (x:Node {name: 'A'})-[:LINK*1..2]->(y:Node)-[:LINK*1..2]->(z:Node)
        RETURN x.name AS x_name, y.name AS y_name, z.name AS z_name
      `);

      const params: PatternChainParams = {
        anchor: { variable: "x", label: "Node" },
        anchorProps: { name: "A" },
        chain: [
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 2 },
            node: { variable: "y", label: "Node" },
          },
          {
            hop: { edgeType: "LINK", direction: "out", minHops: 1, maxHops: 2 },
            node: { variable: "z", label: "Node" },
          },
        ],
      };

      const hybridResults = hybridExecutor.executePatternChain(params);

      expect(sqlResult.success).toBe(true);
      if (sqlResult.success) {
        // Compare counts
        expect(hybridResults.length).toBe(sqlResult.data.length);
      }
    });
  });
});
