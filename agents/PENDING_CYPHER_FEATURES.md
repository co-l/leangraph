# LeanGraph - Pending Cypher Features Guide

## Overview

This guide covers Cypher features that work in Neo4j 3.5 but are not yet implemented in LeanGraph. These were discovered through integration testing in real-world projects.

All pending tests are in `test/cypherqueries.test.ts` under the **"Pending Cypher Features"** describe block, marked with `it.skip()`.

## Feature Categories

| Category | Count | Complexity | Files to Modify |
|----------|-------|------------|-----------------|
| Parser Features | 6 | High | `parser.ts` |
| Expression Context | 3 | Medium | `translator.ts`, `executor.ts` |
| Runtime Behaviors | 3 | Medium-High | `translator.ts`, `executor.ts` |
| Missing Functions | 1 | Low | `translator.ts` |

### Parser Features (6 tests)

| Feature | Query Example | Current Error |
|---------|---------------|---------------|
| Regex `=~` | `WHERE p.name =~ '.*ob'` | `Unexpected character '~'` |
| `reduce()` | `reduce(acc = 0, x IN list \| acc + x)` | `Expected RPAREN, got PIPE` |
| `filter()` | `filter(x IN list WHERE x > 2)` | `Expected RPAREN, got KEYWORD 'WHERE'` |
| `extract()` | `extract(x IN list \| x.name)` | `Expected RPAREN, got PIPE` |
| `shortestPath()` | `MATCH p = shortestPath((a)-[*]->(b))` | `Expected LPAREN, got IDENTIFIER` |
| `FOREACH` | `FOREACH (x IN list \| SET n.val = x)` | `Unexpected token 'FOREACH'` |

### Expression Context (3 tests)

| Feature | Query Example | Current Error |
|---------|---------------|---------------|
| CASE in WHERE | `WHERE CASE WHEN x > 0 THEN true END` | `Unknown expression type in WHERE: case` |
| CASE in SET | `SET n.cat = CASE WHEN ... END` | `Cannot evaluate expression of type case` |
| `exists()` pattern | `RETURN exists((n)-[:REL]->())` | `Expected expression, got COLON` |

### Runtime Behaviors (4 tests)

| Feature | Query Example | Current Error |
|---------|---------------|---------------|
| OPTIONAL MATCH + DELETE | `OPTIONAL MATCH (n)-[r]->() DELETE n` | `no such column: n0.id` |
| UNWIND + MATCH | `UNWIND list AS x MATCH (n {prop: x})` | `Too few parameter values` |
| `duration()` | `duration('P1D')` | `Too many parameter values` |

### Missing Functions (1 test)

| Function | Query Example | Current Error |
|----------|---------------|---------------|
| `sign()` | `RETURN sign(-10)` | `Unknown function: SIGN` |

## TDD Workflow

### 1. Pick a Feature

Start with the easiest wins:
```bash
# Recommended order:
# 1. sign() function - just add to translator.ts
# 2. Negative list indexing - SQLite JSON path handling
# 3. CASE in WHERE/SET - extend existing CASE support
# 4. Parser features - more complex, tackle one at a time
```

### 2. Enable the Test

In `test/cypherqueries.test.ts`, remove `.skip`:

```typescript
// Before
it.skip("supports sign() function", async () => { ... });

// After
it("supports sign() function", async () => { ... });
```

### 3. Run the Test

```bash
# Run just the pending features tests
npm test -- -t "Pending Cypher Features"

# Run a specific test
npm test -- -t "supports sign"

# Run with verbose output
npm test -- -t "supports sign" --reporter=verbose
```

### 4. Fix the Code

Debug interactively:

```bash
cd /home/conrad/dev/leangraph && LEANGRAPH_PROJECT=test-debug tsx -e "
(async () => {
  const { LeanGraph } = require('./src/index.ts');
  const db = await LeanGraph({ dataPath: ':memory:' });
  
  // Test your fix
  const result = await db.query('RETURN sign(-10) as s');
  console.log('Result:', JSON.stringify(result, null, 2));
  
  db.close();
})();
"
```

Check parser output:

```bash
cd /home/conrad/dev/leangraph && tsx -e "
const { parse } = require('./src/parser.ts');
const ast = parse('RETURN sign(-10) as s');
console.log(JSON.stringify(ast, null, 2));
"
```

Check translator output:

