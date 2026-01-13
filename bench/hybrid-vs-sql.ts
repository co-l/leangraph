#!/usr/bin/env npx tsx
/**
 * Benchmark: Hybrid Executor vs SQL Executor
 *
 * Compares performance of the hybrid execution approach against
 * the standard SQL translation for variable-length path queries.
 *
 * Usage:
 *   npx tsx bench/hybrid-vs-sql.ts
 *   npx tsx bench/hybrid-vs-sql.ts --nodes 20000 --edges 100000
 */

import { GraphDatabase } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { HybridExecutor } from "../src/engine/index.js";

// ============================================================================
// Configuration
// ============================================================================

interface BenchmarkConfig {
  nodeCount: number;
  avgEdgesPerNode: number;
  warmupRuns: number;
  benchmarkRuns: number;
  varLengthDepths: number[];
}

const DEFAULT_CONFIG: BenchmarkConfig = {
  nodeCount: 10_000,
  avgEdgesPerNode: 5,
  warmupRuns: 3,
  benchmarkRuns: 10,
  varLengthDepths: [1, 2, 3],
};

// ============================================================================
// Data Generation
// ============================================================================

function generateTestGraph(db: GraphDatabase, config: BenchmarkConfig): void {
  console.log(`\nGenerating test graph with ${config.nodeCount} nodes...`);
  const startTime = performance.now();

  const personCount = Math.floor(config.nodeCount * 0.7);
  const companyCount = config.nodeCount - personCount;

  // Generate Person nodes
  for (let i = 0; i < personCount; i++) {
    db.insertNode(`p${i}`, "Person", {
      name: `Person_${i}`,
      age: 20 + (i % 50),
      city: ["NYC", "LA", "Chicago", "Seattle", "Austin"][i % 5],
    });
  }

  // Generate Company nodes
  for (let i = 0; i < companyCount; i++) {
    db.insertNode(`c${i}`, "Company", {
      name: `Company_${i}`,
      founded: 1990 + (i % 35),
      size: ["small", "medium", "large"][i % 3],
    });
  }

  // Generate KNOWS edges (Person -> Person)
  const knowsEdgeCount = Math.floor(personCount * config.avgEdgesPerNode * 0.8);
  for (let i = 0; i < knowsEdgeCount; i++) {
    const sourceIdx = i % personCount;
    const targetIdx = (sourceIdx + 1 + (i % (personCount - 1))) % personCount;
    db.insertEdge(`k${i}`, "KNOWS", `p${sourceIdx}`, `p${targetIdx}`, {
      since: 2010 + (i % 15),
    });
  }

  // Generate WORKS_AT edges (Person -> Company)
  const worksAtEdgeCount = Math.floor(personCount * 0.9); // 90% of people work
  for (let i = 0; i < worksAtEdgeCount; i++) {
    const personIdx = i % personCount;
    const companyIdx = i % companyCount;
    db.insertEdge(`w${i}`, "WORKS_AT", `p${personIdx}`, `c${companyIdx}`, {
      role: ["Engineer", "Manager", "Analyst", "Director"][i % 4],
    });
  }

  const duration = performance.now() - startTime;
  const totalEdges = knowsEdgeCount + worksAtEdgeCount;
  console.log(
    `Generated ${config.nodeCount} nodes and ${totalEdges} edges in ${duration.toFixed(0)}ms`
  );
}

// ============================================================================
// Benchmark Functions
// ============================================================================

interface BenchmarkResult {
  approach: string;
  depth: number;
  avgTimeMs: number;
  minTimeMs: number;
  maxTimeMs: number;
  resultCount: number;
}

function benchmarkSQL(
  sqlExecutor: Executor,
  depth: number,
  runs: number
): BenchmarkResult {
  const times: number[] = [];
  let resultCount = 0;

  const query = `
    MATCH (a:Person {name: 'Person_0'})-[:KNOWS*1..${depth}]->(b:Person)-[:WORKS_AT]->(c:Company)
    WHERE b.age > 25
    RETURN a.name, b.name, c.name
  `;

  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const result = sqlExecutor.execute(query);
    const elapsed = performance.now() - start;
    times.push(elapsed);

    if (result.success) {
      resultCount = result.data.length;
    }
  }

  return {
    approach: "SQL",
    depth,
    avgTimeMs: times.reduce((a, b) => a + b, 0) / times.length,
    minTimeMs: Math.min(...times),
    maxTimeMs: Math.max(...times),
    resultCount,
  };
}

