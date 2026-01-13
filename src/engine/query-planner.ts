/**
 * Query Planner - Analyzes Cypher AST to determine if a query
 * can use the hybrid execution engine.
 */

import {
  Query,
  MatchClause,
  WhereCondition,
  NodePattern,
  RelationshipPattern,
  Expression,
  PropertyValue,
} from "../parser.js";
import { VarLengthPatternParams } from "./hybrid-executor.js";
import { MemoryNode, Direction } from "./memory-graph.js";

/** Default max depth for unbounded variable-length paths */
const DEFAULT_MAX_DEPTH = 50;

export interface HybridAnalysisResult {
  /** Whether the query is suitable for hybrid execution */
  suitable: boolean;
  /** Extracted parameters for HybridExecutor (if suitable) */
  params?: VarLengthPatternParams;
  /** Reason why the query is not suitable (for debugging) */
  reason?: string;
}

/**
 * Analyze a parsed query to determine if it can use the hybrid executor.
 * Returns extracted parameters if suitable, or a reason if not.
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

  if (relPatterns.length !== 2) {
    return { suitable: false, reason: "Expected exactly 2 relationship patterns" };
  }

  const [firstRel, secondRel] = relPatterns;

  // Extract anchor node info (first node in the pattern)
  const anchorInfo = extractNodeInfo(firstRel.source, params);
  if (!anchorInfo) {
    return { suitable: false, reason: "Anchor node must have a label" };
  }

  // Extract middle node info
  const middleInfo = extractNodeInfo(firstRel.target, params);
  if (!middleInfo) {
    return { suitable: false, reason: "Middle node must have a label" };
  }

  // Extract final node info
  const finalInfo = extractNodeInfo(secondRel.target, params);
  if (!finalInfo) {
    return { suitable: false, reason: "Final node must have a label" };
  }

  // Extract variable-length edge info
  const varEdge = firstRel.edge;
  const varEdgeType = varEdge.type || null;
  const varMinDepth = varEdge.minHops ?? 1;
  const varMaxDepth = varEdge.maxHops ?? DEFAULT_MAX_DEPTH;
  const varDirection = edgeDirectionToDirection(varEdge.direction);

  // Extract final edge info
  const finalEdge = secondRel.edge;
  const finalEdgeType = finalEdge.type || "";
  const finalDirection = edgeDirectionToDirection(finalEdge.direction);

  // Get the middle node variable for WHERE filter extraction
  const middleVar = firstRel.target.variable || "";

  // Convert WHERE clause to filter function
  const middleFilter = convertWhereToFilter(matchClause.where, middleVar, params);
  if (middleFilter === null && matchClause.where) {
    return { suitable: false, reason: "WHERE clause references multiple nodes or uses unsupported expressions" };
  }

  return {
    suitable: true,
    params: {
      anchorLabel: anchorInfo.label,
      anchorProps: anchorInfo.properties,
      varEdgeType,
      varMinDepth,
      varMaxDepth,
      varDirection,
      middleLabel: middleInfo.label,
      middleFilter: middleFilter || undefined,
      finalEdgeType,
      finalDirection,
      finalLabel: finalInfo.label,
    },
  };
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
 * Check if a query's structure matches the hybrid-compatible pattern:
 * (a:Label)-[*min..max]->(b:Label)-[:TYPE]->(c:Label)
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
  const hasReturn = query.clauses.some((c) => c.type === "RETURN");
  if (!hasReturn) {
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

  // Must have exactly 2 relationship patterns
  if (relPatterns.length !== 2) {
    return false;
  }

  const [firstRel, secondRel] = relPatterns;

  // First relationship must be variable-length
  const firstHasVarLength =
    firstRel.edge.minHops !== undefined || firstRel.edge.maxHops !== undefined;
  if (!firstHasVarLength) {
    return false;
  }

  // Second relationship must NOT be variable-length
  const secondHasVarLength =
    secondRel.edge.minHops !== undefined || secondRel.edge.maxHops !== undefined;
  if (secondHasVarLength) {
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
