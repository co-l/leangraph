#!/usr/bin/env npx tsx
/**
 * Fuzzing test runner.
 * Generates random Cypher queries and compares execution between Neo4j and leangraph.
 *
 * Usage:
 *   npx tsx test/fuzzing/runner.ts --count 100
 *   npx tsx test/fuzzing/runner.ts --count 50 --seed 12345
 *   npx tsx test/fuzzing/runner.ts --features functions,expressions
 */

import { writeFileSync, existsSync, readFileSync } from "fs";
import { Neo4jClient } from "./neo4j-client.js";
import { LeangraphClient } from "./leangraph-client.js";
import { QueryGenerator, Feature } from "./query-generator.js";
import { compareResults, formatResult, ComparisonResult } from "./compare.js";

interface RunnerOptions {
  count: number;
  seed?: number;
  features?: Feature[];
  verbose: boolean;
  append: boolean;
}

function parseArgs(): RunnerOptions {
  const args = process.argv.slice(2);
  const options: RunnerOptions = {
    count: 100,
    verbose: false,
    append: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--count":
      case "-c":
        options.count = parseInt(args[++i], 10);
        break;
      case "--seed":
      case "-s":
        options.seed = parseInt(args[++i], 10);
        break;
      case "--features":
      case "-f":
        options.features = args[++i].split(",") as Feature[];
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--append":
      case "-a":
        options.append = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Fuzzing Test Runner

Usage:
  npx tsx test/fuzzing/runner.ts [options]

Options:
  -c, --count <n>       Number of queries to generate (default: 100)
  -s, --seed <n>        Random seed for reproducibility
  -f, --features <list> Comma-separated features to test
  -v, --verbose         Show all test results, not just failures
  -a, --append          Append to existing failures.json instead of overwriting
  -h, --help            Show this help

Features:
  literals, expressions, functions, match, create, with,
  where, orderby, aggregations, unwind, case, comprehensions

Examples:
  npx tsx test/fuzzing/runner.ts --count 100
  npx tsx test/fuzzing/runner.ts --count 50 --seed 12345
  npx tsx test/fuzzing/runner.ts --features functions,expressions
`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const seed = options.seed ?? Math.floor(Math.random() * 1000000);

  console.log(`\n🔍 Leangraph Fuzzing Test Runner`);
  console.log(`   Count: ${options.count} queries`);
  console.log(`   Seed: ${seed}`);
  if (options.features) {
    console.log(`   Features: ${options.features.join(", ")}`);
  }
  console.log();

  // Initialize clients
  const neo4j = new Neo4jClient();
  const leangraph = new LeangraphClient();

  console.log("📡 Connecting to Neo4j...");
  try {
    await neo4j.connect();
    console.log("   Connected to Neo4j at bolt://localhost:7689\n");
  } catch (err) {
    console.error("❌ Failed to connect to Neo4j:");
    console.error(
      "   Make sure Neo4j is running: npm run fuzz:docker\n"
    );
    console.error(`   Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Initialize generator
  const generator = new QueryGenerator({
    seed,
    features: options.features,
  });

  // Run tests
  const results: ComparisonResult[] = [];
  const failures: ComparisonResult[] = [];
  const neo4jErrors: ComparisonResult[] = [];

  let passCount = 0;
  let failCount = 0;
  let skipCount = 0;

  console.log("🧪 Running tests...\n");

  for (let i = 0; i < options.count; i++) {
    const generated = generator.generate();

    // Reset databases before each test
    try {
      await neo4j.cleanup();
      leangraph.reset();
    } catch {
      // Ignore cleanup errors
    }

    // Run setup queries if needed
    if (generated.needsSetup && generated.setup) {
      try {
        await neo4j.setup(generated.setup);
        leangraph.setup(generated.setup);
      } catch (err) {
        // Setup failed, skip this test
        if (options.verbose) {
          console.log(`⚠ Setup failed for: ${generated.query}`);
        }
        skipCount++;
        continue;
      }
    }

    // Execute on both systems
    const neo4jResult = await neo4j.execute(generated.query);
    const leangraphResult = leangraph.execute(generated.query);

    // Compare results
    const comparison = compareResults(
      generated.query,
      generated.category,
      generated.feature,
      neo4jResult,
      leangraphResult,
      generated.setup
    );

    results.push(comparison);

    switch (comparison.status) {
      case "pass":
        passCount++;
        if (options.verbose) {
          process.stdout.write(".");
        }
        break;
      case "fail":
        failCount++;
        failures.push(comparison);
        process.stdout.write("F");
        break;
      case "neo4j_error":
        skipCount++;
        neo4jErrors.push(comparison);
        if (options.verbose) {
          process.stdout.write("S");
        }
        break;
    }

    // Progress indicator every 10 tests
    if ((i + 1) % 50 === 0) {
      console.log(` [${i + 1}/${options.count}]`);
    }
  }

  console.log("\n");

  // Print summary
  console.log("📊 Results:");
  console.log(`   ✓ Pass: ${passCount}`);
  console.log(`   ✗ Fail: ${failCount}`);
  console.log(`   ⚠ Skip: ${skipCount} (Neo4j errors)\n`);

  // Print failures
  if (failures.length > 0) {
    console.log("❌ Failures:\n");
    for (const failure of failures) {
      console.log(formatResult(failure));
    }
  }

  // Load existing failures if appending
  let existingFailures: ComparisonResult[] = [];
  const outputPath = new URL("./failures.json", import.meta.url).pathname;

  if (options.append && existsSync(outputPath)) {
    try {
      const existing = readFileSync(outputPath, "utf-8");
      existingFailures = JSON.parse(existing);
      console.log(`📂 Loaded ${existingFailures.length} existing failures\n`);
    } catch {
      // Ignore parse errors
    }
  }

  // Deduplicate failures by query
  const allFailures = [...existingFailures];
  const existingQueries = new Set(existingFailures.map((f) => f.query));

  for (const failure of failures) {
    if (!existingQueries.has(failure.query)) {
      allFailures.push(failure);
      existingQueries.add(failure.query);
    }
  }

  // Write failures.json
  writeFileSync(outputPath, JSON.stringify(allFailures, null, 2));
  console.log(`💾 Wrote ${allFailures.length} failures to failures.json`);
  console.log(`   New failures: ${failures.length - (allFailures.length - existingFailures.length - failures.length)}`);

  // Cleanup
  await neo4j.close();
  leangraph.close();

  console.log("\n✨ Done!\n");
  console.log(`To reproduce these results, use: --seed ${seed}\n`);

  // Exit with error code if there were failures
  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
