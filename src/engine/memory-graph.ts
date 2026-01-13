/**
 * In-memory graph structure for hybrid query execution.
 * Optimized for traversal operations with O(1) node lookups
 * and adjacency list access.
 */

export interface MemoryNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface MemoryEdge {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  properties: Record<string, unknown>;
}

export interface Path {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
}

export type Direction = "out" | "in" | "both";

/** Row format from SQLite nodes table */
export interface NodeRow {
  id: string;
  label: string; // JSON array string
  properties: string; // JSON object string
}

/** Row format from SQLite edges table */
export interface EdgeRow {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  properties: string; // JSON object string
}

export class MemoryGraph {
  private nodes: Map<string, MemoryNode> = new Map();
  private outEdges: Map<string, MemoryEdge[]> = new Map();
  private inEdges: Map<string, MemoryEdge[]> = new Map();

  /**
   * Build a MemoryGraph from SQLite row data.
   */
  static fromRows(nodeRows: NodeRow[], edgeRows: EdgeRow[]): MemoryGraph {
    const graph = new MemoryGraph();

    // Parse and index nodes
    for (const row of nodeRows) {
      const node: MemoryNode = {
        id: row.id,
        labels: JSON.parse(row.label),
        properties: JSON.parse(row.properties),
      };
      graph.nodes.set(node.id, node);
      // Initialize adjacency lists
      graph.outEdges.set(node.id, []);
      graph.inEdges.set(node.id, []);
    }

    // Parse and index edges
    for (const row of edgeRows) {
      const edge: MemoryEdge = {
        id: row.id,
        type: row.type,
        sourceId: row.source_id,
        targetId: row.target_id,
        properties: JSON.parse(row.properties),
      };

      // Add to outgoing edges of source
      const outList = graph.outEdges.get(edge.sourceId);
      if (outList) {
        outList.push(edge);
      }

      // Add to incoming edges of target
      const inList = graph.inEdges.get(edge.targetId);
      if (inList) {
        inList.push(edge);
      }
    }

    return graph;
  }

  /**
   * Get a node by ID. O(1) lookup.
   */
  getNode(id: string): MemoryNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Get outgoing edges from a node, optionally filtered by type.
   */
  getOutEdges(nodeId: string, type?: string): MemoryEdge[] {
    const edges = this.outEdges.get(nodeId) ?? [];
    if (type === undefined) {
      return edges;
    }
    return edges.filter((e) => e.type === type);
  }

  /**
   * Get incoming edges to a node, optionally filtered by type.
   */
  getInEdges(nodeId: string, type?: string): MemoryEdge[] {
    const edges = this.inEdges.get(nodeId) ?? [];
    if (type === undefined) {
      return edges;
    }
    return edges.filter((e) => e.type === type);
  }

  /**
   * Get neighboring nodes in a given direction, optionally filtered by edge type.
   */
  neighbors(nodeId: string, direction: Direction, type?: string): MemoryNode[] {
    const result: MemoryNode[] = [];
    const seen = new Set<string>();

    if (direction === "out" || direction === "both") {
      for (const edge of this.getOutEdges(nodeId, type)) {
        const node = this.nodes.get(edge.targetId);
        if (node && !seen.has(node.id)) {
          seen.add(node.id);
          result.push(node);
        }
      }
    }

    if (direction === "in" || direction === "both") {
      for (const edge of this.getInEdges(nodeId, type)) {
        const node = this.nodes.get(edge.sourceId);
        if (node && !seen.has(node.id)) {
          seen.add(node.id);
          result.push(node);
        }
      }
    }

    return result;
  }

  /**
   * Traverse variable-length paths from a starting node.
   * Yields paths lazily using a generator for memory efficiency.
   * Handles cycle detection to prevent infinite loops.
   */
  *traversePaths(
    startId: string,
    edgeType: string | null,
    minDepth: number,
    maxDepth: number,
    direction: Direction
  ): Generator<Path> {
    const startNode = this.nodes.get(startId);
    if (!startNode) {
      return;
    }

    // Handle minDepth = 0 case (include start node as a path)
    if (minDepth === 0) {
      yield { nodes: [startNode], edges: [] };
    }

    // DFS traversal with backtracking
    // Stack entries: [currentNodeId, currentPath, visitedEdgeIds]
    type StackEntry = {
      nodeId: string;
      nodes: MemoryNode[];
      edges: MemoryEdge[];
      visitedEdges: Set<string>;
    };

    const initialEntry: StackEntry = {
      nodeId: startId,
      nodes: [startNode],
      edges: [],
      visitedEdges: new Set(),
    };

    const stack: StackEntry[] = [initialEntry];

    while (stack.length > 0) {
      const current = stack.pop()!;
      const depth = current.edges.length;

      // Get edges to traverse
      const edgesToTraverse: MemoryEdge[] = [];

      if (direction === "out" || direction === "both") {
        const outEdges = this.getOutEdges(current.nodeId, edgeType ?? undefined);
        edgesToTraverse.push(...outEdges);
      }

      if (direction === "in" || direction === "both") {
        const inEdges = this.getInEdges(current.nodeId, edgeType ?? undefined);
        edgesToTraverse.push(...inEdges);
      }

      // Explore each edge
      for (const edge of edgesToTraverse) {
        // Skip if edge already used in this path (cycle prevention)
        if (current.visitedEdges.has(edge.id)) {
          continue;
        }

        // Determine the target node based on direction
        let targetId: string;
        if (edge.sourceId === current.nodeId) {
          targetId = edge.targetId;
        } else {
          targetId = edge.sourceId;
        }

        const targetNode = this.nodes.get(targetId);
        if (!targetNode) {
          continue;
        }

        // Build new path
        const newNodes = [...current.nodes, targetNode];
        const newEdges = [...current.edges, edge];
        const newVisited = new Set(current.visitedEdges);
        newVisited.add(edge.id);

        const newDepth = newEdges.length;

        // Yield if within depth range
        if (newDepth >= minDepth && newDepth <= maxDepth) {
          yield { nodes: newNodes, edges: newEdges };
        }

        // Continue exploring if we haven't reached max depth
        if (newDepth < maxDepth) {
          stack.push({
            nodeId: targetId,
            nodes: newNodes,
            edges: newEdges,
            visitedEdges: newVisited,
          });
        }
      }
    }
  }
}
