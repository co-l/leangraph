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
  status: "pass" | "fail" | "neo4j_error";
  neo4jResult: QueryResult;
  leangraphResult: QueryResult;
  mismatch?: string;
  setup?: string[];
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
  const dataMatch = compareData(neo4j.data!, leangraph.data!);
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
 * Compare two result data arrays.
 */
function compareData(neo4j: unknown[], leangraph: unknown[]): DataComparison {
  // Check row count
  if (neo4j.length !== leangraph.length) {
    return {
      match: false,
      reason: `Row count mismatch: Neo4j=${neo4j.length}, Leangraph=${leangraph.length}`,
    };
  }

  // Compare each row
  for (let i = 0; i < neo4j.length; i++) {
    const rowMatch = compareValues(neo4j[i], leangraph[i]);
    if (!rowMatch.match) {
      return {
        match: false,
        reason: `Row ${i}: ${rowMatch.reason}`,
      };
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
  // Compare labels
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

  // Compare properties
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
