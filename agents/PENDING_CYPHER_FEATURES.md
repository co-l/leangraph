# LeanGraph - Pending Cypher Features Guide

## Overview

This guide covers Cypher features that work in Neo4j 3.5 but are not yet implemented in LeanGraph. These were discovered through integration testing in real-world projects.

All pending tests are in `/home/conrad/tmp/leangraph-test/failures.json` where 'status'='failure'

## TDD Workflow

### 1. Pick a Feature

Look at how many failures are left in the json file and show it to me, then start with the first failure in the json file


### 2. Add the Test

In `test/cypherqueries.test.ts`, add the test at the end of the file
```typescript
it("supports sign() function", async () => { ... });
```

### 3. Run the Test

```bash
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

### 6. Update the JSON file

Set the 'status' of the fixed test as 'resolved'
 in /home/conrad/tmp/leangraph-test/failures.json

### 6. Commit & push

```bash
git add -A
git commit -m "feat: implement sign() function"
git push
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
