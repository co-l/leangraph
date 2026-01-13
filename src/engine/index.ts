/**
 * Hybrid Execution Engine
 *
 * This module provides a hybrid query execution approach that combines
 * SQL for efficient indexed lookups with in-memory graph traversal for
 * complex pattern matching.
 *
 * @example
 * ```typescript
 * import { HybridExecutor } from './engine';
 *
 * const executor = new HybridExecutor(db);
 * const results = executor.executeVarLengthPattern({
 *   anchorLabel: 'Person',
 *   anchorProps: { name: 'Alice' },
 *   varEdgeType: 'KNOWS',
 *   varMinDepth: 1,
 *   varMaxDepth: 3,
 *   varDirection: 'out',
 *   middleLabel: 'Person',
 *   middleFilter: (node) => node.properties.age > 25,
 *   finalEdgeType: 'WORKS_AT',
 *   finalDirection: 'out',
 *   finalLabel: 'Company',
 * });
 * ```
 */

// Core types
export type { Direction, Path, MemoryNode, MemoryEdge, NodeRow, EdgeRow } from "./memory-graph.js";
export type { SubgraphBounds, PropertyFilter } from "./subgraph-loader.js";
export type { VarLengthPatternParams, PatternResult } from "./hybrid-executor.js";
export type { HybridAnalysisResult } from "./query-planner.js";

// Classes
export { MemoryGraph } from "./memory-graph.js";
export { SubgraphLoader } from "./subgraph-loader.js";
export { HybridExecutor } from "./hybrid-executor.js";

// Query Planner functions
export {
  analyzeForHybrid,
  isHybridCompatiblePattern,
  extractNodeInfo,
  convertWhereToFilter,
} from "./query-planner.js";
