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

// ============================================================================
// Generalized Pattern Chain Types (supports N nodes, multiple var-length)
// ============================================================================

/** A single hop (edge) in the pattern chain */
export interface ChainHop {
  /** Edge type filter (null = any type) */
  edgeType: string | null;
  /** Direction of traversal */
  direction: Direction;
  /** Minimum hops (1 for fixed edges) */
  minHops: number;
  /** Maximum hops (1 for fixed edges, same as min) */
  maxHops: number;
}

/** A node position in the pattern chain */
export interface ChainNode {
  /** Variable name from the query (e.g., "a", "b", "person") */
  variable: string;
  /** Required label for this node */
  label: string;
  /** Optional filter function (from WHERE clause) */
  filter?: (node: MemoryNode) => boolean;
}

/** Generalized pattern chain parameters */
export interface PatternChainParams {
  /** The anchor (starting) node specification */
  anchor: ChainNode;
  /** Property filters for the anchor node */
  anchorProps: Record<string, unknown>;
  /** Sequence of hops and target nodes */
  chain: Array<{ hop: ChainHop; node: ChainNode }>;
}

/** Result type - maps variable names to MemoryNode */
export type ChainResultRaw = Map<string, MemoryNode>;



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

  // ==========================================================================
  // Generalized Pattern Chain Execution
  // ==========================================================================

  /**
   * Execute a generalized pattern chain query.
   * Supports arbitrary length chains and multiple variable-length edges.
   * 
   * Pattern examples:
   *   (a)-[*]->(b)-[:R1]->(c)-[:R2]->(d)  -- 4 nodes, var-length first
   *   (a)-[:R1]->(b)-[*]->(c)-[:R2]->(d)  -- var-length in middle
   *   (a)-[*]->(b)-[*]->(c)               -- multiple var-length
   * 
   * Returns results as Maps from variable names to MemoryNodes.
   */
  executePatternChain(params: PatternChainParams): ChainResultRaw[] {
    const { anchor, anchorProps, chain } = params;

    // 1. Find anchor nodes using SQL (indexed lookup)
    const anchorIds = this.loader.findAnchors(anchor.label, anchorProps);
    if (anchorIds.length === 0) {
      return [];
    }

    // 2. Calculate maximum depth needed for subgraph loading
    const totalMaxDepth = chain.reduce((sum, { hop }) => sum + hop.maxHops, 0);

    // 3. Load bounded subgraph
    const graph = this.loader.loadSubgraph({
      anchorNodeIds: anchorIds,
      maxDepth: totalMaxDepth,
      edgeTypes: null, // Load all edge types
      direction: "both", // Load all directions for flexibility
    });

    // 4. Traverse in-memory to find pattern matches
    const results: ChainResultRaw[] = [];

    for (const anchorId of anchorIds) {
      const anchorNode = graph.getNode(anchorId);
      if (!anchorNode) continue;

      // Check anchor label
      if (!this.hasLabel(anchorNode, anchor.label)) {
        continue;
      }

      // Apply anchor filter if provided
      if (anchor.filter && !anchor.filter(anchorNode)) {
        continue;
      }

      // Start recursive chain matching
      const initialMatch = new Map<string, MemoryNode>();
      initialMatch.set(anchor.variable, anchorNode);

      this.matchChain(graph, initialMatch, anchorNode, chain, 0, results);
    }

    return results;
  }

  /**
   * Recursively match the pattern chain starting from a given node.
   */
  private matchChain(
    graph: MemoryGraph,
    currentMatch: Map<string, MemoryNode>,
    currentNode: MemoryNode,
    chain: Array<{ hop: ChainHop; node: ChainNode }>,
    hopIndex: number,
    results: ChainResultRaw[]
  ): void {
    // Base case: all hops matched
    if (hopIndex >= chain.length) {
      results.push(new Map(currentMatch));
      return;
    }

    const { hop, node: targetNodeSpec } = chain[hopIndex];

    // Traverse this hop (handles both fixed and var-length)
    for (const path of graph.traversePaths(
      currentNode.id,
      hop.edgeType,
      hop.minHops,
      hop.maxHops,
      hop.direction
    )) {
      const targetNode = path.nodes[path.nodes.length - 1];

      // Check target node label
      if (!this.hasLabel(targetNode, targetNodeSpec.label)) {
        continue;
      }

      // Apply target node filter if provided
      if (targetNodeSpec.filter && !targetNodeSpec.filter(targetNode)) {
        continue;
      }

      // Add to match and recurse
      const newMatch = new Map(currentMatch);
      newMatch.set(targetNodeSpec.variable, targetNode);

      this.matchChain(graph, newMatch, targetNode, chain, hopIndex + 1, results);
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

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
