/**
 * Query Planner - Analyzes Cypher AST to determine if a query
 * can use the hybrid execution engine.
 * 
 * Supports generalized pattern chains with:
 *   - N nodes (arbitrary chain length)
 *   - Multiple variable-length edges
 *   - Var-length edges at any position
 */

import {
  Query,
  MatchClause,
  ReturnClause,
  WhereCondition,
  NodePattern,
  RelationshipPattern,
  Expression,
  PropertyValue,
} from "../parser.js";
import { PatternChainParams, ChainHop, ChainNode } from "./hybrid-executor.js";
import { MemoryNode, Direction } from "./memory-graph.js";

/** Default max depth for unbounded variable-length paths */
const DEFAULT_MAX_DEPTH = 50;

export interface HybridAnalysisResult {
  /** Whether the query is suitable for hybrid execution */
  suitable: boolean;
  /** Extracted parameters for HybridExecutor (if suitable) */
  params?: PatternChainParams;
  /** Reason why the query is not suitable (for debugging) */
  reason?: string;
}

/**
 * Analyze a parsed query to determine if it can use the hybrid executor.
 * Returns extracted parameters if suitable, or a reason if not.
 * 
 * Supports generalized pattern chains:
 *   (a)-[*]->(b)-[:R1]->(c)-[:R2]->(d)  -- N nodes
 *   (a)-[*]->(b)-[*]->(c)               -- multiple var-length
 */
export function analyzeForHybrid(
  query: Query,
  params: Record<string, unknown>
): HybridAnalysisResult {
  if (!isHybridCompatiblePattern(query)) {
    return { suitable: false, reason: "Query pattern not compatible with hybrid execution" };
  }

  // Extract the MATCH clause
  const matchClause = query.clauses.find((c) => c.type === "MATCH") as MatchClause;
  if (!matchClause) {
    return { suitable: false, reason: "No MATCH clause found" };
  }

  // Get the relationship patterns
  const relPatterns = matchClause.patterns.filter(
    (p): p is RelationshipPattern => "edge" in p
  );

  if (relPatterns.length < 1) {
    return { suitable: false, reason: "Need at least 1 relationship pattern" };
  }

  // Extract anchor node info (first node in the pattern)
  const anchorInfo = extractNodeInfo(relPatterns[0].source, params);
  if (!anchorInfo) {
    return { suitable: false, reason: "Anchor node must have a label" };
  }

  const anchorVar = relPatterns[0].source.variable || "node0";

  // Build the chain from relationship patterns
  const chain: Array<{ hop: ChainHop; node: ChainNode }> = [];
  
  // Track which variable the WHERE clause applies to (for now: single node)
  let filterTargetVar: string | null = null;
  let filterTargetIndex: number = -1;
  
  // Find which node the WHERE clause references (if any)
  if (matchClause.where) {
    filterTargetVar = findWhereTargetVar(matchClause.where, relPatterns);
  }

  for (let i = 0; i < relPatterns.length; i++) {
    const rel = relPatterns[i];
    
    // Extract edge info
    const edge = rel.edge;
    const isVarLength = edge.minHops !== undefined || edge.maxHops !== undefined;
    
    const hop: ChainHop = {
      edgeType: edge.type || null,
      direction: edgeDirectionToDirection(edge.direction),
      minHops: isVarLength ? (edge.minHops ?? 1) : 1,
      maxHops: isVarLength ? (edge.maxHops ?? DEFAULT_MAX_DEPTH) : 1,
    };

    // Extract target node info
    const targetInfo = extractNodeInfo(rel.target, params);
    if (!targetInfo) {
      return { suitable: false, reason: `Node at position ${i + 1} must have a label` };
    }

    const targetVar = rel.target.variable || `node${i + 1}`;
    
    // Check if this is the node WHERE applies to
    const whereFilter = (filterTargetVar === targetVar)
      ? convertWhereToFilter(matchClause.where, targetVar, params)
      : undefined;
    
    // If WHERE references this node but couldn't be converted, fail
    if (filterTargetVar === targetVar && whereFilter === null) {
      return { suitable: false, reason: "WHERE clause uses unsupported expressions" };
    }
    
    if (filterTargetVar === targetVar) {
      filterTargetIndex = i;
    }

    // Build filter from inline properties and/or WHERE clause
    const inlineProps = targetInfo.properties;
    const hasInlineProps = Object.keys(inlineProps).length > 0;
    
    let nodeFilter: ((node: MemoryNode) => boolean) | undefined;
    if (hasInlineProps && whereFilter) {
      // Combine inline property filter with WHERE filter
      nodeFilter = (node: MemoryNode) => {
        for (const [key, value] of Object.entries(inlineProps)) {
          if (node.properties[key] !== value) return false;
        }
        return whereFilter(node);
      };
    } else if (hasInlineProps) {
      // Only inline property filter
      nodeFilter = (node: MemoryNode) => {
        for (const [key, value] of Object.entries(inlineProps)) {
          if (node.properties[key] !== value) return false;
        }
        return true;
      };
    } else if (whereFilter) {
      nodeFilter = whereFilter;
    }

    const node: ChainNode = {
      variable: targetVar,
      label: targetInfo.label,
      filter: nodeFilter,
    };

    chain.push({ hop, node });
  }

  // If WHERE references a node that's not in the chain (e.g., anchor), fail for now
  if (matchClause.where && filterTargetVar && filterTargetIndex === -1 && filterTargetVar !== anchorVar) {
    return { suitable: false, reason: "WHERE clause references node not in chain or unsupported" };
  }

  return {
    suitable: true,
    params: {
      anchor: {
        variable: anchorVar,
        label: anchorInfo.label,
      },
      anchorProps: anchorInfo.properties,
      chain,
    },
  };
}

