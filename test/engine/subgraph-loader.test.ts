import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphDatabase } from "../../src/db.js";
import { SubgraphLoader } from "../../src/engine/subgraph-loader.js";

describe("SubgraphLoader", () => {
  let db: GraphDatabase;
  let loader: SubgraphLoader;

  beforeEach(() => {
    db = new GraphDatabase(":memory:");
    db.initialize();
    loader = new SubgraphLoader(db);
  });

  afterEach(() => {
    db.close();
  });

  // Helper to set up test data
  function setupSocialNetwork() {
    // Create a social network:
    //
    //   (alice:Person)--[:KNOWS]->(bob:Person)--[:KNOWS]->(charlie:Person)
    //         |                       |
    //         v [:LIKES]              v [:WORKS_AT]
    //   (post:Post)             (acme:Company)
    //
    db.insertNode("alice", "Person", { name: "Alice", age: 30 });
    db.insertNode("bob", "Person", { name: "Bob", age: 25 });
    db.insertNode("charlie", "Person", { name: "Charlie", age: 35 });
    db.insertNode("acme", "Company", { name: "Acme Corp", founded: 2010 });
    db.insertNode("post1", "Post", { content: "Hello world" });

    db.insertEdge("e1", "KNOWS", "alice", "bob", { since: 2020 });
    db.insertEdge("e2", "KNOWS", "bob", "charlie", { since: 2021 });
    db.insertEdge("e3", "WORKS_AT", "bob", "acme", { role: "Engineer" });
    db.insertEdge("e4", "LIKES", "alice", "post1", {});
  }

  describe("findAnchors()", () => {
    beforeEach(setupSocialNetwork);

    it("should find nodes by label", () => {
      const anchors = loader.findAnchors("Person");
      expect(anchors).toHaveLength(3);
      expect(anchors.sort()).toEqual(["alice", "bob", "charlie"]);
    });

    it("should find nodes by label with property filter", () => {
      const anchors = loader.findAnchors("Person", { name: "Alice" });
      expect(anchors).toEqual(["alice"]);
    });

    it("should filter by multiple properties", () => {
      const anchors = loader.findAnchors("Person", { name: "Bob", age: 25 });
      expect(anchors).toEqual(["bob"]);
    });

    it("should return empty array when no matches", () => {
      const anchors = loader.findAnchors("Person", { name: "Nobody" });
      expect(anchors).toEqual([]);
    });

    it("should return empty array for non-existent label", () => {
      const anchors = loader.findAnchors("NonExistent");
      expect(anchors).toEqual([]);
    });

    it("should handle numeric property values", () => {
      const anchors = loader.findAnchors("Person", { age: 30 });
      expect(anchors).toEqual(["alice"]);
    });

    it("should handle Company label", () => {
      const anchors = loader.findAnchors("Company");
      expect(anchors).toEqual(["acme"]);
    });
  });

  describe("loadSubgraph()", () => {
    beforeEach(setupSocialNetwork);

    it("should load subgraph with depth 0 (anchor nodes only)", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["alice"],
        maxDepth: 0,
        edgeTypes: null,
        direction: "out",
      });

      expect(graph.getNode("alice")).toBeDefined();
      expect(graph.getNode("bob")).toBeUndefined();
    });

    it("should load subgraph with depth 1", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["alice"],
        maxDepth: 1,
        edgeTypes: null,
        direction: "out",
      });

      // Alice and her direct neighbors (bob via KNOWS, post1 via LIKES)
      expect(graph.getNode("alice")).toBeDefined();
      expect(graph.getNode("bob")).toBeDefined();
      expect(graph.getNode("post1")).toBeDefined();
      // Charlie is 2 hops away
      expect(graph.getNode("charlie")).toBeUndefined();
    });

    it("should load subgraph with depth 2", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["alice"],
        maxDepth: 2,
        edgeTypes: null,
        direction: "out",
      });

      expect(graph.getNode("alice")).toBeDefined();
      expect(graph.getNode("bob")).toBeDefined();
      expect(graph.getNode("charlie")).toBeDefined();
      expect(graph.getNode("acme")).toBeDefined();
      expect(graph.getNode("post1")).toBeDefined();
    });

    it("should filter by edge type", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["alice"],
        maxDepth: 2,
        edgeTypes: ["KNOWS"],
        direction: "out",
      });

      expect(graph.getNode("alice")).toBeDefined();
      expect(graph.getNode("bob")).toBeDefined();
      expect(graph.getNode("charlie")).toBeDefined();
      // These are reachable via LIKES and WORKS_AT, not KNOWS
      expect(graph.getNode("post1")).toBeUndefined();
      expect(graph.getNode("acme")).toBeUndefined();
    });

    it("should support multiple edge types filter", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["alice"],
        maxDepth: 1,
        edgeTypes: ["KNOWS", "LIKES"],
        direction: "out",
      });

      expect(graph.getNode("bob")).toBeDefined();
      expect(graph.getNode("post1")).toBeDefined();
    });

    it("should support incoming direction", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["bob"],
        maxDepth: 1,
        edgeTypes: ["KNOWS"],
        direction: "in",
      });

      // Bob and nodes that KNOW bob (alice)
      expect(graph.getNode("bob")).toBeDefined();
      expect(graph.getNode("alice")).toBeDefined();
      // Charlie is reachable via outgoing KNOWS, not incoming
      expect(graph.getNode("charlie")).toBeUndefined();
    });

    it("should support both directions", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["bob"],
        maxDepth: 1,
        edgeTypes: ["KNOWS"],
        direction: "both",
      });

      expect(graph.getNode("bob")).toBeDefined();
      expect(graph.getNode("alice")).toBeDefined(); // incoming
      expect(graph.getNode("charlie")).toBeDefined(); // outgoing
    });

    it("should load edges between loaded nodes", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["alice"],
        maxDepth: 1,
        edgeTypes: ["KNOWS"],
        direction: "out",
      });

      // Should have the edge alice->bob
      const edges = graph.getOutEdges("alice", "KNOWS");
      expect(edges).toHaveLength(1);
      expect(edges[0].targetId).toBe("bob");
    });

    it("should support multiple anchor nodes", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["alice", "charlie"],
        maxDepth: 1,
        edgeTypes: ["KNOWS"],
        direction: "out",
      });

      expect(graph.getNode("alice")).toBeDefined();
      expect(graph.getNode("charlie")).toBeDefined();
      expect(graph.getNode("bob")).toBeDefined(); // 1 hop from alice
    });

    it("should handle empty anchor list", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: [],
        maxDepth: 10,
        edgeTypes: null,
        direction: "out",
      });

      expect(graph.getNode("alice")).toBeUndefined();
    });

    it("should handle non-existent anchor IDs gracefully", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["nonexistent"],
        maxDepth: 1,
        edgeTypes: null,
        direction: "out",
      });

      // Should return empty graph, not throw
      expect(graph.getNode("nonexistent")).toBeUndefined();
    });

    it("should preserve node properties", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["alice"],
        maxDepth: 0,
        edgeTypes: null,
        direction: "out",
      });

      const alice = graph.getNode("alice");
      expect(alice?.properties).toEqual({ name: "Alice", age: 30 });
      expect(alice?.labels).toEqual(["Person"]);
    });

    it("should preserve edge properties", () => {
      const graph = loader.loadSubgraph({
        anchorNodeIds: ["alice"],
        maxDepth: 1,
        edgeTypes: ["KNOWS"],
        direction: "out",
      });

      const edges = graph.getOutEdges("alice", "KNOWS");
      expect(edges[0].properties).toEqual({ since: 2020 });
    });
  });

  describe("integration scenarios", () => {
    it("should handle cyclic graphs", () => {
      // Create a cycle: A -> B -> C -> A
      db.insertNode("a", "Node", {});
      db.insertNode("b", "Node", {});
      db.insertNode("c", "Node", {});
      db.insertEdge("e1", "NEXT", "a", "b", {});
      db.insertEdge("e2", "NEXT", "b", "c", {});
      db.insertEdge("e3", "NEXT", "c", "a", {});

      const graph = loader.loadSubgraph({
        anchorNodeIds: ["a"],
        maxDepth: 10,
        edgeTypes: null,
        direction: "out",
      });

      // Should load all nodes despite cycle
      expect(graph.getNode("a")).toBeDefined();
      expect(graph.getNode("b")).toBeDefined();
      expect(graph.getNode("c")).toBeDefined();
    });

    it("should handle disconnected components", () => {
      db.insertNode("a", "Node", {});
      db.insertNode("b", "Node", {});
      db.insertNode("c", "Node", {}); // Disconnected
      db.insertEdge("e1", "REL", "a", "b", {});

      const graph = loader.loadSubgraph({
        anchorNodeIds: ["a"],
        maxDepth: 10,
        edgeTypes: null,
        direction: "out",
      });

      expect(graph.getNode("a")).toBeDefined();
      expect(graph.getNode("b")).toBeDefined();
      expect(graph.getNode("c")).toBeUndefined(); // Not reachable
    });

    it("should handle self-loops", () => {
      db.insertNode("a", "Node", {});
      db.insertEdge("e1", "SELF", "a", "a", {});

      const graph = loader.loadSubgraph({
        anchorNodeIds: ["a"],
        maxDepth: 1,
        edgeTypes: null,
        direction: "out",
      });

      expect(graph.getNode("a")).toBeDefined();
      expect(graph.getOutEdges("a", "SELF")).toHaveLength(1);
    });

    it("should handle nodes with multiple labels", () => {
      db.insertNode("n1", ["Person", "Employee"], { name: "Test" });

      // Find by primary label
      const anchors = loader.findAnchors("Person");
      expect(anchors).toContain("n1");

      const graph = loader.loadSubgraph({
        anchorNodeIds: ["n1"],
        maxDepth: 0,
        edgeTypes: null,
        direction: "out",
      });

      const node = graph.getNode("n1");
      expect(node?.labels).toEqual(["Person", "Employee"]);
    });
  });
});
