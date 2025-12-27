// Query Executor - Full pipeline: Cypher → Parse → Translate → Execute → Format

import {
  parse,
  ParseResult,
  Query,
  Clause,
  MatchClause,
  CreateClause,
  NodePattern,
  RelationshipPattern,
} from "./parser.js";
import { translate, TranslationResult, Translator } from "./translator.js";
import { GraphDatabase } from "./db.js";

// ============================================================================
// Types
// ============================================================================

export interface ExecutionResult {
  success: true;
  data: Record<string, unknown>[];
  meta: {
    count: number;
    time_ms: number;
  };
}

export interface ExecutionError {
  success: false;
  error: {
    message: string;
    position?: number;
    line?: number;
    column?: number;
  };
}

export type QueryResponse = ExecutionResult | ExecutionError;

// ============================================================================
// Executor
// ============================================================================

export class Executor {
  private db: GraphDatabase;

  constructor(db: GraphDatabase) {
    this.db = db;
  }

  /**
   * Execute a Cypher query and return formatted results
   */
  execute(cypher: string, params: Record<string, unknown> = {}): QueryResponse {
    const startTime = performance.now();

    try {
      // 1. Parse the Cypher query
      const parseResult = parse(cypher);
      if (!parseResult.success) {
        return {
          success: false,
          error: {
            message: parseResult.error.message,
            position: parseResult.error.position,
            line: parseResult.error.line,
            column: parseResult.error.column,
          },
        };
      }

      // 2. Check if this is a MATCH...CREATE pattern that needs multi-phase execution
      const multiPhaseResult = this.tryMultiPhaseExecution(parseResult.query, params);
      if (multiPhaseResult !== null) {
        const endTime = performance.now();
        return {
          success: true,
          data: multiPhaseResult,
          meta: {
            count: multiPhaseResult.length,
            time_ms: Math.round((endTime - startTime) * 100) / 100,
          },
        };
      }

      // 3. Standard single-phase execution: Translate to SQL
      const translator = new Translator(params);
      const translation = translator.translate(parseResult.query);

      // 4. Execute SQL statements
      let rows: Record<string, unknown>[] = [];
      const returnColumns = translation.returnColumns;

      this.db.transaction(() => {
        for (const stmt of translation.statements) {
          const result = this.db.execute(stmt.sql, stmt.params);

          // If this is a SELECT (RETURN clause), capture the results
          if (result.rows.length > 0 || stmt.sql.trim().toUpperCase().startsWith("SELECT")) {
            rows = result.rows;
          }
        }
      });

      // 5. Format results
      const formattedRows = this.formatResults(rows, returnColumns);

      const endTime = performance.now();

      return {
        success: true,
        data: formattedRows,
        meta: {
          count: formattedRows.length,
          time_ms: Math.round((endTime - startTime) * 100) / 100,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * Detect and handle MATCH...CREATE patterns that reference matched variables.
   * Returns null if this is not a multi-phase pattern, otherwise returns the result data.
   */
  private tryMultiPhaseExecution(
    query: Query,
    params: Record<string, unknown>
  ): Record<string, unknown>[] | null {
    // Find MATCH and CREATE clauses
    const matchClauses: MatchClause[] = [];
    const createClauses: CreateClause[] = [];
    let hasOtherClauses = false;

    for (const clause of query.clauses) {
      if (clause.type === "MATCH") {
        matchClauses.push(clause);
      } else if (clause.type === "CREATE") {
        createClauses.push(clause);
      } else {
        // For now, only handle pure MATCH...CREATE patterns
        hasOtherClauses = true;
      }
    }

    // Only handle MATCH followed by CREATE, no other clauses
    if (matchClauses.length === 0 || createClauses.length === 0 || hasOtherClauses) {
      return null;
    }

    // Collect variables defined in MATCH clauses
    const matchedVariables = new Set<string>();
    for (const matchClause of matchClauses) {
      for (const pattern of matchClause.patterns) {
        this.collectVariablesFromPattern(pattern, matchedVariables);
      }
    }

    // Check if CREATE references any matched variables
    const referencedMatchVars = new Set<string>();
    for (const createClause of createClauses) {
      for (const pattern of createClause.patterns) {
        this.findReferencedVariables(pattern, matchedVariables, referencedMatchVars);
      }
    }

    // If CREATE doesn't reference any matched variables, use standard execution
    if (referencedMatchVars.size === 0) {
      return null;
    }

    // Multi-phase execution needed
    return this.executeMultiPhase(matchClauses, createClauses, referencedMatchVars, params);
  }

  /**
   * Collect variable names from a pattern
   */
  private collectVariablesFromPattern(
    pattern: NodePattern | RelationshipPattern,
    variables: Set<string>
  ): void {
    if (this.isRelationshipPattern(pattern)) {
      if (pattern.source.variable) variables.add(pattern.source.variable);
      if (pattern.target.variable) variables.add(pattern.target.variable);
      if (pattern.edge.variable) variables.add(pattern.edge.variable);
    } else {
      if (pattern.variable) variables.add(pattern.variable);
    }
  }

  /**
   * Find variables in CREATE that reference MATCH variables
   */
  private findReferencedVariables(
    pattern: NodePattern | RelationshipPattern,
    matchedVars: Set<string>,
    referenced: Set<string>
  ): void {
    if (this.isRelationshipPattern(pattern)) {
      // Source node references a matched variable if it has no label
      if (pattern.source.variable && !pattern.source.label && matchedVars.has(pattern.source.variable)) {
        referenced.add(pattern.source.variable);
      }
      // Target node references a matched variable if it has no label
      if (pattern.target.variable && !pattern.target.label && matchedVars.has(pattern.target.variable)) {
        referenced.add(pattern.target.variable);
      }
    }
  }

  /**
   * Execute a MATCH...CREATE pattern in multiple phases
   */
  private executeMultiPhase(
    matchClauses: MatchClause[],
    createClauses: CreateClause[],
    referencedVars: Set<string>,
    params: Record<string, unknown>
  ): Record<string, unknown>[] {
    // Phase 1: Execute MATCH to get actual node IDs
    const matchQuery: Query = {
      clauses: [
        ...matchClauses,
        {
          type: "RETURN" as const,
          items: Array.from(referencedVars).map((v) => ({
            expression: { type: "function" as const, functionName: "ID", args: [{ type: "variable" as const, variable: v }] },
            alias: `_id_${v}`,
          })),
        },
      ],
    };

    const translator = new Translator(params);
    const matchTranslation = translator.translate(matchQuery);

    let matchedRows: Record<string, unknown>[] = [];
    for (const stmt of matchTranslation.statements) {
      const result = this.db.execute(stmt.sql, stmt.params);
      if (result.rows.length > 0) {
        matchedRows = result.rows;
      }
    }

    // If no nodes matched, return empty - nothing to create
    if (matchedRows.length === 0) {
      return [];
    }

    // Phase 2: For each matched row, execute CREATE with actual node IDs
    this.db.transaction(() => {
      for (const row of matchedRows) {
        // Build a map of variable -> actual node ID
        const resolvedIds: Record<string, string> = {};
        for (const v of referencedVars) {
          resolvedIds[v] = row[`_id_${v}`] as string;
        }

        // Execute CREATE for this matched row
        for (const createClause of createClauses) {
          this.executeCreateWithResolvedIds(createClause, resolvedIds, params);
        }
      }
    });

    return [];
  }

  /**
   * Execute a CREATE clause with pre-resolved node IDs for referenced variables
   */
  private executeCreateWithResolvedIds(
    createClause: CreateClause,
    resolvedIds: Record<string, string>,
    params: Record<string, unknown>
  ): void {
    for (const pattern of createClause.patterns) {
      if (this.isRelationshipPattern(pattern)) {
        this.createRelationshipWithResolvedIds(pattern, resolvedIds, params);
      } else {
        // Simple node creation - use standard translation
        const nodeQuery: Query = { clauses: [{ type: "CREATE", patterns: [pattern] }] };
        const translator = new Translator(params);
        const translation = translator.translate(nodeQuery);
        for (const stmt of translation.statements) {
          this.db.execute(stmt.sql, stmt.params);
        }
      }
    }
  }

  /**
   * Create a relationship where some endpoints reference pre-existing nodes
   */
  private createRelationshipWithResolvedIds(
    rel: RelationshipPattern,
    resolvedIds: Record<string, string>,
    params: Record<string, unknown>
  ): void {
    let sourceId: string;
    let targetId: string;

    // Determine source node ID
    if (rel.source.variable && resolvedIds[rel.source.variable]) {
      sourceId = resolvedIds[rel.source.variable];
    } else if (rel.source.label) {
      // Create new source node
      sourceId = crypto.randomUUID();
      const props = this.resolveProperties(rel.source.properties || {}, params);
      this.db.execute(
        "INSERT INTO nodes (id, label, properties) VALUES (?, ?, ?)",
        [sourceId, rel.source.label, JSON.stringify(props)]
      );
    } else {
      throw new Error(`Cannot resolve source node: ${rel.source.variable}`);
    }

    // Determine target node ID
    if (rel.target.variable && resolvedIds[rel.target.variable]) {
      targetId = resolvedIds[rel.target.variable];
    } else if (rel.target.label) {
      // Create new target node
      targetId = crypto.randomUUID();
      const props = this.resolveProperties(rel.target.properties || {}, params);
      this.db.execute(
        "INSERT INTO nodes (id, label, properties) VALUES (?, ?, ?)",
        [targetId, rel.target.label, JSON.stringify(props)]
      );
    } else {
      throw new Error(`Cannot resolve target node: ${rel.target.variable}`);
    }

    // Swap source/target for left-directed relationships
    const [actualSource, actualTarget] =
      rel.edge.direction === "left" ? [targetId, sourceId] : [sourceId, targetId];

    // Create edge
    const edgeId = crypto.randomUUID();
    const edgeType = rel.edge.type || "";
    const edgeProps = this.resolveProperties(rel.edge.properties || {}, params);

    this.db.execute(
      "INSERT INTO edges (id, type, source_id, target_id, properties) VALUES (?, ?, ?, ?, ?)",
      [edgeId, edgeType, actualSource, actualTarget, JSON.stringify(edgeProps)]
    );
  }

  /**
   * Resolve parameter references in properties
   */
  private resolveProperties(
    props: Record<string, unknown>,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "parameter" &&
        "name" in value
      ) {
        resolved[key] = params[value.name as string];
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  /**
   * Type guard for relationship patterns
   */
  private isRelationshipPattern(pattern: NodePattern | RelationshipPattern): pattern is RelationshipPattern {
    return "source" in pattern && "edge" in pattern && "target" in pattern;
  }

  /**
   * Format raw database results into a more usable structure
   */
  private formatResults(
    rows: Record<string, unknown>[],
    returnColumns?: string[]
  ): Record<string, unknown>[] {
    return rows.map((row) => {
      const formatted: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(row)) {
        formatted[key] = this.deepParseJson(value);
      }

      return formatted;
    });
  }

  /**
   * Recursively parse JSON strings in a value
   */
  private deepParseJson(value: unknown): unknown {
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        // Recursively process if it's an object or array
        if (typeof parsed === "object" && parsed !== null) {
          return this.deepParseJson(parsed);
        }
        return parsed;
      } catch {
        // Not valid JSON, return as-is
        return value;
      }
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.deepParseJson(item));
    }

    if (typeof value === "object" && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.deepParseJson(v);
      }
      return result;
    }

    return value;
  }
}

// ============================================================================
// Convenience function
// ============================================================================

export function executeQuery(
  db: GraphDatabase,
  cypher: string,
  params: Record<string, unknown> = {}
): QueryResponse {
  return new Executor(db).execute(cypher, params);
}
