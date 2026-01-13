/**
 * Hybrid Executor - executes Cypher patterns using SQL for anchor
 * discovery and in-memory graph traversal for pattern matching.
 */

import { GraphDatabase } from "../db.js";
import { SubgraphLoader } from "./subgraph-loader.js";
import { MemoryGraph, MemoryNode, MemoryEdge, Direction } from "./memory-graph.js";

export interface VarLengthPatternParams {
  /** Label of the anchor node (starting point) */
  anchorLabel: string;
  /** Property filters for the anchor node */
  anchorProps: Record<string, unknown>;
  /** Edge type for variable-length traversal (null = any) */
  varEdgeType: string | null;
  /** Minimum depth for variable-length path */
  varMinDepth: number;
  /** Maximum depth for variable-length path */
  varMaxDepth: number;
  /** Direction of variable-length traversal */
  varDirection: Direction;
  /** Label of the middle node (end of var-length path) */
  middleLabel: string;
  /** Filter function for the middle node (e.g., WHERE b.age > 25) */
  middleFilter?: (node: MemoryNode) => boolean;
  /** Edge type for final hop */
  finalEdgeType: string;
  /** Direction of final hop */
  finalDirection: Direction;
  /** Label of the final node */
  finalLabel: string;
}

export interface PatternResult {
  /** The anchor node (a) */
  a: MemoryNode;
  /** The middle node (b) */
  b: MemoryNode;
  /** The final node (c) */
  c: MemoryNode;
}

export class HybridExecutor {
  private loader: SubgraphLoader;

  constructor(private db: GraphDatabase) {
    this.loader = new SubgraphLoader(db);
  }

  /**
   * Execute a variable-length pattern query.
   * Pattern: (a:Label {props})-[*min..max]->(b:Label)-[:TYPE]->(c:Label)
   *
   * Returns results in the same format as the SQL executor.
   */
  executeVarLengthPattern(
    params: VarLengthPatternParams
  ): Record<string, unknown>[] {
    const rawResults = this.executeVarLengthPatternRaw(params);

    // Format results to match SQL executor output
    return rawResults.map((result) => ({
      a: result.a.properties,
      b: result.b.properties,
      c: result.c.properties,
    }));
  }

  /**
   * Lower-level method that returns full node objects instead of just properties.
   * Useful for debugging and testing.
   */
  executeVarLengthPatternRaw(params: VarLengthPatternParams): PatternResult[] {
    const {
      anchorLabel,
      anchorProps,
      varEdgeType,
      varMinDepth,
      varMaxDepth,
      varDirection,
      middleLabel,
      middleFilter,
      finalEdgeType,
      finalDirection,
      finalLabel,
    } = params;

    // 1. Find anchor nodes using SQL (indexed lookup)
    const anchorIds = this.loader.findAnchors(anchorLabel, anchorProps);
    if (anchorIds.length === 0) {
      return [];
    }

    // 2. Load bounded subgraph
    // We need to traverse varMaxDepth + 1 to reach the final node
    const graph = this.loader.loadSubgraph({
      anchorNodeIds: anchorIds,
      maxDepth: varMaxDepth + 1,
      edgeTypes: null, // Load all edge types since we need finalEdgeType too
      direction: "both", // Load all directions for flexibility
    });

    // 3. Traverse in-memory to find pattern matches
    const results: PatternResult[] = [];

    for (const anchorId of anchorIds) {
      const anchorNode = graph.getNode(anchorId);
      if (!anchorNode) continue;

      // Traverse variable-length paths from anchor
      for (const path of graph.traversePaths(
        anchorId,
        varEdgeType,
        varMinDepth,
        varMaxDepth,
        varDirection
      )) {
        // The middle node is the last node in the var-length path
        const middleNode = path.nodes[path.nodes.length - 1];

        // Check middle node label
        if (!this.hasLabel(middleNode, middleLabel)) {
          continue;
        }

        // Apply middle node filter if provided
        if (middleFilter && !middleFilter(middleNode)) {
          continue;
        }

        // Find final nodes connected to the middle node
        const finalEdges = this.getEdgesByDirection(
          graph,
          middleNode.id,
          finalEdgeType,
          finalDirection
        );

        for (const edge of finalEdges) {
          const finalNodeId = this.getTargetNodeId(edge, middleNode.id, finalDirection);
          const finalNode = graph.getNode(finalNodeId);

          if (!finalNode) continue;

          // Check final node label
          if (!this.hasLabel(finalNode, finalLabel)) {
            continue;
          }

          results.push({
            a: anchorNode,
            b: middleNode,
            c: finalNode,
          });
        }
      }
    }

    return results;
  }

  /**
   * Check if a node has a specific label.
   */
  private hasLabel(node: MemoryNode, label: string): boolean {
    return node.labels.includes(label);
  }

  /**
   * Get edges from a node by type and direction.
   */
  private getEdgesByDirection(
    graph: MemoryGraph,
    nodeId: string,
    edgeType: string,
    direction: Direction
  ): MemoryEdge[] {
    const edges: MemoryEdge[] = [];

    if (direction === "out" || direction === "both") {
      edges.push(...graph.getOutEdges(nodeId, edgeType));
    }

    if (direction === "in" || direction === "both") {
      edges.push(...graph.getInEdges(nodeId, edgeType));
    }

    return edges;
  }

  /**
   * Get the target node ID from an edge given the source node and direction.
   */
  private getTargetNodeId(
    edge: MemoryEdge,
    sourceNodeId: string,
    direction: Direction
  ): string {
    // For outgoing: return targetId
    // For incoming: return sourceId
    // For both: return the other end
    if (direction === "out") {
      return edge.targetId;
    } else if (direction === "in") {
      return edge.sourceId;
    } else {
      // "both" - return the other end
      return edge.sourceId === sourceNodeId ? edge.targetId : edge.sourceId;
    }
  }
}
