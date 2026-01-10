# LeanGraph - Performance Optimization Guide

The optimization plan is in `/OPTIMIZATION_PLAN.md`. This guide explains the workflow for implementing those optimizations.

## Workflow

Follow this workflow exactly:

1. **Pick an optimization** from `OPTIMIZATION_PLAN.md` (start with P0)
2. **Run baseline benchmark** - `npm run benchmark -- -s micro -d leangraph`
3. **Implement the fix** - follow the code changes in the plan
4. **Run tests** - `npm test` - must pass!
5. **Re-benchmark** - `npm run benchmark -- -s micro -d leangraph`
6. **Mark complete** - update checkbox in `OPTIMIZATION_PLAN.md`
7. **Commit and push**

### Example

```markdown
// In OPTIMIZATION_PLAN.md, change:
| P0 | SQLite performance pragmas | 2-3x | Low | [ ] |

// To:
| P0 | SQLite performance pragmas | 2-3x | Low | [x] |
```

## Quick Commands

```bash
# Run micro benchmark (fast, ~1 min)
npm run benchmark -- -s micro -d leangraph

# Run quick benchmark (more accurate, ~5 min)
npm run benchmark -- -s quick -d leangraph

# Run all tests
npm test

# Show generated SQL for a query
npm run tck 'Match3|1' -- --sql

# Run specific TCK test with verbose output
npm run tck 'Return6|11' -- -v
```

## Debugging SQL Performance

### See Generated SQL

```bash
cd /home/conrad/dev/leangraph && tsx -e "
const { Translator } = require('./src/translator.ts');
const { parse } = require('./src/parser.ts');
const query = \`MATCH (u:User {id: 'u1'})-[:OWNS]->(i:Item) RETURN i\`;
const ast = parse(query);
const translator = new Translator({});
const result = translator.translate(ast.query);
console.log('SQL:', result.statements[0].sql);
console.log('Params:', result.statements[0].params);
"
```

### Run EXPLAIN QUERY PLAN

```bash
cd /home/conrad/dev/leangraph && tsx -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(\`
  CREATE TABLE nodes (id TEXT PRIMARY KEY, label JSON, properties JSON);
  CREATE TABLE edges (id TEXT PRIMARY KEY, type TEXT, source_id TEXT, target_id TEXT, properties JSON);
  CREATE INDEX idx_edges_type ON edges(type);
  CREATE INDEX idx_edges_source ON edges(source_id);
  CREATE INDEX idx_edges_target ON edges(target_id);
\`);
const sql = \`SELECT * FROM nodes n0
  JOIN edges e0 ON e0.source_id = n0.id
  JOIN nodes n1 ON n1.id = e0.target_id
  WHERE json_extract(n0.properties, '$.id') = ?\`;
console.log(db.prepare('EXPLAIN QUERY PLAN ' + sql).all('u1'));
"
```

### Time a Query

```bash
cd /home/conrad/dev/leangraph && tsx -e "
(async () => {
  const { LeanGraph } = require('./src/index.ts');
  const db = await LeanGraph({ dataPath: ':memory:' });
  
  // Setup
  for (let i = 0; i < 1000; i++) {
    await db.execute(\`CREATE (u:User {id: 'u\${i}', name: 'User \${i}'})\`);
  }
  
  // Time query
  const start = performance.now();
  const result = await db.query('MATCH (u:User {id: \$id}) RETURN u', { id: 'u500' });
  console.log('Time:', (performance.now() - start).toFixed(2), 'ms');
  console.log('Results:', result.length);
  
  db.close();
})();
"
```

## Key Files

| File | What to Optimize |
|------|------------------|
| `src/db.ts:549-555` | SQLite pragmas, indexes |
| `src/db.ts:47-67` | Schema, index definitions |
| `src/db.ts:570-592` | Statement execution (add caching) |
| `src/executor.ts` | Query execution, batching, context cloning |
| `src/translator.ts` | SQL generation, join order |
| `src/parser.ts` | Tokenizer string allocation |

## EXPLAIN Output Guide

```
SCAN TABLE nodes          -- Bad: full table scan
SEARCH nodes USING INDEX  -- Good: using index
USE TEMP B-TREE           -- OK for small sorts, bad for large
CORRELATED SUBQUERY       -- Often slow, try to flatten
```

## Common Patterns

### Adding a SQLite Index

```typescript
// In src/db.ts SCHEMA constant:
CREATE INDEX IF NOT EXISTS idx_edges_source_type ON edges(source_id, type);
```

### Adding Statement Caching

```typescript
// In src/db.ts GraphDatabase class:
private stmtCache = new Map<string, Database.Statement>();

private getCachedStatement(sql: string): Database.Statement {
  let stmt = this.stmtCache.get(sql);
  if (!stmt) {
    stmt = this.db.prepare(sql);
    this.stmtCache.set(sql, stmt);
  }
  return stmt;
}
```

### Adding SQLite Pragmas

```typescript
// In src/db.ts constructor:
this.db.pragma("synchronous = NORMAL");
this.db.pragma("cache_size = -64000");
this.db.pragma("temp_store = MEMORY");
this.db.pragma("mmap_size = 268435456");
```

## Verification Checklist

Before marking an optimization complete:

- [ ] `npm test` passes
- [ ] Benchmark shows improvement (or no regression)
- [ ] No new memory leaks (for caching changes)
- [ ] Code is readable and maintainable

## Benchmark Scales

| Scale | Nodes | Time | When to Use |
|-------|-------|------|-------------|
| `micro` | ~8K | ~1 min | Quick iteration |
| `quick` | ~170K | ~5 min | Verify improvement |
| `full` | ~17M | ~30 min | Final validation |

Start with `micro` for fast feedback, use `quick` to confirm gains.

## Benchmark Expectations

Not all optimizations show dramatic improvements in benchmarks:

- **Statement caching**: Benefits repeated identical SQL strings. Benchmarks use varying parameters, so gains appear in production workloads more than benchmarks.
- **Index changes**: Show up clearly in benchmarks since query patterns hit the indexes.
- **Batching**: Large improvements visible when benchmark includes bulk operations.

If the benchmark shows **no regression**, the optimization is still valid - it may benefit real-world usage patterns that benchmarks don't stress.