/**
 * Find which variable the WHERE clause references.
 * Returns null if WHERE references multiple nodes or an unknown variable.
 */
function findWhereTargetVar(
  where: WhereCondition,
  relPatterns: RelationshipPattern[]
): string | null {
  // Collect all variables from the pattern
  const allVars = new Set<string>();
  if (relPatterns[0]?.source.variable) {
    allVars.add(relPatterns[0].source.variable);
  }
  for (const rel of relPatterns) {
    if (rel.target.variable) {
      allVars.add(rel.target.variable);
    }
  }

  // Find which variable is referenced in WHERE
  const referencedVars = new Set<string>();
  collectReferencedVars(where, referencedVars);

  // Filter to only include known pattern variables
  const patternVars = [...referencedVars].filter(v => allVars.has(v));
  
  // We only support single-node WHERE for now
  if (patternVars.length === 1) {
    return patternVars[0];
  }
  
  return null;
}

/**
 * Collect all variable names referenced in a WHERE condition.
 */
function collectReferencedVars(condition: WhereCondition, vars: Set<string>): void {
  if (condition.left?.type === "property" && condition.left.variable) {
    vars.add(condition.left.variable);
  }
  if (condition.right?.type === "property" && condition.right.variable) {
    vars.add(condition.right.variable);
  }
  if (condition.conditions) {
    for (const c of condition.conditions) {
      collectReferencedVars(c, vars);
    }
  }
}

/**
 * Check if WHERE contains an equality filter on the anchor variable.
 * This indicates the anchor set will be small (good for hybrid).
 */
function hasAnchorEqualityFilter(where: WhereCondition, anchorVar: string): boolean {
  // Check if this condition is an equality comparison on the anchor
  if (where.type === "comparison" && where.operator === "=") {
    const leftIsAnchor = where.left?.type === "property" && where.left.variable === anchorVar;
    const rightIsAnchor = where.right?.type === "property" && where.right.variable === anchorVar;
    
    // One side should be anchor property, other side should be a value/param
    if (leftIsAnchor && where.right?.type !== "property") {
      return true;
    }
    if (rightIsAnchor && where.left?.type !== "property") {
      return true;
    }
  }
  
  // Check AND conditions (any equality filter is sufficient)
  if (where.type === "and" && where.conditions) {
    return where.conditions.some(c => hasAnchorEqualityFilter(c, anchorVar));
  }
  
  return false;
}

/**
 * Convert edge direction from parser format to Direction type.
 */
function edgeDirectionToDirection(direction: "left" | "right" | "none"): Direction {
  switch (direction) {
    case "right":
      return "out";
    case "left":
      return "in";
    case "none":
      return "both";
  }
}

/**
 * Check if an expression contains an aggregation function.
 */
function hasAggregationFunction(expr: Expression | undefined): boolean {
  if (!expr) return false;
  
  if (expr.type === "function") {
    const aggFunctions = ["count", "sum", "avg", "min", "max", "collect", "stdev", "stdevp"];
    // Check both name and functionName (parser uses different fields)
    const funcName = (expr.name || expr.functionName || "").toLowerCase();
    if (aggFunctions.includes(funcName)) {
      return true;
    }
    // Check arguments recursively
    if (expr.args) {
      return expr.args.some((arg: Expression) => hasAggregationFunction(arg));
    }
  }
  
  // Check for aggregation in nested expressions
  if (expr.type === "binary") {
    return hasAggregationFunction(expr.left) || hasAggregationFunction(expr.right);
  }
  
  return false;
}

