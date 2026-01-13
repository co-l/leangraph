/**
 * openCypher TCK Test Runner
 * 
 * Runs the openCypher Technology Compatibility Kit tests against LeanGraph.
 * This provides a comprehensive compliance test suite for Cypher support.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as path from "path";
import { GraphDatabase } from "../../src/db";
import { Executor } from "../../src/executor";
import { parseAllFeatures, getStats, TCKScenario, ParsedFeature } from "./tck-parser";
import { FAILING_TESTS } from "./failing-tests";
import { NEO4J35_BASELINE } from "./neo4j35-baseline";
import { QUERY_OVERRIDES } from "./query-overrides";
import { valuesMatch, extractColumns, rowsMatch } from "./tck-utils";

const TCK_PATH = path.join(__dirname, "openCypher/tck/features");

// Environment variable to run all tests including known failing ones
// Usage: TCK_TEST_ALL=1 pnpm test -- --run
const TCK_TEST_ALL = process.env.TCK_TEST_ALL === "1";

// Parse all TCK features
const allFeatures = parseAllFeatures(TCK_PATH);
const stats = getStats(allFeatures);

// Only log mode when testing all (including known failing)
if (TCK_TEST_ALL) {
  console.log(`\n📊 TCK Mode: Testing ALL (including known failing tests)\n`);
}

// Track results for summary
const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  errors: [] as { scenario: string; error: string }[],
};



// Track which tests from FAILING_TESTS actually passed (only when TCK_TEST_ALL is set)
const unexpectedlyPassed: string[] = [];

/**
 * Run a single TCK scenario
 */
function runScenario(scenario: TCKScenario, db: GraphDatabase, executor: Executor, testKey: string): void {
  // Skip Scenario Outlines (require template expansion)
  if (scenario.tags?.includes("outline")) {
    // Note: This case shouldn't happen as outlines are expanded in tck-parser
    return;
  }
  
  // Check for query overrides (used for JavaScript limitations like large integers)
  const override = QUERY_OVERRIDES.get(testKey);
  
  // Get setup queries, query, and expected result (with override support)
  const setupQueries = override?.setup ?? scenario.setupQueries;
  const query = override?.query ?? scenario.query;
  const expectResult = override?.expectResult ?? scenario.expectResult;
  
  // Run setup queries
  for (const setup of setupQueries) {
    try {
      executor.execute(setup);
    } catch (e) {
      throw new Error(`Setup failed: ${setup}\n${e}`);
    }
  }
  
  // Run the test query
  if (scenario.expectError) {
    // Expect an error - executor returns { success: false } instead of throwing
    const result = executor.execute(query, scenario.params);
    expect(result.success).toBe(false);
  } else {
    const result = executor.execute(query, scenario.params);
    
    if (!result.success) {
      throw new Error(`Query failed: ${result.error.message}\nQuery: ${query}`);
    }
    
    if (scenario.expectEmpty) {
      expect(result.data).toHaveLength(0);
    } else if (expectResult) {
      const { columns, rows, ordered } = expectResult;
      
      // Extract relevant columns from actual results
      const actualRows = result.data.map(row => extractColumns(row, columns));
      
      // Compare
      const match = rowsMatch(rows, actualRows, ordered);
      if (!match) {
        console.log("\nExpected columns:", columns);
        console.log("Expected rows:", JSON.stringify(rows, null, 2));
        console.log("Actual rows:", JSON.stringify(actualRows, null, 2));
        console.log("Raw result:", JSON.stringify(result.data, null, 2));
      }
      expect(match).toBe(true);
    }
  }
  
  // Note: results.passed is now tracked in the test function after runScenario completes
}

// Group scenarios by category for organized testing
const featuresByCategory = new Map<string, ParsedFeature[]>();
for (const feature of allFeatures) {
  const category = path.dirname(feature.file).split("/").slice(-2).join("/");
  if (!featuresByCategory.has(category)) {
    featuresByCategory.set(category, []);
  }
  featuresByCategory.get(category)!.push(feature);
}

