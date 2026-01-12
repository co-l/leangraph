/**
 * Leangraph client for fuzzing tests.
 * Executes Cypher queries against the local leangraph implementation.
 */

import { GraphDatabase } from "../../src/db.js";
import { Executor, QueryResponse } from "../../src/executor.js";

export interface QueryResult {
  success: boolean;
  data?: unknown[];
  error?: string;
}

export class LeangraphClient {
  private db: GraphDatabase;
  private executor: Executor;

  constructor() {
    this.db = new GraphDatabase(":memory:");
    this.db.initialize();
    this.executor = new Executor(this.db);
  }

  execute(
    query: string,
    params: Record<string, unknown> = {}
  ): QueryResult {
    const response: QueryResponse = this.executor.execute(query, params);

    if (response.success) {
      return {
        success: true,
        data: this.normalizeData(response.data),
      };
    } else {
      return {
        success: false,
        error: response.error.message,
      };
    }
  }

  /**
   * Execute setup queries (like CREATE) that don't return meaningful data.
   */
  setup(queries: string[]): void {
    for (const query of queries) {
      const result = this.execute(query);
      if (!result.success) {
        throw new Error(`Setup query failed: ${result.error}\nQuery: ${query}`);
      }
    }
  }

  /**
   * Clear all data and reset the database.
   */
  cleanup(): void {
    this.execute("MATCH (n) DETACH DELETE n");
  }

  /**
   * Reset database completely (new in-memory instance).
   */
  reset(): void {
    this.db.close();
    this.db = new GraphDatabase(":memory:");
    this.db.initialize();
    this.executor = new Executor(this.db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Normalize data for comparison (handle BigInt, etc.).
   */
  private normalizeData(data: unknown[]): unknown[] {
    return data.map((row) => this.normalizeValue(row));
  }

  private normalizeValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return null;
    }

    // Convert BigInt to number
    if (typeof value === "bigint") {
      return Number(value);
    }

    // Arrays
    if (Array.isArray(value)) {
      return value.map((v) => this.normalizeValue(v));
    }

    // Objects
    if (value && typeof value === "object") {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        obj[k] = this.normalizeValue(v);
      }
      return obj;
    }

    return value;
  }
}