function benchmarkHybrid(
  hybridExecutor: HybridExecutor,
  depth: number,
  runs: number
): BenchmarkResult {
  const times: number[] = [];
  let resultCount = 0;

  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const results = hybridExecutor.executeVarLengthPattern({
      anchorLabel: "Person",
      anchorProps: { name: "Person_0" },
      varEdgeType: "KNOWS",
      varMinDepth: 1,
      varMaxDepth: depth,
      varDirection: "out",
      middleLabel: "Person",
      middleFilter: (node) => (node.properties.age as number) > 25,
      finalEdgeType: "WORKS_AT",
      finalDirection: "out",
      finalLabel: "Company",
    });
    const elapsed = performance.now() - start;
    times.push(elapsed);
    resultCount = results.length;
  }

  return {
    approach: "Hybrid",
    depth,
    avgTimeMs: times.reduce((a, b) => a + b, 0) / times.length,
    minTimeMs: Math.min(...times),
    maxTimeMs: Math.max(...times),
    resultCount,
  };
}

// ============================================================================
// Reporting
// ============================================================================

function printResults(results: BenchmarkResult[]): void {
  console.log("\n" + "=".repeat(80));
  console.log("BENCHMARK RESULTS");
  console.log("=".repeat(80));

  // Group by depth
  const depths = [...new Set(results.map((r) => r.depth))].sort((a, b) => a - b);

  for (const depth of depths) {
    const depthResults = results.filter((r) => r.depth === depth);
    console.log(`\n--- Depth 1..${depth} ---`);

    for (const result of depthResults) {
      console.log(
        `  ${result.approach.padEnd(8)} | ` +
        `avg: ${result.avgTimeMs.toFixed(2).padStart(8)}ms | ` +
        `min: ${result.minTimeMs.toFixed(2).padStart(8)}ms | ` +
        `max: ${result.maxTimeMs.toFixed(2).padStart(8)}ms | ` +
        `results: ${result.resultCount}`
      );
    }

    // Calculate speedup
    const sqlResult = depthResults.find((r) => r.approach === "SQL");
    const hybridResult = depthResults.find((r) => r.approach === "Hybrid");
    if (sqlResult && hybridResult) {
      const speedup = sqlResult.avgTimeMs / hybridResult.avgTimeMs;
      const faster = speedup > 1 ? "Hybrid" : "SQL";
      const ratio = speedup > 1 ? speedup : 1 / speedup;
      console.log(`  >> ${faster} is ${ratio.toFixed(2)}x faster`);

      // Verify correctness
      if (sqlResult.resultCount !== hybridResult.resultCount) {
        console.log(
          `  ⚠️  WARNING: Result count mismatch! SQL=${sqlResult.resultCount}, Hybrid=${hybridResult.resultCount}`
        );
      }
    }
  }

  console.log("\n" + "=".repeat(80));
}

// ============================================================================
// Main
// ============================================================================

function parseArgs(): Partial<BenchmarkConfig> {
  const args = process.argv.slice(2);
  const config: Partial<BenchmarkConfig> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--nodes" && args[i + 1]) {
      config.nodeCount = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--edges" && args[i + 1]) {
      config.avgEdgesPerNode = parseInt(args[i + 1], 10) / (config.nodeCount ?? DEFAULT_CONFIG.nodeCount);
      i++;
    } else if (args[i] === "--runs" && args[i + 1]) {
      config.benchmarkRuns = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Usage: npx tsx bench/hybrid-vs-sql.ts [options]

Options:
  --nodes <n>   Number of nodes (default: 10000)
  --edges <n>   Total edge count (default: nodes * 5)
  --runs <n>    Benchmark runs per test (default: 10)
  --help        Show this help
`);
      process.exit(0);
    }
  }

  return config;
}

async function main() {
  const config = { ...DEFAULT_CONFIG, ...parseArgs() };

  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║          Hybrid vs SQL Executor Benchmark                      ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(`\nConfiguration:`);
  console.log(`  Nodes: ${config.nodeCount}`);
  console.log(`  Avg edges/node: ${config.avgEdgesPerNode}`);
  console.log(`  Warmup runs: ${config.warmupRuns}`);
  console.log(`  Benchmark runs: ${config.benchmarkRuns}`);
  console.log(`  Depths to test: ${config.varLengthDepths.join(", ")}`);

  // Create in-memory database
  const db = new GraphDatabase(":memory:");
  db.initialize();

  // Generate test data
  generateTestGraph(db, config);

  // Create executors
  const sqlExecutor = new Executor(db);
  const hybridExecutor = new HybridExecutor(db);

  // Warmup
  console.log("\nWarming up...");
  for (let i = 0; i < config.warmupRuns; i++) {
    benchmarkSQL(sqlExecutor, 1, 1);
    benchmarkHybrid(hybridExecutor, 1, 1);
  }

  // Run benchmarks
  console.log("\nRunning benchmarks...");
  const results: BenchmarkResult[] = [];

  for (const depth of config.varLengthDepths) {
    console.log(`  Testing depth 1..${depth}...`);
    results.push(benchmarkSQL(sqlExecutor, depth, config.benchmarkRuns));
    results.push(benchmarkHybrid(hybridExecutor, depth, config.benchmarkRuns));
  }

  // Print results
  printResults(results);

  // Cleanup
  db.close();
}

main().catch(console.error);
