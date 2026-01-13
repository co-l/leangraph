/**
 * Result comparison logic for fuzzing tests.
 * Compares query results between Neo4j and leangraph.
 */

import type { QueryResult } from "./neo4j-client.js";
import type { Category, Feature } from "./query-generator.js";

export interface ComparisonResult {
  query: string;
  category: Category;
  feature: Feature;
  status: "pass" | "fail" | "neo4j_error" | "skip";
  neo4jResult: QueryResult;
  leangraphResult: QueryResult;
  mismatch?: string;
  setup?: string[];
}

/**
 * Check if a query has an explicit ORDER BY clause.
 */
function hasOrderBy(query: string): boolean {
  // Case-insensitive check for ORDER BY
  return /\bORDER\s+BY\b/i.test(query);
}

/**
 * Check if a query is non-deterministic and should be skipped.
 * Non-deterministic queries produce different results on each run.
 */
function isNonDeterministic(query: string): boolean {
  // rand() returns different random values
  if (/\brand\s*\(\s*\)/i.test(query)) {
    return true;
  }
  // SKIP without ORDER BY depends on internal storage order
  if (/\bSKIP\b/i.test(query) && !hasOrderBy(query)) {
    return true;
  }
  // collect() without ORDER BY - result order depends on internal row order
  if (/\bcollect\s*\(/i.test(query) && !hasOrderBy(query)) {
    return true;
  }
  return false;
}

/**
 * Compare results from Neo4j and leangraph.
 */
export function compareResults(
  query: string,
  category: Category,
  feature: Feature,
  neo4j: QueryResult,
  leangraph: QueryResult,
  setup?: string[]
): ComparisonResult {
  // Skip non-deterministic queries (rand(), SKIP without ORDER BY)
  if (isNonDeterministic(query)) {
    return {
      query,
      category,
      feature,
      status: "skip",
      neo4jResult: neo4j,
      leangraphResult: leangraph,
      mismatch: "Non-deterministic query (skipped)",
      setup,
    };
  }

  // If Neo4j failed, this isn't a valid test case
  if (!neo4j.success) {
    return {
      query,
      category,
      feature,
      status: "neo4j_error",
      neo4jResult: neo4j,
      leangraphResult: leangraph,
      mismatch: `Neo4j error: ${neo4j.error}`,
      setup,
    };
  }

  // If leangraph failed but Neo4j succeeded, that's a bug
  if (!leangraph.success) {
    return {
      query,
      category,
      feature,
      status: "fail",
      neo4jResult: neo4j,
      leangraphResult: leangraph,
      mismatch: `Leangraph error: ${leangraph.error}`,
      setup,
    };
  }

  // Both succeeded - compare data
  // If no ORDER BY, compare as unordered sets (order doesn't matter)
  const requireOrder = hasOrderBy(query);
  const dataMatch = compareData(neo4j.data!, leangraph.data!, requireOrder);
  if (!dataMatch.match) {
    return {
      query,
      category,
      feature,
      status: "fail",
      neo4jResult: neo4j,
      leangraphResult: leangraph,
      mismatch: dataMatch.reason,
      setup,
    };
  }

  return {
    query,
    category,
    feature,
    status: "pass",
    neo4jResult: neo4j,
    leangraphResult: leangraph,
    setup,
  };
}

interface DataComparison {
  match: boolean;
  reason?: string;
}

/**
 * Extract values from a row object, ignoring column names.
 * Returns values in a consistent order (sorted by key name).
 */
function extractRowValues(row: unknown): unknown[] {
  if (row === null || row === undefined) {
    return [row];
  }
  if (typeof row !== "object" || Array.isArray(row)) {
    return [row];
  }
  const obj = row as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return keys.map((k) => obj[k]);
}

/**
 * Compare two rows by their values only, ignoring column names.
 * This handles cosmetic differences like "toLower" vs "tolower" in column names.
 */
function compareRowValues(
  neo4jRow: unknown,
  leangraphRow: unknown
): DataComparison {
  const neo4jValues = extractRowValues(neo4jRow);
  const leangraphValues = extractRowValues(leangraphRow);

  if (neo4jValues.length !== leangraphValues.length) {
    return {
      match: false,
      reason: `Column count mismatch: Neo4j=${neo4jValues.length}, Leangraph=${leangraphValues.length}`,
    };
  }

  // Compare each value
  for (let i = 0; i < neo4jValues.length; i++) {
    const valMatch = compareValues(neo4jValues[i], leangraphValues[i]);
    if (!valMatch.match) {
      return {
        match: false,
        reason: `Column ${i}: ${valMatch.reason}`,
      };
    }
  }

  return { match: true };
}

/**
 * Compare two result data arrays.
 * If requireOrder is false, compare as unordered sets.
 * Uses value-only comparison to ignore cosmetic column name differences.
 */
function compareData(
  neo4j: unknown[],
  leangraph: unknown[],
  requireOrder: boolean
): DataComparison {
  // Check row count
  if (neo4j.length !== leangraph.length) {
    return {
      match: false,
      reason: `Row count mismatch: Neo4j=${neo4j.length}, Leangraph=${leangraph.length}`,
    };
  }

  if (requireOrder) {
    // Compare each row in order (by values only)
    for (let i = 0; i < neo4j.length; i++) {
      const rowMatch = compareRowValues(neo4j[i], leangraph[i]);
      if (!rowMatch.match) {
        return {
          match: false,
          reason: `Row ${i}: ${rowMatch.reason}`,
        };
      }
    }
  } else {
    // Compare as unordered sets - each Neo4j row must have a matching Leangraph row
    const usedIndices = new Set<number>();

    for (let i = 0; i < neo4j.length; i++) {
      let found = false;
      for (let j = 0; j < leangraph.length; j++) {
        if (usedIndices.has(j)) continue;
        const rowMatch = compareRowValues(neo4j[i], leangraph[j]);
        if (rowMatch.match) {
          usedIndices.add(j);
          found = true;
          break;
        }
      }
      if (!found) {
        return {
          match: false,
          reason: `No matching row found for Neo4j row ${i}: ${JSON.stringify(neo4j[i])}`,
        };
      }
    }
  }

  return { match: true };
}

/**
 * Compare two values with tolerance for floating point and type differences.
 */
function compareValues(a: unknown, b: unknown): DataComparison {
  // Handle nulls
  if (a === null && b === null) {
    return { match: true };
  }
  if (a === null || b === null) {
    return {
      match: false,
      reason: `Null mismatch: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
    };
  }

  // Handle numbers with tolerance
  if (typeof a === "number" && typeof b === "number") {
    // Handle NaN
    if (Number.isNaN(a) && Number.isNaN(b)) {
      return { match: true };
    }
    // Handle Infinity
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      if (a === b) {
        return { match: true };
      }
      return {
        match: false,
        reason: `Infinity mismatch: ${a} vs ${b}`,
      };
    }
    // Tolerance for floating point comparison
    const tolerance = Math.max(Math.abs(a), Math.abs(b)) * 1e-9 + 1e-9;
    if (Math.abs(a - b) <= tolerance) {
      return { match: true };
    }
    return {
      match: false,
      reason: `Number mismatch: ${a} vs ${b}`,
    };
  }

  // Handle strings
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) {
      return { match: true };
    }
    return {
      match: false,
      reason: `String mismatch: "${a}" vs "${b}"`,
    };
  }

  // Handle booleans
  if (typeof a === "boolean" && typeof b === "boolean") {
    if (a === b) {
      return { match: true };
    }
    return {
      match: false,
      reason: `Boolean mismatch: ${a} vs ${b}`,
    };
  }

  // Handle arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return {
        match: false,
        reason: `Array length mismatch: ${a.length} vs ${b.length}`,
      };
    }
    for (let i = 0; i < a.length; i++) {
      const elemMatch = compareValues(a[i], b[i]);
      if (!elemMatch.match) {
        return {
          match: false,
          reason: `Array[${i}]: ${elemMatch.reason}`,
        };
      }
    }
    return { match: true };
  }

  // Handle objects (maps, nodes, relationships)
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;

    // Handle Neo4j node comparison
    if (aObj._type === "node" || bObj._type === "node") {
      return compareNodes(aObj, bObj);
    }

    // Handle Neo4j relationship comparison
    if (aObj._type === "relationship" || bObj._type === "relationship") {
      return compareRelationships(aObj, bObj);
    }

    // Regular object comparison
    const aKeys = Object.keys(aObj).sort();
    const bKeys = Object.keys(bObj).sort();

    if (aKeys.length !== bKeys.length) {
      return {
        match: false,
        reason: `Object key count mismatch: ${aKeys.length} vs ${bKeys.length}`,
      };
    }

    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) {
        return {
          match: false,
          reason: `Object key mismatch: "${aKeys[i]}" vs "${bKeys[i]}"`,
        };
      }
      const valMatch = compareValues(aObj[aKeys[i]], bObj[bKeys[i]]);
      if (!valMatch.match) {
        return {
          match: false,
          reason: `Object["${aKeys[i]}"]: ${valMatch.reason}`,
        };
      }
    }
    return { match: true };
  }

  // Type mismatch
  return {
    match: false,
    reason: `Type mismatch: ${typeof a} vs ${typeof b}`,
  };
}

/**
 * Compare Neo4j node representations.
 * Focuses on labels and properties, ignoring internal IDs.
 */
function compareNodes(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): DataComparison {
  const aIsNeo4jNode =
    a._type === "node" && Array.isArray(a.labels) && typeof a.properties === "object";
  const bIsNeo4jNode =
    b._type === "node" && Array.isArray(b.labels) && typeof b.properties === "object";

  // If both sides are Neo4j-style nodes, compare labels + properties.
  if (aIsNeo4jNode && bIsNeo4jNode) {
    const aLabels = (a.labels as string[]) || [];
    const bLabels = (b.labels as string[]) || [];

    if (aLabels.length !== bLabels.length) {
      return {
        match: false,
        reason: `Node label count mismatch: ${aLabels.length} vs ${bLabels.length}`,
      };
    }

    const sortedA = [...aLabels].sort();
    const sortedB = [...bLabels].sort();
    for (let i = 0; i < sortedA.length; i++) {
      if (sortedA[i] !== sortedB[i]) {
        return {
          match: false,
          reason: `Node label mismatch: ${sortedA[i]} vs ${sortedB[i]}`,
        };
      }
    }

    return compareValues(a.properties, b.properties);
  }

  // LeanGraph returns nodes as flat property maps (with internal _nf_* keys).
  // When comparing against Neo4j nodes, treat the flat object as "properties".
  const neo = aIsNeo4jNode ? a : bIsNeo4jNode ? b : null;
  const other = neo === a ? b : neo === b ? a : null;

  if (neo && other) {
    const otherPropsRaw =
      other && typeof other === "object" && "properties" in other
        ? (other as Record<string, unknown>).properties
        : other;

    if (otherPropsRaw && typeof otherPropsRaw === "object" && !Array.isArray(otherPropsRaw)) {
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(otherPropsRaw as Record<string, unknown>)) {
        if (k.startsWith("_nf_")) continue;
        cleaned[k] = v;
      }
      return compareValues(neo.properties, cleaned);
    }

    return compareValues(neo.properties, otherPropsRaw);
  }

  // Fallback: compare properties if present.
  return compareValues(a.properties, b.properties);
}

/**
 * Compare Neo4j relationship representations.
 * Focuses on type and properties, ignoring internal IDs.
 */
function compareRelationships(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): DataComparison {
  // Compare type
  if (a.type !== b.type) {
    return {
      match: false,
      reason: `Relationship type mismatch: ${a.type} vs ${b.type}`,
    };
  }

  // Compare properties
  return compareValues(a.properties, b.properties);
}

/**
 * Format a ComparisonResult for display.
 */
export function formatResult(result: ComparisonResult): string {
  const statusIcon =
    result.status === "pass" ? "✓" : result.status === "fail" ? "✗" : "⚠";

  let output = `${statusIcon} [${result.category}/${result.feature}]\n`;
  output += `  Query: ${result.query}\n`;

  if (result.status !== "pass") {
    output += `  Mismatch: ${result.mismatch}\n`;
    if (result.setup?.length) {
      output += `  Setup: ${result.setup.join("; ")}\n`;
    }
  }

  return output;
}
