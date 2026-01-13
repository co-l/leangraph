/**
 * Subgraph Loader - loads bounded subgraphs from SQLite into memory.
 * Uses indexed SQL queries for anchor node discovery and bounded
 * recursive CTEs for subgraph extraction.
 */

import { GraphDatabase, NodeRow, EdgeRow } from "../db.js";
import { MemoryGraph, Direction, NodeRow as MemNodeRow, EdgeRow as MemEdgeRow } from "./memory-graph.js";

export interface SubgraphBounds {
  /** Starting node IDs for subgraph expansion */
  anchorNodeIds: string[];
  /** Maximum depth to expand from anchors */
  maxDepth: number;
  /** Edge types to traverse (null = all types) */
  edgeTypes: string[] | null;
  /** Direction of traversal */
  direction: Direction;
}

export interface PropertyFilter {
  [key: string]: unknown;
}

export class SubgraphLoader {
  constructor(private db: GraphDatabase) {}

  /**
   * Find anchor nodes by label and optional property filters.
   * Uses indexed queries for efficient lookup.
   */
  findAnchors(label: string, propertyFilters?: PropertyFilter): string[] {
    // Build query with label filter (uses idx_nodes_primary_label index)
    let sql = `SELECT id FROM nodes WHERE json_extract(label, '$[0]') = ?`;
    const params: unknown[] = [label];

    // Add property filters
    if (propertyFilters) {
      for (const [key, value] of Object.entries(propertyFilters)) {
        sql += ` AND json_extract(properties, '$.${key}') = ?`;
        // json_extract returns raw values for numbers/booleans, JSON strings for strings
        // Numbers come back as numbers, strings come back as strings (without quotes)
        params.push(value);
      }
    }

    const result = this.db.execute(sql, params);
    return result.rows.map((row) => (row as { id: string }).id);
  }

  /**
   * Load a bounded subgraph into memory.
   * Uses a recursive CTE to collect reachable node IDs within bounds,
   * then bulk fetches nodes and edges.
   */
  loadSubgraph(bounds: SubgraphBounds): MemoryGraph {
    const { anchorNodeIds, maxDepth, edgeTypes, direction } = bounds;

    if (anchorNodeIds.length === 0) {
      return MemoryGraph.fromRows([], []);
    }

    // Collect all reachable node IDs using recursive CTE
    const nodeIds = this.collectReachableNodes(
      anchorNodeIds,
      maxDepth,
      edgeTypes,
      direction
    );

    if (nodeIds.size === 0) {
      return MemoryGraph.fromRows([], []);
    }

    // Bulk fetch nodes
    const nodeIdArray = Array.from(nodeIds);
    const nodePlaceholders = nodeIdArray.map(() => "?").join(",");
    const nodeResult = this.db.execute(
      `SELECT id, label, properties FROM nodes WHERE id IN (${nodePlaceholders})`,
      nodeIdArray
    );
    const nodeRows: MemNodeRow[] = nodeResult.rows.map((row) => {
      const r = row as unknown as NodeRow;
      return { id: r.id, label: r.label, properties: r.properties };
    });

    // Bulk fetch edges between loaded nodes
    // Only include edges where both endpoints are in our subgraph
    const edgeResult = this.db.execute(
      `SELECT id, type, source_id, target_id, properties 
       FROM edges 
       WHERE source_id IN (${nodePlaceholders}) 
         AND target_id IN (${nodePlaceholders})`,
      [...nodeIdArray, ...nodeIdArray]
    );
    const edgeRows: MemEdgeRow[] = edgeResult.rows.map((row) => {
      const r = row as unknown as EdgeRow;
      return {
        id: r.id,
        type: r.type,
        source_id: r.source_id,
        target_id: r.target_id,
        properties: r.properties,
      };
    });

    return MemoryGraph.fromRows(nodeRows, edgeRows);
  }

  /**
   * Collect all node IDs reachable from anchors within the given bounds.
   * Uses BFS with depth tracking.
   */
  private collectReachableNodes(
    anchorIds: string[],
    maxDepth: number,
    edgeTypes: string[] | null,
    direction: Direction
  ): Set<string> {
    const reachable = new Set<string>();
    const visited = new Set<string>();
    
    // Queue entries: [nodeId, currentDepth]
    const queue: [string, number][] = [];

    // Initialize with anchor nodes
    for (const id of anchorIds) {
      // Verify anchor exists
      const exists = this.db.execute(
        "SELECT 1 FROM nodes WHERE id = ?",
        [id]
      );
      if (exists.rows.length > 0) {
        queue.push([id, 0]);
        visited.add(id);
        reachable.add(id);
      }
    }

    // Build edge type filter for SQL
    let edgeTypeFilter = "";
    const edgeTypeParams: string[] = [];
    if (edgeTypes !== null && edgeTypes.length > 0) {
      const placeholders = edgeTypes.map(() => "?").join(",");
      edgeTypeFilter = ` AND type IN (${placeholders})`;
      edgeTypeParams.push(...edgeTypes);
    }

    // BFS traversal
    while (queue.length > 0) {
      const [nodeId, depth] = queue.shift()!;

      if (depth >= maxDepth) {
        continue;
      }

      // Get neighbor IDs based on direction
      const neighborIds: string[] = [];

      if (direction === "out" || direction === "both") {
        const sql = `SELECT target_id FROM edges WHERE source_id = ?${edgeTypeFilter}`;
        const result = this.db.execute(sql, [nodeId, ...edgeTypeParams]);
        for (const row of result.rows) {
          neighborIds.push((row as { target_id: string }).target_id);
        }
      }

      if (direction === "in" || direction === "both") {
        const sql = `SELECT source_id FROM edges WHERE target_id = ?${edgeTypeFilter}`;
        const result = this.db.execute(sql, [nodeId, ...edgeTypeParams]);
        for (const row of result.rows) {
          neighborIds.push((row as { source_id: string }).source_id);
        }
      }

      // Add unvisited neighbors to queue
      for (const neighborId of neighborIds) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          reachable.add(neighborId);
          queue.push([neighborId, depth + 1]);
        }
      }
    }

    return reachable;
  }
}