```bash
cd /home/conrad/dev/leangraph && tsx -e "
const { Translator } = require('./src/translator.ts');
const { parse } = require('./src/parser.ts');
const query = 'RETURN sign(-10) as s';
const ast = parse(query);
const translator = new Translator({});
const result = translator.translate(ast.query);
console.log('SQL:', result.sql);
console.log('Params:', result.params);
"
```

### 5. Verify All Tests Pass

```bash
npm test
```

### 6. Commit

```bash
git add -A
git commit -m "feat: implement sign() function"
```

## Implementation Guides

### Adding a New Function (e.g., `sign()`)

Functions may need changes in **both** `translator.ts` (SQL generation) and `executor.ts` (runtime evaluation). Check both files.

1. **translator.ts** - Find the math functions section (~line 5990) and add a new `if` block:

```typescript
// SIGN: returns -1, 0, or 1 based on the sign of the number
if (expr.functionName === "SIGN") {
  if (expr.args && expr.args.length > 0) {
    const argResult = this.translateFunctionArg(expr.args[0]);
    tables.push(...argResult.tables);
    params.push(...argResult.params);
    return { sql: `SIGN(${argResult.sql})`, tables, params };
  }
  throw new Error("sign requires an argument");
}
```

2. **executor.ts** - If the function needs runtime evaluation (e.g., in complex expressions), add to `evaluateFunction()` (~line 3970):

```typescript
case "SIGN": {
  if (args.length === 0) return null;
  const value = this.evaluateExpressionInRow(args[0], row, params);
  if (typeof value !== "number") return null;
  return Math.sign(value);
}
```

**Tip:** Search for similar functions (e.g., `ABS`, `ROUND`) to find the exact locations.

### Adding a Parser Feature (e.g., `=~` regex)

1. **parser.ts** - Add `~` to tokenizer
2. **parser.ts** - Handle `=~` as a binary operator in `parseComparisonCondition()`
3. **translator.ts** - Translate to SQLite's `REGEXP` or `GLOB`

### Extending Expression Context (e.g., CASE in WHERE)

1. **translator.ts** - Add `case "case":` handling in `translateWhereExpression()`
2. Reuse existing `translateCaseExpression()` logic

### Runtime Fixes (e.g., negative indexing)

1. **translator.ts** - Modify list index translation
2. Handle negative indices by converting to `json_array_length() + index`

## Quick Commands

```bash
# Run pending features tests only
npm test -- -t "Pending Cypher Features"

# Run a specific category
npm test -- -t "Parser Features"
npm test -- -t "Expression Context"
npm test -- -t "Runtime Behaviors"
npm test -- -t "Missing Functions"

# Count remaining skipped tests
grep -c "it.skip" test/cypherqueries.test.ts

# List all skipped test names
grep "it.skip" test/cypherqueries.test.ts | sed 's/.*it.skip("\([^"]*\)".*/\1/'
```

## Key Files

| File | Purpose |
|------|---------|
| `test/cypherqueries.test.ts` | Pending feature tests (search for "Pending Cypher Features") |
| `src/parser.ts` | Cypher tokenizer and parser |
| `src/translator.ts` | AST to SQL translation |
| `src/executor.ts` | Query execution engine |

## Error Quick Reference

| Error Pattern | Likely Location |
|---------------|-----------------|
| `Unexpected character` | parser.ts tokenizer |
| `Unexpected token` | parser.ts parser |
| `Expected X, got Y` | parser.ts parser |
| `Unknown expression type` | translator.ts |
| `Cannot evaluate expression` | executor.ts |
| `Unknown function` | translator.ts |
| `no such column` | translator.ts SQL generation |
| `bad JSON path` | translator.ts JSON handling |
| `Too few/many parameter values` | translator.ts or executor.ts |

## Progress Tracking

When you complete a feature:

1. Remove `.skip` from the test
2. Run full test suite to ensure no regressions
3. Update this section with completion date

| Feature | Status | Completed |
|---------|--------|-----------|
| `sign()` | Done | 2026-01-12 |
| Negative list index | Done | 2026-01-12 |
| CASE in WHERE | Done | 2026-01-12 |
| CASE in SET | Done | 2026-01-12 |
| `exists()` pattern | Pending | - |
| OPTIONAL MATCH + DELETE | Pending | - |
| UNWIND + MATCH | Pending | - |
| `duration()` | Pending | - |
| Regex `=~` | Pending | - |
| `reduce()` | Pending | - |
| `filter()` | Pending | - |
| `extract()` | Pending | - |
| `shortestPath()` | Pending | - |
| `FOREACH` | Pending | - |