// Run all TCK categories
const priorityCategories = [
  // Core clauses
  "clauses/match",
  "clauses/match-where",
  "clauses/create", 
  "clauses/return",
  "clauses/return-orderby",
  "clauses/return-skip-limit",
  "clauses/delete",
  "clauses/set",
  "clauses/remove",
  "clauses/merge",
  "clauses/with",
  "clauses/with-where",
  "clauses/with-orderBy",
  "clauses/with-skip-limit",
  "clauses/unwind",
  "clauses/union",
  // "clauses/call", // Not yet supported - CALL procedures
  // Expressions
  "expressions/aggregation",
  "expressions/boolean",
  "expressions/comparison",
  "expressions/conditional",
  "expressions/existentialSubqueries",
  "expressions/graph",
  "expressions/list",
  "expressions/literals",
  "expressions/map",
  "expressions/mathematical",
  "expressions/null",
  "expressions/path",
  "expressions/pattern",
  "expressions/precedence",
  "expressions/quantifier",
  "expressions/string",
  "expressions/temporal",
  "expressions/typeConversion",
  // Use cases
  "useCases/countingSubgraphMatches",
  "useCases/triadicSelection",
];

describe("openCypher TCK", () => {
  let db: GraphDatabase;
  let executor: Executor;

  beforeEach(() => {
    db = new GraphDatabase(":memory:");
    db.initialize();
    executor = new Executor(db);
  });

  afterEach(() => {
    db.close();
  });

  // Run priority categories first
  for (const category of priorityCategories) {
    const features = featuresByCategory.get(category);
    if (!features) continue;

    describe(category, () => {
      for (const feature of features) {
        // Skip empty features
        if (feature.scenarios.length === 0) continue;
        
        // Check if any scenarios are in the baseline
        const hasBaselineTests = feature.scenarios.some(scenario => {
          const testKey = scenario.exampleIndex !== undefined
            ? `${category} > ${feature.name}|${scenario.index}:${scenario.exampleIndex}`
            : `${category} > ${feature.name}|${scenario.index}`;
          return NEO4J35_BASELINE.has(testKey);
        });
        
        if (!hasBaselineTests) continue;
        
        describe(feature.name, () => {
          for (const scenario of feature.scenarios) {
            // Build test key - include example index for expanded outline scenarios
            const testKey = scenario.exampleIndex !== undefined
              ? `${category} > ${feature.name}|${scenario.index}:${scenario.exampleIndex}`
              : `${category} > ${feature.name}|${scenario.index}`;
            
            // Not in Neo4j 3.5 baseline? Don't create a test at all
            if (!NEO4J35_BASELINE.has(testKey)) {
              continue;
            }
            
            const isKnownFailing = FAILING_TESTS.has(testKey);
            
            // Build test name - include example index for expanded outlines
            const testName = scenario.exampleIndex !== undefined
              ? `[${scenario.index}:${scenario.exampleIndex}] ${scenario.name}`
              : `[${scenario.index}] ${scenario.name}`;
            
            // Skip known failing tests unless TCK_TEST_ALL is set
            const shouldSkip = isKnownFailing && !TCK_TEST_ALL;
            const testFn = shouldSkip ? it.skip : it;
            
            if (shouldSkip) {
              results.skipped++;
            }
            
            testFn(testName, () => {
              // Fresh DB for each test
              db = new GraphDatabase(":memory:");
              db.initialize();
              executor = new Executor(db);
              
              try {
                runScenario(scenario, db, executor, testKey);
                if (TCK_TEST_ALL && isKnownFailing) {
                  unexpectedlyPassed.push(testKey);
                }
              } catch (error) {
                results.failed++;
                results.errors.push({
                  scenario: testKey,
                  error: error instanceof Error ? error.message : String(error),
                });
                throw error;
              } finally {
                db.close();
              }
            });
          }
        });
      }
    });
  }
});

// Summary at the end (only show errors and fixed tests, vitest handles pass/fail counts)
afterAll(() => {
  if (results.errors.length > 0) {
    console.log(`\n   First 10 errors:`);
    for (const err of results.errors.slice(0, 10)) {
      console.log(`   - ${err.scenario}: ${err.error.slice(0, 100)}`);
    }
  }
  
  // Report tests that were in FAILING_TESTS but actually passed
  if (TCK_TEST_ALL && unexpectedlyPassed.length > 0) {
    console.log(`\n🎉 Tests from FAILING_TESTS that now PASS (${unexpectedlyPassed.length}):`);
    console.log(`   These can be removed from failing-tests.ts:\n`);
    for (const testKey of unexpectedlyPassed) {
      console.log(`   // "${testKey}",`);
    }
    console.log("");
  }
});
