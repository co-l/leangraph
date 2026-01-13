export type DatabaseType = "leangraph" | "neo4j" | "memgraph";
export type Scale = "micro" | "quick" | "full";
export type QueryCategory = "lookup" | "pattern" | "aggregation" | "traversal" | "write";

export interface ScaleConfig {
  users: number;
  items: number;
  events: number;
  ownsEdges: number;
  triggeredEdges: number;
  relatedToEdges: number;
}

export interface QueryDefinition {
  name: string;
  cypher: string;
  params: () => Record<string, unknown>;
  category: QueryCategory;
}

export interface TimingStats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  samples: number;
}

export interface QueryResult {
  name: string;
  category: QueryCategory;
  timing: TimingStats;
}

export interface LoadResult {
  timeSeconds: number;
  nodesLoaded: number;
  edgesLoaded: number;
}

export interface ResourceUsage {
  diskBytes: number;
  ramBytes: number;
}

export interface DatabaseResult {
  database: DatabaseType;
  version: string;
  totalDurationSeconds: number;
  load: LoadResult;
  resources: ResourceUsage;  // LeanGraph: delta from baseline, Docker: max of samples
  coldStartMs: number;
  queries: QueryResult[];
}

export interface BenchmarkResult {
  timestamp: string;
  scale: Scale | string;  // Scale enum or custom string like "custom (50K)"
  config: ScaleConfig;
  totalNodes: number;
  totalEdges: number;
  databases: DatabaseResult[];
}

export interface Runner {
  name: DatabaseType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  execute(cypher: string, params?: Record<string, unknown>): Promise<unknown>;
  clear(): Promise<void>;
  getVersion(): Promise<string>;
}

export interface Loader {
  name: DatabaseType;
  load(config: ScaleConfig, onProgress?: (msg: string) => void): Promise<LoadResult>;
}

// Global Score Types
export type ScoreCategory = "advantage" | "competitive" | "tradeoff";

export interface MetricComparison {
  metric: string;
  category: ScoreCategory;
  leangraphValue: number;
  comparisons: {
    database: DatabaseType;
    value: number;
    ratio: number; // >1 means LeanGraph is better
    formatted: string; // e.g., "2.3x faster"
  }[];
}

export interface GlobalScore {
  advantages: MetricComparison[]; // LeanGraph >2x better
  competitive: MetricComparison[]; // Within 0.5x-2x
  tradeoffs: MetricComparison[]; // LeanGraph >2x worse
  summary: {
    wins: number;
    competitive: number;
    tradeoffs: number;
    total: number;
  };
}
