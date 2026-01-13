import { describe, it, expect, beforeEach } from "vitest";
import {
  MemoryGraph,
  MemoryNode,
  MemoryEdge,
  NodeRow,
  EdgeRow,
  Path,
} from "../../src/engine/memory-graph.js";

describe("MemoryGraph", () => {
  // Test data: A simple social network
  //
  //   (alice:Person)--[:KNOWS]->(bob:Person)--[:KNOWS]->(charlie:Person)
  //                                  |
  //                                  v [:WORKS_AT]
  //                            (acme:Company)
  //
  const nodeRows: NodeRow[] = [
    { id: "n1", label: '["Person"]', properties: '{"name":"Alice","age":30}' },
    { id: "n2", label: '["Person"]', properties: '{"name":"Bob","age":25}' },
    {
      id: "n3",
      label: '["Person"]',
      properties: '{"name":"Charlie","age":35}',
    },
    {
      id: "n4",
      label: '["Company"]',
      properties: '{"name":"Acme","founded":2010}',
    },
  ];

  const edgeRows: EdgeRow[] = [
    {
      id: "e1",
      type: "KNOWS",
      source_id: "n1",
      target_id: "n2",
      properties: '{"since":2020}',
    },
    {
      id: "e2",
      type: "KNOWS",
      source_id: "n2",
      target_id: "n3",
      properties: '{"since":2021}',
    },
    {
      id: "e3",
      type: "WORKS_AT",
      source_id: "n2",
      target_id: "n4",
      properties: '{"role":"Engineer"}',
    },
  ];

  describe("fromRows()", () => {
    it("should build a graph from node and edge rows", () => {
      const graph = MemoryGraph.fromRows(nodeRows, edgeRows);
      expect(graph).toBeInstanceOf(MemoryGraph);
    });

    it("should handle empty inputs", () => {
      const graph = MemoryGraph.fromRows([], []);
      expect(graph).toBeInstanceOf(MemoryGraph);
      expect(graph.getNode("nonexistent")).toBeUndefined();
    });

    it("should parse JSON labels correctly", () => {
      const graph = MemoryGraph.fromRows(nodeRows, edgeRows);
      const alice = graph.getNode("n1");
      expect(alice?.labels).toEqual(["Person"]);
    });

    it("should parse JSON properties correctly", () => {
      const graph = MemoryGraph.fromRows(nodeRows, edgeRows);
      const alice = graph.getNode("n1");
      expect(alice?.properties).toEqual({ name: "Alice", age: 30 });
    });

    it("should handle nodes with multiple labels", () => {
      const multiLabelRows: NodeRow[] = [
        {
          id: "n1",
          label: '["Person","Employee","Manager"]',
          properties: "{}",
        },
      ];
      const graph = MemoryGraph.fromRows(multiLabelRows, []);
      const node = graph.getNode("n1");
      expect(node?.labels).toEqual(["Person", "Employee", "Manager"]);
    });
  });

  describe("getNode()", () => {
    let graph: MemoryGraph;

    beforeEach(() => {
      graph = MemoryGraph.fromRows(nodeRows, edgeRows);
    });

    it("should return node by ID", () => {
      const alice = graph.getNode("n1");
      expect(alice).toBeDefined();
      expect(alice?.id).toBe("n1");
      expect(alice?.properties.name).toBe("Alice");
    });

    it("should return undefined for non-existent node", () => {
      expect(graph.getNode("nonexistent")).toBeUndefined();
    });
  });

  describe("getOutEdges()", () => {
    let graph: MemoryGraph;

    beforeEach(() => {
      graph = MemoryGraph.fromRows(nodeRows, edgeRows);
    });

    it("should return all outgoing edges from a node", () => {
      const edges = graph.getOutEdges("n2");
      expect(edges).toHaveLength(2); // KNOWS->n3, WORKS_AT->n4
      expect(edges.map((e) => e.targetId).sort()).toEqual(["n3", "n4"]);
    });

    it("should filter by edge type", () => {
      const edges = graph.getOutEdges("n2", "KNOWS");
      expect(edges).toHaveLength(1);
      expect(edges[0].targetId).toBe("n3");
    });

    it("should return empty array for node with no outgoing edges", () => {
      const edges = graph.getOutEdges("n3");
      expect(edges).toEqual([]);
    });

    it("should return empty array for non-existent node", () => {
      const edges = graph.getOutEdges("nonexistent");
      expect(edges).toEqual([]);
    });

    it("should include edge properties", () => {
      const edges = graph.getOutEdges("n1", "KNOWS");
      expect(edges[0].properties).toEqual({ since: 2020 });
    });
  });

  describe("getInEdges()", () => {
    let graph: MemoryGraph;

    beforeEach(() => {
      graph = MemoryGraph.fromRows(nodeRows, edgeRows);
    });

    it("should return all incoming edges to a node", () => {
      const edges = graph.getInEdges("n2");
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe("n1");
    });

    it("should filter by edge type", () => {
      const edges = graph.getInEdges("n4", "WORKS_AT");
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe("n2");
    });

    it("should return empty array for node with no incoming edges", () => {
      const edges = graph.getInEdges("n1");
      expect(edges).toEqual([]);
    });
  });

  describe("neighbors()", () => {
    let graph: MemoryGraph;

    beforeEach(() => {
      graph = MemoryGraph.fromRows(nodeRows, edgeRows);
    });

    it("should return outgoing neighbors", () => {
      const neighbors = graph.neighbors("n2", "out");
      expect(neighbors).toHaveLength(2);
      expect(neighbors.map((n) => n.id).sort()).toEqual(["n3", "n4"]);
    });

    it("should return incoming neighbors", () => {
      const neighbors = graph.neighbors("n2", "in");
      expect(neighbors).toHaveLength(1);
      expect(neighbors[0].id).toBe("n1");
    });

    it("should return both directions", () => {
      const neighbors = graph.neighbors("n2", "both");
      expect(neighbors).toHaveLength(3);
      expect(neighbors.map((n) => n.id).sort()).toEqual(["n1", "n3", "n4"]);
    });

    it("should filter by edge type", () => {
      const neighbors = graph.neighbors("n2", "out", "KNOWS");
      expect(neighbors).toHaveLength(1);
      expect(neighbors[0].id).toBe("n3");
    });

    it("should return empty array for isolated node", () => {
      const isolatedRows: NodeRow[] = [
        { id: "isolated", label: '["Node"]', properties: "{}" },
      ];
      const g = MemoryGraph.fromRows(isolatedRows, []);
      expect(g.neighbors("isolated", "both")).toEqual([]);
    });
  });

  describe("traversePaths()", () => {
    let graph: MemoryGraph;

    beforeEach(() => {
      graph = MemoryGraph.fromRows(nodeRows, edgeRows);
    });

    it("should traverse paths of exact depth", () => {
      // Alice -[KNOWS]-> Bob (depth 1)
      const paths = [...graph.traversePaths("n1", "KNOWS", 1, 1, "out")];
      expect(paths).toHaveLength(1);
      expect(paths[0].nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
      expect(paths[0].edges).toHaveLength(1);
    });

    it("should traverse paths with depth range", () => {
      // Alice -[KNOWS]-> Bob (depth 1)
      // Alice -[KNOWS]-> Bob -[KNOWS]-> Charlie (depth 2)
      const paths = [...graph.traversePaths("n1", "KNOWS", 1, 2, "out")];
      expect(paths).toHaveLength(2);

      const pathEndpoints = paths.map((p) => p.nodes[p.nodes.length - 1].id);
      expect(pathEndpoints.sort()).toEqual(["n2", "n3"]);
    });

    it("should respect minDepth", () => {
      // Only depth 2: Alice -> Bob -> Charlie
      const paths = [...graph.traversePaths("n1", "KNOWS", 2, 2, "out")];
      expect(paths).toHaveLength(1);
      expect(paths[0].nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    });

    it("should traverse without edge type filter (null)", () => {
      // All edges from Bob: KNOWS->Charlie, WORKS_AT->Acme
      const paths = [...graph.traversePaths("n2", null, 1, 1, "out")];
      expect(paths).toHaveLength(2);
    });

    it("should handle incoming direction", () => {
      // Bob <-[KNOWS]- Alice
      const paths = [...graph.traversePaths("n2", "KNOWS", 1, 1, "in")];
      expect(paths).toHaveLength(1);
      expect(paths[0].nodes.map((n) => n.id)).toEqual(["n2", "n1"]);
    });

    it("should handle both directions", () => {
      // From Bob: incoming (Alice) + outgoing (Charlie)
      const paths = [...graph.traversePaths("n2", "KNOWS", 1, 1, "both")];
      expect(paths).toHaveLength(2);
      const endpoints = paths.map((p) => p.nodes[1].id).sort();
      expect(endpoints).toEqual(["n1", "n3"]);
    });

    it("should detect cycles and not loop infinitely", () => {
      // Create a cycle: A -> B -> C -> A
      const cyclicNodes: NodeRow[] = [
        { id: "a", label: '["Node"]', properties: "{}" },
        { id: "b", label: '["Node"]', properties: "{}" },
        { id: "c", label: '["Node"]', properties: "{}" },
      ];
      const cyclicEdges: EdgeRow[] = [
        { id: "e1", type: "NEXT", source_id: "a", target_id: "b", properties: "{}" },
        { id: "e2", type: "NEXT", source_id: "b", target_id: "c", properties: "{}" },
        { id: "e3", type: "NEXT", source_id: "c", target_id: "a", properties: "{}" },
      ];
      const cyclicGraph = MemoryGraph.fromRows(cyclicNodes, cyclicEdges);

      // Traverse up to depth 10 - should not loop forever
      const paths = [...cyclicGraph.traversePaths("a", "NEXT", 1, 10, "out")];

      // Should get paths of length 1, 2, 3 but not longer (cycle detected)
      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(paths.length).toBeLessThanOrEqual(3);

      // No path should have duplicate edges
      for (const path of paths) {
        const edgeIds = path.edges.map((e) => e.id);
        expect(new Set(edgeIds).size).toBe(edgeIds.length);
      }
    });

    it("should return empty for non-existent start node", () => {
      const paths = [...graph.traversePaths("nonexistent", "KNOWS", 1, 3, "out")];
      expect(paths).toEqual([]);
    });

    it("should return empty when no matching edges", () => {
      const paths = [...graph.traversePaths("n1", "NONEXISTENT_TYPE", 1, 3, "out")];
      expect(paths).toEqual([]);
    });

    it("should handle minDepth of 0 (includes start node)", () => {
      const paths = [...graph.traversePaths("n1", "KNOWS", 0, 1, "out")];
      // Should include: just n1 (depth 0), and n1->n2 (depth 1)
      expect(paths).toHaveLength(2);

      const zeroLengthPath = paths.find((p) => p.edges.length === 0);
      expect(zeroLengthPath).toBeDefined();
      expect(zeroLengthPath?.nodes).toHaveLength(1);
      expect(zeroLengthPath?.nodes[0].id).toBe("n1");
    });

    it("should include correct edges in path", () => {
      const paths = [...graph.traversePaths("n1", "KNOWS", 2, 2, "out")];
      expect(paths).toHaveLength(1);

      const path = paths[0];
      expect(path.edges).toHaveLength(2);
      expect(path.edges[0].id).toBe("e1"); // Alice -> Bob
      expect(path.edges[1].id).toBe("e2"); // Bob -> Charlie
    });

    it("should yield paths lazily (generator behavior)", () => {
      const generator = graph.traversePaths("n1", "KNOWS", 1, 2, "out");

      // Get first path
      const first = generator.next();
      expect(first.done).toBe(false);
      expect(first.value).toBeDefined();

      // Can continue iteration
      const second = generator.next();
      expect(second.done).toBe(false);

      // Should complete
      const third = generator.next();
      expect(third.done).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle self-loops", () => {
      const nodes: NodeRow[] = [
        { id: "n1", label: '["Node"]', properties: "{}" },
      ];
      const edges: EdgeRow[] = [
        { id: "e1", type: "SELF", source_id: "n1", target_id: "n1", properties: "{}" },
      ];
      const graph = MemoryGraph.fromRows(nodes, edges);

      // Self-loop should be traversable once
      const paths = [...graph.traversePaths("n1", "SELF", 1, 1, "out")];
      expect(paths).toHaveLength(1);
      expect(paths[0].nodes.map((n) => n.id)).toEqual(["n1", "n1"]);
    });

    it("should handle parallel edges", () => {
      const nodes: NodeRow[] = [
        { id: "a", label: '["Node"]', properties: "{}" },
        { id: "b", label: '["Node"]', properties: "{}" },
      ];
      const edges: EdgeRow[] = [
        { id: "e1", type: "REL", source_id: "a", target_id: "b", properties: "{}" },
        { id: "e2", type: "REL", source_id: "a", target_id: "b", properties: "{}" },
      ];
      const graph = MemoryGraph.fromRows(nodes, edges);

      // Both edges should result in separate paths
      const paths = [...graph.traversePaths("a", "REL", 1, 1, "out")];
      expect(paths).toHaveLength(2);
    });

    it("should handle disconnected components", () => {
      const nodes: NodeRow[] = [
        { id: "a", label: '["Node"]', properties: "{}" },
        { id: "b", label: '["Node"]', properties: "{}" },
        { id: "c", label: '["Node"]', properties: "{}" },
      ];
      const edges: EdgeRow[] = [
        { id: "e1", type: "REL", source_id: "a", target_id: "b", properties: "{}" },
        // c is isolated
      ];
      const graph = MemoryGraph.fromRows(nodes, edges);

      const pathsFromA = [...graph.traversePaths("a", null, 1, 10, "out")];
      const pathsFromC = [...graph.traversePaths("c", null, 1, 10, "out")];

      expect(pathsFromA).toHaveLength(1);
      expect(pathsFromC).toHaveLength(0);
    });
  });
});
