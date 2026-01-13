import type { Scale, ScaleConfig } from "./types.js";
import * as path from "path";
import { fileURLToPath } from "url";

// Get benchmark directory path (works regardless of CWD)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCHMARK_DIR = path.resolve(__dirname, "..");

export const SCALES: Record<Scale, ScaleConfig> = {
  micro: {
    users: 1_000,
    items: 2_000,
    events: 5_000,
    ownsEdges: 2_000,
    triggeredEdges: 5_000,
    relatedToEdges: 1_000,
  },
  quick: {
    users: 20_000,
    items: 50_000,
    events: 100_000,
    ownsEdges: 50_000,
    triggeredEdges: 100_000,
    relatedToEdges: 30_000,
  },
  full: {
    users: 2_000_000,
    items: 5_000_000,
    events: 10_000_000,
    ownsEdges: 5_000_000,
    triggeredEdges: 10_000_000,
    relatedToEdges: 3_000_000,
  },
};

export const BENCHMARK_CONFIG = {
  // Warmup iterations before measuring
  warmupIterations: 10,

  // Measured iterations per query
  measuredIterations: 100,

  // Batch size for data loading
  batchSize: 10_000,

  // Connection settings
  neo4j: {
    uri: "bolt://localhost:17687",
    user: "neo4j",
    password: "benchmark123",
  },

  memgraph: {
    uri: "bolt://localhost:17688",
    user: "",
    password: "",
  },

  // Data paths (relative to benchmark directory)
  leangraphDataPath: path.join(BENCHMARK_DIR, "benchmark-data/leangraph.db"),
  neo4jDataPath: path.join(BENCHMARK_DIR, "benchmark-data/neo4j"),
  memgraphDataPath: path.join(BENCHMARK_DIR, "benchmark-data/memgraph"),

  // Categories for items
  categories: [
    "electronics",
    "clothing",
    "books",
    "home",
    "sports",
    "toys",
    "food",
    "health",
    "automotive",
    "garden",
  ],

  // Event types
  eventTypes: ["view", "click", "purchase", "share", "bookmark"],
};

export function getTotalNodes(config: ScaleConfig): number {
  return config.users + config.items + config.events;
}

export function getTotalEdges(config: ScaleConfig): number {
  return config.ownsEdges + config.triggeredEdges + config.relatedToEdges;
}

/**
 * Generate a scale config from a target node count.
 * Uses the same proportions as the predefined scales:
 * - users: 1x, items: 2x, events: 5x (total 8x)
 * - edges roughly match nodes
 */
export function configFromNodes(totalNodes: number): ScaleConfig {
  // Total nodes = users + items + events = 1x + 2x + 5x = 8x
  const users = Math.round(totalNodes / 8);
  const items = users * 2;
  const events = users * 5;
  
  return {
    users,
    items,
    events,
    ownsEdges: items,           // Each item owned by one user
    triggeredEdges: events,     // Each event triggered by one user
    relatedToEdges: users,      // Sparse item-to-item relationships
  };
}
