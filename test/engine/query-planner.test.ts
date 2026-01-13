import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parse } from "../../src/parser.js";
import { GraphDatabase } from "../../src/db.js";
import { Executor } from "../../src/executor.js";
import {
  analyzeForHybrid,
  isHybridCompatiblePattern,
  extractNodeInfo,
  convertWhereToFilter,
} from "../../src/engine/query-planner.js";

describe("QueryPlanner", () => {
  // Helper to parse a query
  function parseQuery(cypher: string) {
    const result = parse(cypher);
    if (!result.success) {
      throw new Error(`Parse error: ${result.error.message}`);
    }
    return result.query;
  }

  describe("isHybridCompatiblePattern()", () => {
    it("detects valid hybrid pattern: (a)-[*]->(b)-[:T]->(c)", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      expect(isHybridCompatiblePattern(query)).toBe(true);
    });

    it("detects pattern with properties on anchor", () => {
      const query = parseQuery(`
        MATCH (a:Person {name: 'Alice'})-[:KNOWS*1..2]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      expect(isHybridCompatiblePattern(query)).toBe(true);
    });

    it("detects pattern with WHERE clause", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
        WHERE b.age > 25
        RETURN a.name, b.name, c.name
      `);
      expect(isHybridCompatiblePattern(query)).toBe(true);
    });

    it("detects pattern with unbounded max depth", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      expect(isHybridCompatiblePattern(query)).toBe(true);
    });

    it("detects pattern with minHops = 0", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*0..3]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      expect(isHybridCompatiblePattern(query)).toBe(true);
    });

    it("accepts multi-hop pattern without var-length edge", () => {
      // Multi-hop patterns benefit from hybrid even without var-length edges
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      expect(isHybridCompatiblePattern(query)).toBe(true);
    });

    it("accepts pattern with only one var-length relationship", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)
        RETURN a, b
      `);
      // Now accepted - single var-length edge is valid
      expect(isHybridCompatiblePattern(query)).toBe(true);
    });

    it("accepts pattern with multiple var-length edges", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT*1..2]->(c:Company)
        RETURN a, b, c
      `);
      // Now accepted - multiple var-length edges are supported
      expect(isHybridCompatiblePattern(query)).toBe(true);
    });

    it("rejects queries with CREATE", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
        CREATE (d:Node)
        RETURN a, b, c
      `);
      expect(isHybridCompatiblePattern(query)).toBe(false);
    });

    it("rejects queries with SET", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
        SET b.visited = true
        RETURN a, b, c
      `);
      expect(isHybridCompatiblePattern(query)).toBe(false);
    });

    it("rejects queries with DELETE", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
        DELETE b
      `);
      expect(isHybridCompatiblePattern(query)).toBe(false);
    });

    it("rejects queries with MERGE", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
        MERGE (d:Node {id: 1})
        RETURN a, b, c
      `);
      expect(isHybridCompatiblePattern(query)).toBe(false);
    });

    it("rejects queries without RETURN", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
      `);
      expect(isHybridCompatiblePattern(query)).toBe(false);
    });

    it("rejects simple node-only MATCH", () => {
      const query = parseQuery(`
        MATCH (a:Person)
        RETURN a
      `);
      expect(isHybridCompatiblePattern(query)).toBe(false);
    });

    it("rejects single-hop fixed-length pattern", () => {
      // Single-hop without var-length doesn't benefit from hybrid
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        RETURN a, b
      `);
      expect(isHybridCompatiblePattern(query)).toBe(false);
    });

    it("rejects multiple MATCH clauses", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)
        MATCH (b)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      expect(isHybridCompatiblePattern(query)).toBe(false);
    });
  });

  describe("analyzeForHybrid()", () => {
    it("returns suitable=true with extracted params for valid pattern", () => {
      const query = parseQuery(`
        MATCH (a:Person {name: 'Alice'})-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      const result = analyzeForHybrid(query, {});

      expect(result.suitable).toBe(true);
      expect(result.params).toBeDefined();
      
      // Check anchor node
      expect(result.params!.anchor.label).toBe("Person");
      expect(result.params!.anchor.variable).toBe("a");
      expect(result.params!.anchorProps).toEqual({ name: "Alice" });
      
      // Check first hop (var-length)
      expect(result.params!.chain[0].hop.edgeType).toBe("KNOWS");
      expect(result.params!.chain[0].hop.minHops).toBe(1);
      expect(result.params!.chain[0].hop.maxHops).toBe(3);
      expect(result.params!.chain[0].node.label).toBe("Person");
      
      // Check second hop (fixed)
      expect(result.params!.chain[1].hop.edgeType).toBe("WORKS_AT");
      expect(result.params!.chain[1].node.label).toBe("Company");
    });

    it("resolves parameter refs in anchor properties", () => {
      const query = parseQuery(`
        MATCH (a:Person {name: $name})-[:KNOWS*1..2]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      const result = analyzeForHybrid(query, { name: "Bob" });

      expect(result.suitable).toBe(true);
      expect(result.params!.anchorProps).toEqual({ name: "Bob" });
    });

    it("extracts correct direction for outgoing var-length edge", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      const result = analyzeForHybrid(query, {});

      expect(result.params!.chain[0].hop.direction).toBe("out");
    });

    it("extracts correct direction for incoming var-length edge", () => {
      const query = parseQuery(`
        MATCH (a:Person)<-[:KNOWS*1..3]-(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      const result = analyzeForHybrid(query, {});

      expect(result.params!.chain[0].hop.direction).toBe("in");
    });

    it("extracts correct direction for undirected var-length edge", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]-(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      const result = analyzeForHybrid(query, {});

      expect(result.params!.chain[0].hop.direction).toBe("both");
    });

    it("handles var-length edge without type (any type)", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      const result = analyzeForHybrid(query, {});

      expect(result.suitable).toBe(true);
      expect(result.params!.chain[0].hop.edgeType).toBeNull();
    });

    it("extracts final edge direction correctly", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)<-[:EMPLOYS]-(c:Company)
        RETURN a, b, c
      `);
      const result = analyzeForHybrid(query, {});

      expect(result.params!.chain[1].hop.edgeType).toBe("EMPLOYS");
      expect(result.params!.chain[1].hop.direction).toBe("in");
    });

    it("returns suitable=false with reason for invalid pattern", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        RETURN a, b
      `);
      const result = analyzeForHybrid(query, {});

      // No var-length edge, so not suitable for hybrid
      expect(result.suitable).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("handles unbounded max depth", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*2..]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a, b, c
      `);
      const result = analyzeForHybrid(query, {});

      expect(result.suitable).toBe(true);
      expect(result.params!.chain[0].hop.minHops).toBe(2);
      // Unbounded should default to a reasonable max
      expect(result.params!.chain[0].hop.maxHops).toBeGreaterThanOrEqual(10);
    });

    // New tests for generalized patterns
    it("handles 4-node pattern chain", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..2]->(b:Person)-[:MANAGES]->(c:Project)-[:USES]->(d:Tech)
        RETURN a, b, c, d
      `);
      const result = analyzeForHybrid(query, {});

      expect(result.suitable).toBe(true);
      expect(result.params!.chain.length).toBe(3);
      
      expect(result.params!.chain[0].hop.edgeType).toBe("KNOWS");
      expect(result.params!.chain[0].hop.minHops).toBe(1);
      expect(result.params!.chain[0].node.label).toBe("Person");
      
      expect(result.params!.chain[1].hop.edgeType).toBe("MANAGES");
      expect(result.params!.chain[1].hop.minHops).toBe(1);
      expect(result.params!.chain[1].hop.maxHops).toBe(1);
      expect(result.params!.chain[1].node.label).toBe("Project");
      
      expect(result.params!.chain[2].hop.edgeType).toBe("USES");
      expect(result.params!.chain[2].node.label).toBe("Tech");
    });

    it("handles multiple var-length edges", () => {
      const query = parseQuery(`
        MATCH (a:Node)-[:LINK*1..2]->(b:Node)-[:LINK*1..3]->(c:Node)
        RETURN a, b, c
      `);
      const result = analyzeForHybrid(query, {});

      expect(result.suitable).toBe(true);
      expect(result.params!.chain.length).toBe(2);
      
      // First hop is var-length
      expect(result.params!.chain[0].hop.minHops).toBe(1);
      expect(result.params!.chain[0].hop.maxHops).toBe(2);
      
      // Second hop is also var-length
      expect(result.params!.chain[1].hop.minHops).toBe(1);
      expect(result.params!.chain[1].hop.maxHops).toBe(3);
    });

    it("handles var-length in middle of chain", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)-[:FRIEND_OF*1..3]->(c:Person)-[:WORKS_AT]->(d:Company)
        RETURN a, b, c, d
      `);
      const result = analyzeForHybrid(query, {});

      expect(result.suitable).toBe(true);
      expect(result.params!.chain.length).toBe(3);
      
      // First hop is fixed
      expect(result.params!.chain[0].hop.minHops).toBe(1);
      expect(result.params!.chain[0].hop.maxHops).toBe(1);
      
      // Second hop is var-length
      expect(result.params!.chain[1].hop.minHops).toBe(1);
      expect(result.params!.chain[1].hop.maxHops).toBe(3);
      
      // Third hop is fixed
      expect(result.params!.chain[2].hop.minHops).toBe(1);
      expect(result.params!.chain[2].hop.maxHops).toBe(1);
    });

    it("handles single var-length relationship (2 nodes)", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)
        RETURN a, b
      `);
      const result = analyzeForHybrid(query, {});

      expect(result.suitable).toBe(true);
      expect(result.params!.chain.length).toBe(1);
      expect(result.params!.chain[0].hop.edgeType).toBe("KNOWS");
      expect(result.params!.chain[0].node.label).toBe("Person");
    });
  });

  describe("extractNodeInfo()", () => {
    it("extracts label and empty properties", () => {
      const query = parseQuery(`MATCH (a:Person) RETURN a`);
      const match = query.clauses[0] as any;
      const node = match.patterns[0];

      const info = extractNodeInfo(node, {});
      expect(info).toEqual({ label: "Person", properties: {} });
    });

    it("extracts label and literal properties", () => {
      const query = parseQuery(`MATCH (a:Person {name: 'Alice', age: 30}) RETURN a`);
      const match = query.clauses[0] as any;
      const node = match.patterns[0];

      const info = extractNodeInfo(node, {});
      expect(info).toEqual({ label: "Person", properties: { name: "Alice", age: 30 } });
    });

    it("resolves parameter refs in properties", () => {
      const query = parseQuery(`MATCH (a:Person {name: $name}) RETURN a`);
      const match = query.clauses[0] as any;
      const node = match.patterns[0];

      const info = extractNodeInfo(node, { name: "Bob" });
      expect(info).toEqual({ label: "Person", properties: { name: "Bob" } });
    });

    it("returns null for node without label", () => {
      const query = parseQuery(`MATCH (a {name: 'Alice'}) RETURN a`);
      const match = query.clauses[0] as any;
      const node = match.patterns[0];

      const info = extractNodeInfo(node, {});
      expect(info).toBeNull();
    });
  });

  describe("convertWhereToFilter()", () => {
    it("converts simple greater-than comparison", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE b.age > 25
        RETURN a, b
      `);
      const match = query.clauses[0] as any;
      const where = match.where;

      const filter = convertWhereToFilter(where, "b", {});
      expect(filter).not.toBeNull();

      // Test the filter function
      expect(filter!({ id: "1", labels: ["Person"], properties: { age: 30 } })).toBe(true);
      expect(filter!({ id: "2", labels: ["Person"], properties: { age: 20 } })).toBe(false);
      expect(filter!({ id: "3", labels: ["Person"], properties: { age: 25 } })).toBe(false);
    });

    it("converts equality comparison", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE b.name = 'Alice'
        RETURN a, b
      `);
      const match = query.clauses[0] as any;

      const filter = convertWhereToFilter(match.where, "b", {});
      expect(filter).not.toBeNull();

      expect(filter!({ id: "1", labels: [], properties: { name: "Alice" } })).toBe(true);
      expect(filter!({ id: "2", labels: [], properties: { name: "Bob" } })).toBe(false);
    });

    it("converts less-than comparison", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE b.age < 30
        RETURN a, b
      `);
      const match = query.clauses[0] as any;

      const filter = convertWhereToFilter(match.where, "b", {});
      expect(filter!({ id: "1", labels: [], properties: { age: 25 } })).toBe(true);
      expect(filter!({ id: "2", labels: [], properties: { age: 35 } })).toBe(false);
    });

    it("converts >= and <= comparisons", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE b.age >= 25
        RETURN a, b
      `);
      const match = query.clauses[0] as any;

      const filter = convertWhereToFilter(match.where, "b", {});
      expect(filter!({ id: "1", labels: [], properties: { age: 25 } })).toBe(true);
      expect(filter!({ id: "2", labels: [], properties: { age: 24 } })).toBe(false);
    });

    it("converts <> (not equal) comparison", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE b.status <> 'inactive'
        RETURN a, b
      `);
      const match = query.clauses[0] as any;

      const filter = convertWhereToFilter(match.where, "b", {});
      expect(filter!({ id: "1", labels: [], properties: { status: "active" } })).toBe(true);
      expect(filter!({ id: "2", labels: [], properties: { status: "inactive" } })).toBe(false);
    });

    it("converts AND combination on middle node", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE b.age > 25 AND b.city = 'NYC'
        RETURN a, b
      `);
      const match = query.clauses[0] as any;

      const filter = convertWhereToFilter(match.where, "b", {});
      expect(filter).not.toBeNull();

      expect(filter!({ id: "1", labels: [], properties: { age: 30, city: "NYC" } })).toBe(true);
      expect(filter!({ id: "2", labels: [], properties: { age: 30, city: "LA" } })).toBe(false);
      expect(filter!({ id: "3", labels: [], properties: { age: 20, city: "NYC" } })).toBe(false);
    });

    it("converts OR combination on middle node", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE b.city = 'NYC' OR b.city = 'LA'
        RETURN a, b
      `);
      const match = query.clauses[0] as any;

      const filter = convertWhereToFilter(match.where, "b", {});
      expect(filter).not.toBeNull();

      expect(filter!({ id: "1", labels: [], properties: { city: "NYC" } })).toBe(true);
      expect(filter!({ id: "2", labels: [], properties: { city: "LA" } })).toBe(true);
      expect(filter!({ id: "3", labels: [], properties: { city: "Chicago" } })).toBe(false);
    });

    it("converts IS NOT NULL check", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE b.email IS NOT NULL
        RETURN a, b
      `);
      const match = query.clauses[0] as any;

      const filter = convertWhereToFilter(match.where, "b", {});
      expect(filter).not.toBeNull();

      expect(filter!({ id: "1", labels: [], properties: { email: "a@b.com" } })).toBe(true);
      expect(filter!({ id: "2", labels: [], properties: { email: null } })).toBe(false);
      expect(filter!({ id: "3", labels: [], properties: {} })).toBe(false);
    });

    it("resolves parameter refs in comparisons", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE b.age > $minAge
        RETURN a, b
      `);
      const match = query.clauses[0] as any;

      const filter = convertWhereToFilter(match.where, "b", { minAge: 25 });
      expect(filter!({ id: "1", labels: [], properties: { age: 30 } })).toBe(true);
      expect(filter!({ id: "2", labels: [], properties: { age: 20 } })).toBe(false);
    });

    it("returns null for cross-node comparison (a.x > b.x)", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE a.age > b.age
        RETURN a, b
      `);
      const match = query.clauses[0] as any;

      const filter = convertWhereToFilter(match.where, "b", {});
      expect(filter).toBeNull();
    });

    it("returns null for condition on different node", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE a.age > 25
        RETURN a, b
      `);
      const match = query.clauses[0] as any;

      const filter = convertWhereToFilter(match.where, "b", {});
      expect(filter).toBeNull();
    });

    it("returns null for AND with cross-node condition", () => {
      const query = parseQuery(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        WHERE b.age > 25 AND a.name = 'Alice'
        RETURN a, b
      `);
      const match = query.clauses[0] as any;

      const filter = convertWhereToFilter(match.where, "b", {});
      expect(filter).toBeNull();
    });

    it("returns identity filter for undefined WHERE", () => {
      const filter = convertWhereToFilter(undefined, "b", {});
      expect(filter).not.toBeNull();
      // Should pass all nodes
      expect(filter!({ id: "1", labels: [], properties: {} })).toBe(true);
    });
  });

  describe("executor integration", () => {
    let db: GraphDatabase;
    let executor: Executor;

    beforeEach(() => {
      db = new GraphDatabase(":memory:");
      db.initialize();
      executor = new Executor(db);

      // Set up test data
      db.insertNode("alice", "Person", { name: "Alice", age: 30 });
      db.insertNode("bob", "Person", { name: "Bob", age: 25 });
      db.insertNode("charlie", "Person", { name: "Charlie", age: 35 });
      db.insertNode("acme", "Company", { name: "Acme Corp" });
      db.insertNode("globex", "Company", { name: "Globex Inc" });

      db.insertEdge("e1", "KNOWS", "alice", "bob", {});
      db.insertEdge("e2", "KNOWS", "bob", "charlie", {});
      db.insertEdge("e3", "WORKS_AT", "bob", "acme", {});
      db.insertEdge("e4", "WORKS_AT", "charlie", "globex", {});
    });

    afterEach(() => {
      db.close();
    });

    it("routes hybrid-compatible query correctly and returns same results as SQL", () => {
      // This query should be routed to hybrid executor
      const result = executor.execute(`
        MATCH (a:Person {name: 'Alice'})-[:KNOWS*1..2]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a.name AS a_name, b.name AS b_name, c.name AS c_name
        ORDER BY b_name
      `);

      expect(result.success).toBe(true);
      if (result.success) {
        // Should find:
        // Alice -> Bob -> Acme (depth 1)
        // Alice -> Bob -> Charlie -> Globex (depth 2)
        expect(result.data.length).toBe(2);
        
        const names = result.data.map((r) => r.b_name).sort();
        expect(names).toEqual(["Bob", "Charlie"]);
      }
    });

    it("applies WHERE filter correctly", () => {
      const result = executor.execute(`
        MATCH (a:Person {name: 'Alice'})-[:KNOWS*1..2]->(b:Person)-[:WORKS_AT]->(c:Company)
        WHERE b.age > 30
        RETURN a.name AS a_name, b.name AS b_name, c.name AS c_name
      `);

      expect(result.success).toBe(true);
      if (result.success) {
        // Only Charlie (age 35) should pass the filter
        expect(result.data.length).toBe(1);
        expect(result.data[0].b_name).toBe("Charlie");
      }
    });

    it("falls back to SQL for non-hybrid-compatible queries", () => {
      // Simple pattern without var-length - should use SQL
      const result = executor.execute(`
        MATCH (a:Person)-[:KNOWS]->(b:Person)
        RETURN a.name AS a_name, b.name AS b_name
      `);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(2); // Alice->Bob, Bob->Charlie
      }
    });

    it("falls back to SQL for queries with mutations", () => {
      const result = executor.execute(`
        MATCH (a:Person)-[:KNOWS*1..2]->(b:Person)-[:WORKS_AT]->(c:Company)
        SET b.visited = true
        RETURN a.name
      `);

      expect(result.success).toBe(true);
    });

    it("handles query with no results", () => {
      const result = executor.execute(`
        MATCH (a:Person {name: 'Nobody'})-[:KNOWS*1..2]->(b:Person)-[:WORKS_AT]->(c:Company)
        RETURN a.name, b.name, c.name
      `);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(0);
      }
    });

    it("handles query with parameter refs", () => {
      const result = executor.execute(
        `MATCH (a:Person {name: $name})-[:KNOWS*1..1]->(b:Person)-[:WORKS_AT]->(c:Company)
         RETURN b.name AS b_name, c.name AS c_name`,
        { name: "Alice" }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(1);
        expect(result.data[0].b_name).toBe("Bob");
      }
    });
  });
});
