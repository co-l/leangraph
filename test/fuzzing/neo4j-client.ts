/**
 * Neo4j client for fuzzing tests.
 * Executes Cypher queries against a Neo4j 3.5 instance.
 */

import neo4j, { Driver, Session } from "neo4j-driver";

export interface QueryResult {
  success: boolean;
  data?: unknown[];
  error?: string;
}

export class Neo4jClient {
  private driver: Driver | null = null;
  private session: Session | null = null;

  constructor(
    private uri: string = "bolt://localhost:7689",
    private user: string = "neo4j",
    private password: string = "fuzztest"
  ) {}

  async connect(): Promise<void> {
    this.driver = neo4j.driver(
      this.uri,
      neo4j.auth.basic(this.user, this.password)
    );
    // Verify connection
    await this.driver.verifyConnectivity();
    this.session = this.driver.session();
  }

  async execute(
    query: string,
    params: Record<string, unknown> = {}
  ): Promise<QueryResult> {
    if (!this.session) {
      throw new Error("Not connected. Call connect() first.");
    }

    try {
      const result = await this.session.run(query, params);
      const data = result.records.map((record) => {
        const obj: Record<string, unknown> = {};
        record.keys.forEach((key) => {
          obj[key] = this.convertNeo4jValue(record.get(key));
        });
        return obj;
      });
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Execute setup queries (like CREATE) that don't return meaningful data.
   */
  async setup(queries: string[]): Promise<void> {
    for (const query of queries) {
      const result = await this.execute(query);
      if (!result.success) {
        throw new Error(`Setup query failed: ${result.error}\nQuery: ${query}`);
      }
    }
  }

  /**
   * Clear all test data (nodes with LGT_ prefix labels).
   */
  async cleanup(): Promise<void> {
    await this.execute("MATCH (n) DETACH DELETE n");
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  /**
   * Convert Neo4j-specific types to plain JavaScript values.
   */
  private convertNeo4jValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return null;
    }

    // Neo4j Integer
    if (neo4j.isInt(value)) {
      const int = value as neo4j.Integer;
      // Return as number if safe, otherwise as string
      if (int.inSafeRange()) {
        return int.toNumber();
      }
      return int.toString();
    }

    // Neo4j Node
    if (value && typeof value === "object" && "labels" in value && "properties" in value) {
      const node = value as { labels: string[]; properties: Record<string, unknown> };
      return {
        _type: "node",
        labels: node.labels,
        properties: this.convertNeo4jValue(node.properties),
      };
    }

    // Neo4j Relationship
    if (value && typeof value === "object" && "type" in value && "properties" in value && "start" in value) {
      const rel = value as { type: string; properties: Record<string, unknown> };
      return {
        _type: "relationship",
        type: rel.type,
        properties: this.convertNeo4jValue(rel.properties),
      };
    }

    // Neo4j Path
    if (value && typeof value === "object" && "segments" in value) {
      return {
        _type: "path",
        // Simplified path representation
      };
    }

    // Neo4j Point
    if (value && typeof value === "object" && "x" in value && "y" in value && "srid" in value) {
      const point = value as { x: number; y: number; z?: number; srid: number };
      return {
        _type: "point",
        x: point.x,
        y: point.y,
        z: point.z,
        srid: point.srid,
      };
    }

    // Arrays
    if (Array.isArray(value)) {
      return value.map((v) => this.convertNeo4jValue(v));
    }

    // Plain objects (maps)
    if (value && typeof value === "object") {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        obj[k] = this.convertNeo4jValue(v);
      }
      return obj;
    }

    return value;
  }
}