/**
 * Check if a query's structure matches a hybrid-compatible pattern.
 * 
 * Supported patterns:
 *   (a:Label)-[*min..max]->(b:Label)-[:TYPE]->(c:Label)     -- original
 *   (a)-[*]->(b)-[:R1]->(c)-[:R2]->(d)                      -- longer chains
 *   (a)-[*]->(b)-[*]->(c)                                   -- multiple var-length
 *   (a)-[:R1]->(b)-[*]->(c)                                 -- var-length anywhere
 * 
 * Requirements:
 *   - No mutations (CREATE, SET, DELETE, MERGE)
 *   - Has RETURN clause
 *   - Exactly one MATCH clause
 *   - At least 1 relationship pattern
 *   - At least one variable-length edge
 *   - No relationship property predicates (not supported in hybrid)
 *   - All nodes must have labels (checked in analyzeForHybrid)
 */
export function isHybridCompatiblePattern(query: Query): boolean {
  // Must not have mutations
  const hasMutations = query.clauses.some((c) =>
    ["CREATE", "SET", "DELETE", "MERGE"].includes(c.type)
  );
  if (hasMutations) {
    return false;
  }

  // Must have RETURN
  const returnClause = query.clauses.find((c) => c.type === "RETURN") as ReturnClause | undefined;
  if (!returnClause) {
    return false;
  }

  // Must not have ORDER BY (not supported in hybrid)
  if (returnClause.orderBy && returnClause.orderBy.length > 0) {
    return false;
  }

  // Must not have aggregation functions in RETURN (not supported in hybrid)
  const hasAggregation = returnClause.items.some((item) => 
    hasAggregationFunction(item.expression)
  );
  if (hasAggregation) {
    return false;
  }

  // Must have exactly one MATCH clause
  const matchClauses = query.clauses.filter((c) => c.type === "MATCH" || c.type === "OPTIONAL_MATCH");
  if (matchClauses.length !== 1) {
    return false;
  }

  const matchClause = matchClauses[0] as MatchClause;

  // Get relationship patterns
  const relPatterns = matchClause.patterns.filter(
    (p): p is RelationshipPattern => "edge" in p
  );

  // Must have at least 1 relationship pattern
  if (relPatterns.length < 1) {
    return false;
  }

  // Suitable for hybrid if has at least one variable-length edge
  const hasVarLength = relPatterns.some(
    (rel) => rel.edge.minHops !== undefined || rel.edge.maxHops !== undefined
  );
  
  // Multi-hop fixed-length patterns (2+ hops) benefit from hybrid ONLY if
  // the anchor node is filtered (otherwise SQL join is more efficient)
  const isMultiHop = relPatterns.length >= 2;
  
  if (!hasVarLength && !isMultiHop) {
    return false;
  }
  
  // For multi-hop without var-length, require anchor filtering
  if (isMultiHop && !hasVarLength) {
    const anchorNode = relPatterns[0].source;
    const anchorVar = anchorNode.variable;
    
    // Check for inline property filter on anchor
    const hasInlineFilter = anchorNode.properties && Object.keys(anchorNode.properties).length > 0;
    
    // Check for WHERE clause filtering anchor with equality
    let hasWhereFilter = false;
    if (matchClause.where && anchorVar) {
      hasWhereFilter = hasAnchorEqualityFilter(matchClause.where, anchorVar);
    }
    
    if (!hasInlineFilter && !hasWhereFilter) {
      return false;
    }
  }

  // Must not have relationship property predicates (not supported in hybrid)
  const hasEdgeProperties = relPatterns.some(
    (rel) => rel.edge.properties && Object.keys(rel.edge.properties).length > 0
  );
  if (hasEdgeProperties) {
    return false;
  }

  return true;
}

/**
 * Extract node information (label, properties) from a NodePattern.
 */
export function extractNodeInfo(
  node: NodePattern,
  params: Record<string, unknown>
): { label: string; properties: Record<string, unknown> } | null {
  // Must have at least one label
  if (!node.label) {
    return null;
  }

  // Handle label as string or string[]
  const label = Array.isArray(node.label) ? node.label[0] : node.label;
  if (!label) {
    return null;
  }

  const properties: Record<string, unknown> = {};

  // Extract and resolve properties
  if (node.properties) {
    for (const [key, value] of Object.entries(node.properties)) {
      properties[key] = resolvePropertyValue(value, params);
    }
  }

  return { label, properties };
}

