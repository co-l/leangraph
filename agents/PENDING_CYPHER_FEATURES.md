# LeanGraph - Cypher Fuzzing & Bug Fix Agent

## Overview

This agent discovers Cypher compatibility issues via fuzzing against Neo4j 3.5 and fixes them using TDD. It runs in a continuous loop: **discover → evaluate → confirm → fix → commit**.

All bugs are tracked in `test/fuzzing/failures.json` with these statuses:
- `fail` - Bug needs fixing
- `resolved` - Bug has been fixed
- `wontfix` - Intentionally skipped (with reason)

---

## Workflow Overview

1. **Discovery** - Run fuzzer to find new bugs (always run first)
2. **Evaluation** - Analyze each bug's worth and complexity
3. **User Confirmation** - Ask before proceeding with fix
4. **TDD Fix** - Add test → see fail → fix → see green
5. **Commit** - Mark resolved, commit & push

---

## Phase 1: Discovery (Always Run First)

Before working on existing bugs, run the fuzzer to discover new issues.

### 1.1 Start Neo4j

```bash
npm run fuzz:docker
```

Wait ~30 seconds for startup, then verify:

```bash
docker logs leangraph-fuzz-neo4j 2>&1 | tail -5
```

### 1.2 Run Fuzzer

Run broad coverage first:

```bash
npm run fuzz:run -- --count 200 --append
```

Then focus on specific features to maximize coverage:

```bash
npm run fuzz:run -- --count 100 --features functions --append
npm run fuzz:run -- --count 100 --features expressions --append
npm run fuzz:run -- --count 100 --features match,aggregations --append
npm run fuzz:run -- --count 100 --features with,where --append
npm run fuzz:run -- --count 100 --features case,comprehensions --append
```

Use different seeds for variety:

```bash
npm run fuzz:run -- --count 100 --seed 12345 --append
npm run fuzz:run -- --count 100 --seed 67890 --append
```

### 1.3 Stop Neo4j

```bash
npm run fuzz:stop
```

### Available Features

| Feature | Description |
|---------|-------------|
| `literals` | Numbers, strings, booleans, null, lists, maps |
| `expressions` | Arithmetic, string concat, comparisons |
| `functions` | Built-in functions (toUpper, abs, size, etc.) |
| `match` | MATCH patterns with labels and properties |
| `create` | CREATE node/relationship patterns |
| `with` | WITH clause piping |
| `where` | WHERE filtering |
| `orderby` | ORDER BY, SKIP, LIMIT |
| `aggregations` | count, sum, avg, collect, etc. |
| `unwind` | UNWIND list expansion |
| `case` | CASE WHEN expressions |
| `comprehensions` | List comprehensions |

---

## Phase 2: Evaluate Bugs

Read `test/fuzzing/failures.json` and count bugs by status:

```bash
cd /home/conrad/dev/leangraph && tsx -e "
const fs = require('fs');
const failures = JSON.parse(fs.readFileSync('test/fuzzing/failures.json', 'utf-8'));
const byStatus = {};
failures.forEach(f => { byStatus[f.status] = (byStatus[f.status] || 0) + 1; });
console.log('Status counts:', byStatus);
const unfixed = failures.filter(f => f.status === 'fail');
console.log('\nUnfixed bugs:', unfixed.length);
unfixed.forEach((f, i) => {
  console.log(\`\n\${i+1}. [\${f.category}/\${f.feature}] \${f.query}\`);
  console.log(\`   Mismatch: \${f.mismatch}\`);
  if (f.setup?.length) console.log(\`   Setup: \${f.setup.join('; ')}\`);
});
"
```

For each bug, assess:

1. **Real bug or edge case?**
   - Does Neo4j define clear, documented behavior?
   - Is this undefined behavior that varies between versions?

2. **Complexity**
   - Parser change (tokenizer, AST)?
   - Translator change (SQL generation)?
   - Executor change (multi-phase, result processing)?

3. **Impact**
   - How common is this query pattern in real-world usage?
   - Does it block a specific use case?

4. **Root cause grouping**
   - Are multiple failures caused by the same underlying issue?
   - Fix the root cause to resolve multiple bugs at once.

---

## Phase 3: User Confirmation

**Before fixing each bug, present it to the user and ask for confirmation.**

Show the user:
- The Cypher query
- Expected result (Neo4j)
- Actual result (LeanGraph)
- Setup queries if any
- Your assessment of complexity and impact

Ask: **"Should I fix this bug?"**

Options:
- **Fix now** - Proceed with TDD workflow
- **Skip (wontfix)** - Mark as intentionally skipped
- **Investigate more** - Need more context before deciding

### Marking as Wontfix

If the user chooses to skip, update the entry in `failures.json`:

```json
{
  "status": "wontfix",
  "skipReason": "Edge case: undefined behavior for mixed-type arrays"
}
```

---

## Phase 4: TDD Workflow

### 4.1 Add the Test

In `test/cypherqueries.test.ts`, add the test at the end of the file:

```typescript
it("supports [feature description]", async () => {
  // Setup if needed
  await db.query("CREATE (:Person {name: 'Alice'})");
  
  // Test the specific query
  const result = await db.query("RETURN ...");
  expect(result).toEqual([{ ... }]);
});
```

### 4.2 Run the Test (Expect Failure)

```bash
npm test -- -t "supports [feature]"
```

Verify the test fails with the expected error.

### 4.3 Fix the Code

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

### 4.4 Verify All Tests Pass

```bash
npm test
```

All tests must be green before proceeding.

### 4.5 Update the JSON File

Set the status of the fixed bug to `resolved` in `test/fuzzing/failures.json`.

### 4.6 Commit & Push

```bash
git add -A
git commit -m "feat: implement [feature description]"
git push
```

---

## Key Files

| File | Purpose |
|------|---------|
| `test/fuzzing/failures.json` | Bug tracking (fail/resolved/wontfix) |
| `test/fuzzing/runner.ts` | Fuzzer runner |
| `test/cypherqueries.test.ts` | Feature tests |
| `src/parser.ts` | Cypher tokenizer and parser |
| `src/translator.ts` | AST to SQL translation |
| `src/executor.ts` | Query execution engine |

---

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