/**
 * Resolve a property value, handling parameter references.
 */
function resolvePropertyValue(
  value: PropertyValue,
  params: Record<string, unknown>
): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    if ("type" in value && value.type === "parameter") {
      const paramRef = value as { type: "parameter"; name: string };
      return params[paramRef.name];
    }
  }

  return value;
}

/**
 * Convert a WHERE condition to a filter function for the middle node.
 * Returns null if the condition references nodes other than the middle node,
 * or if it contains unsupported expressions.
 */
export function convertWhereToFilter(
  where: WhereCondition | undefined,
  middleVar: string,
  params: Record<string, unknown>
): ((node: MemoryNode) => boolean) | null {
  // No WHERE clause - return identity filter
  if (!where) {
    return () => true;
  }

  return convertCondition(where, middleVar, params);
}

/**
 * Convert a single WHERE condition to a filter function.
 */
function convertCondition(
  condition: WhereCondition,
  middleVar: string,
  params: Record<string, unknown>
): ((node: MemoryNode) => boolean) | null {
  switch (condition.type) {
    case "comparison":
      return convertComparison(condition, middleVar, params);

    case "and": {
      if (!condition.conditions) return null;
      const filters = condition.conditions.map((c) => convertCondition(c, middleVar, params));
      if (filters.some((f) => f === null)) return null;
      return (node) => filters.every((f) => f!(node));
    }

    case "or": {
      if (!condition.conditions) return null;
      const filters = condition.conditions.map((c) => convertCondition(c, middleVar, params));
      if (filters.some((f) => f === null)) return null;
      return (node) => filters.some((f) => f!(node));
    }

    case "isNotNull": {
      const propInfo = extractPropertyAccess(condition.left, middleVar);
      if (!propInfo) return null;
      return (node) => {
        const value = node.properties[propInfo.property];
        return value !== null && value !== undefined;
      };
    }

    case "isNull": {
      const propInfo = extractPropertyAccess(condition.left, middleVar);
      if (!propInfo) return null;
      return (node) => {
        const value = node.properties[propInfo.property];
        return value === null || value === undefined;
      };
    }

    default:
      // Unsupported condition type
      return null;
  }
}

/**
 * Convert a comparison condition to a filter function.
 */
function convertComparison(
  condition: WhereCondition,
  middleVar: string,
  params: Record<string, unknown>
): ((node: MemoryNode) => boolean) | null {
  if (!condition.left || !condition.right || !condition.operator) {
    return null;
  }

  // Check if left side is a property access on the middle node
  const propInfo = extractPropertyAccess(condition.left, middleVar);
  if (!propInfo) {
    return null;
  }

  // Extract the comparison value from the right side
  const rightValue = extractLiteralValue(condition.right, params);
  if (rightValue === undefined) {
    // Right side might reference another node - not supported
    return null;
  }

  const { property } = propInfo;
  const op = condition.operator;

  return (node) => {
    const leftValue = node.properties[property];
    return compareValues(leftValue, op, rightValue);
  };
}

/**
 * Extract property access info from an expression.
 * Returns null if the expression is not a property access on the target variable.
 */
function extractPropertyAccess(
  expr: Expression | undefined,
  targetVar: string
): { variable: string; property: string } | null {
  if (!expr) return null;

  if (expr.type === "property" && expr.variable === targetVar && expr.property) {
    return { variable: expr.variable, property: expr.property };
  }

  return null;
}

/**
 * Extract a literal value from an expression.
 * Returns undefined if the expression is not a literal or parameter.
 */
function extractLiteralValue(
  expr: Expression | undefined,
  params: Record<string, unknown>
): unknown {
  if (!expr) return undefined;

  if (expr.type === "literal") {
    return expr.value;
  }

  if (expr.type === "parameter" && expr.name) {
    return params[expr.name];
  }

  // Check for property access on a different node (not supported)
  if (expr.type === "property") {
    return undefined;
  }

  return undefined;
}

/**
 * Compare two values with the given operator.
 */
function compareValues(
  left: unknown,
  operator: "=" | "<>" | "<" | ">" | "<=" | ">=",
  right: unknown
): boolean {
  switch (operator) {
    case "=":
      return left === right;
    case "<>":
      return left !== right;
    case "<":
      return (left as number) < (right as number);
    case ">":
      return (left as number) > (right as number);
    case "<=":
      return (left as number) <= (right as number);
    case ">=":
      return (left as number) >= (right as number);
    default:
      return false;
  }
}
