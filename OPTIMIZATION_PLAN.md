# LeanGraph Performance Optimization Plan

This document outlines actionable performance optimizations for LeanGraph, prioritized by impact and effort.

## Phase 2: Current Optimizations (Complete)

These optimizations addressed gaps and improvements identified in Phase 1 implementations. All items are now complete.

| Priority | Optimization | Speedup | Effort | Status |
|----------|--------------|---------|--------|--------|
| P0 | Expand property cache usage | 2-5x | Low | [x] |
| P0 | Fix label index utilization | 5-20x | Low | [x] |
| P1 | Batch edge INSERTs | 5-10x | Medium | [x] |
| P1 | Statement cache LRU eviction | ~20% | Low | [x] |
| P2 | Secondary CTE early termination | 10-100x | Medium | [x] |
| P2 | Expand batch edge lookups | 2-5x | Medium | [x] (partial) |

---

## P0: Critical (Do First)

### 1. Expand Property Cache Usage

**File:** `src/executor.ts`  
**Effort:** Low (search & replace pattern)  
**Impact:** 2-5x for property-heavy queries

**Problem:** The `getNodeProperties()` cache exists but is only used in 2 of 27+ locations. Most code still does direct `JSON.parse(row.properties)`.

**Current pattern (appears ~27 times):**
```typescript
const props = typeof row.properties === "string" 
  ? JSON.parse(row.properties) 
  : row.properties;
```

**Solution:**
1. Search for all `JSON.parse(row.properties)` and `JSON.parse(.*properties)` patterns
2. Replace with `this.getNodeProperties(row.id, row.properties)`
3. Add `getEdgeProperties(edgeId, propsJson)` method for edge property caching
4. Update edge property parsing to use the new cache

**Add this method:**
```typescript
private edgePropertyCache = new Map<string, Record<string, unknown>>();

private getEdgeProperties(edgeId: string, propsJson: string | object): Record<string, unknown> {
  let props = this.edgePropertyCache.get(edgeId);
  if (!props) {
    props = typeof propsJson === "string" ? JSON.parse(propsJson) : propsJson;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      this.edgePropertyCache.set(edgeId, props);
    } else {
      props = {};
    }
  }
  return props || {};
}

// In execute(), also clear edge cache:
execute(cypher: string, params: Record<string, unknown> = {}): QueryResponse {
  this.propertyCache.clear();
  this.edgePropertyCache.clear();
  // ...
}
```

---

### 2. Fix Label Index Utilization

**File:** `src/db.ts`, `src/translator.ts`  
**Effort:** Low  
**Impact:** 5-20x faster `MATCH (n:Label)` queries

**Problem:** The `idx_nodes_primary_label` index exists on `json_extract(label, '$[0]')`, but queries don't use it.

**Current `getNodesByLabel()` (doesn't use index):**
```typescript
getNodesByLabel(label: string): Node[] {
  const result = this.execute(
    "SELECT * FROM nodes WHERE EXISTS (SELECT 1 FROM json_each(label) WHERE value = ?)",
    [label]
  );
  // ...
}
```

**Solution A - Optimize for primary label (common case):**
```typescript
getNodesByLabel(label: string): Node[] {
  // Use index for primary label, fallback for secondary labels
  const result = this.execute(
    `SELECT * FROM nodes WHERE json_extract(label, '$[0]') = ? 
     OR EXISTS (SELECT 1 FROM json_each(label) WHERE value = ? AND json_extract(label, '$[0]') != ?)`,
    [label, label, label]
  );
  // ...
}
```

**Solution B - Primary label only (simpler, covers 95% of cases):**
```typescript
getNodesByLabel(label: string): Node[] {
  const result = this.execute(
    "SELECT * FROM nodes WHERE json_extract(label, '$[0]') = ?",
    [label]
  );
  // ...
}
```

**Also update translator.ts:** Ensure label conditions in MATCH clauses emit `json_extract(label, '$[0]') = ?` instead of `EXISTS(SELECT 1 FROM json_each...)`.

---

## P1: High Priority

### 3. Batch Edge INSERTs

**File:** `src/executor.ts` - `tryUnwindCreateExecution()`  
**Effort:** Medium  
**Impact:** 5-10x faster bulk relationship creation

**Problem:** Node INSERTs are batched (500 per statement), but edge INSERTs are still individual.

**Current (edges inserted one at a time):**
```typescript
this.db.execute(
  "INSERT INTO edges (id, type, source_id, target_id, properties) VALUES (?, ?, ?, ?, ?)",
  [edgeId, type, sourceId, targetId, propsJson]
);
```

**Solution:** Collect edge inserts and batch them like nodes:
```typescript
// Collect edge inserts
const edgeInserts: Array<{id: string, type: string, sourceId: string, targetId: string, propsJson: string}> = [];

// ... in the loop:
edgeInserts.push({ id: edgeId, type, sourceId, targetId, propsJson });

// After collecting all edges:
const BATCH_SIZE = 500;
for (let i = 0; i < edgeInserts.length; i += BATCH_SIZE) {
  const batch = edgeInserts.slice(i, i + BATCH_SIZE);
  const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(',');
  const values = batch.flatMap(e => [e.id, e.type, e.sourceId, e.targetId, e.propsJson]);
  
  this.db.execute(
    `INSERT INTO edges (id, type, source_id, target_id, properties) VALUES ${placeholders}`,
    values
  );
}
```

**Challenge:** Edges often depend on nodes created in the same batch. Solution: Collect all node inserts first, execute them, then collect and execute all edge inserts.

---

### 4. Statement Cache LRU Eviction

**File:** `src/db.ts` - `getCachedStatement()`  
**Effort:** Low  
**Impact:** ~20% better cache hit rate

**Problem:** Current FIFO eviction removes oldest-inserted statements, even if they're frequently used.

**Current (FIFO):**
```typescript
private getCachedStatement(sql: string): Database.Statement {
  let stmt = this.stmtCache.get(sql);
  if (!stmt) {
    stmt = this.db.prepare(sql);
    if (this.stmtCache.size >= this.STMT_CACHE_MAX) {
      const firstKey = this.stmtCache.keys().next().value;
      if (firstKey) this.stmtCache.delete(firstKey);
    }
    this.stmtCache.set(sql, stmt);
  }
  return stmt;
}
```

**Solution (LRU):** Move accessed entries to end of Map:
```typescript
private getCachedStatement(sql: string): Database.Statement {
  let stmt = this.stmtCache.get(sql);
  if (stmt) {
    // Move to end for LRU (delete and re-add)
    this.stmtCache.delete(sql);
    this.stmtCache.set(sql, stmt);
    return stmt;
  }
  
  // Not cached - prepare and add
  stmt = this.db.prepare(sql);
  if (this.stmtCache.size >= this.STMT_CACHE_MAX) {
    const firstKey = this.stmtCache.keys().next().value;
    if (firstKey) this.stmtCache.delete(firstKey);
  }
  this.stmtCache.set(sql, stmt);
  return stmt;
}
```

---

## P2: Medium Priority

### 5. Secondary CTE Early Termination

**File:** `src/translator.ts` - `translateVariableLengthPath()`  
**Effort:** Medium  
**Impact:** 10-100x for queries with multiple variable-length patterns

**Problem:** Only the primary CTE has early termination (`row_num` tracking). Secondary CTEs in the same query don't.

**Current:** Primary CTE includes `row_num < earlyTerminationLimit`, but secondary CTE (e.g., `path_1`) lacks this.

**Solution:** Apply the same early termination pattern to all variable-length CTEs:
1. Pass the `limitValue` to all CTE generation calls
2. Add `row_num` column and termination condition to secondary CTEs
3. Ensure depth tracking is consistent across all CTEs

**Implementation steps:**
1. Find where secondary CTEs are generated (around lines 3925-4090)
2. Add the `row_num` column to base case: `ROW_NUMBER() OVER () as row_num`
3. Add `p.row_num + 1` to recursive case
4. Add `AND p.row_num < ?` condition with `earlyTerminationLimit` parameter

---

### 6. Expand Batch Edge Lookups

**File:** `src/executor.ts`  
**Effort:** Medium  
**Impact:** 2-5x for edge-heavy queries  
**Status:** Partially implemented

**Problem:** `batchGetEdgeInfo()` exists but is only used in 2 places. 21 other locations still do individual `SELECT * FROM edges WHERE id = ?` queries.

**Implemented:**
1. Enhanced `batchGetEdgeInfo()` to return full edge info (type, properties, source_id, target_id)
2. Added `edgeInfoCache` to cache edge info across function calls
3. Updated `type()`, `startNode()`, `endNode()` functions to check cache first
4. Cache is populated by `batchGetEdgeInfo()` calls during path query processing

**Remaining (for future):**
After reviewing the 21 edge lookup locations, many don't match the batching pattern:
- Most are **one-off lookups** after MERGE/CREATE (not in loops)
- Many are **fallback queries** (try nodes first, then edges)
- Some are in **SQL generation** (translator, not executor)

The existing `batchGetEdgeInfo()` already covers the main hot path (path query processing). Additional batching would require significant restructuring with limited benchmark impact.

**Future consideration:** Profile production workloads to identify if specific edge-heavy query patterns emerge that would benefit from targeted batching.

---

## Benchmarking Workflow

After each optimization:

```bash
# 1. Run tests (must pass!)
npm test

# 2. Run micro benchmark
npm run benchmark -- -s micro -d leangraph

# 3. For significant changes, run quick benchmark
npm run benchmark -- -s quick -d leangraph

# 4. Compare results
npm run benchmark:compare <baseline> <target>
```

---

---

# Phase 3: Future Optimizations

These are potential optimizations identified for future implementation. They require more investigation or have higher complexity.

| Priority | Optimization | Speedup | Effort | Status |
|----------|--------------|---------|--------|--------|
| P0 | Query plan caching | 2-5x | Medium | [ ] |
| P0 | Parser result caching | 20-50% | Low | [ ] |
| P1 | Property value indexes | 10-100x | Medium | [ ] |
| P1 | Batch DELETE statements | 5-10x | Low | [ ] |
| P1 | MERGE UPSERT optimization | 2-5x | Medium | [ ] |
| P2 | Push-down aggregations | 2-10x | Medium | [ ] |
| P2 | Connection pooling / statement pre-warming | ~50% cold | Low | [ ] |
| P3 | Parallel subquery execution | 2-4x | High | [ ] |

---

## P0: Critical

### 1. Query Plan Caching

**File:** `src/executor.ts`, new `src/plan-cache.ts`  
**Effort:** Medium  
**Impact:** 2-5x for repeated queries

**Problem:** Each query execution re-parses and re-translates the Cypher query to SQL, even for identical queries with different parameters.

**Solution:**
1. Create a query plan cache keyed by normalized Cypher (with parameters replaced by placeholders)
2. Cache the translated SQL and parameter mapping
3. On cache hit, skip parsing and translation, directly execute cached SQL
4. Use LRU eviction with configurable cache size

**Implementation:**
```typescript
interface CachedPlan {
  sql: string;
  parameterMapping: Map<string, number>; // param name -> SQL placeholder index
  returnColumns: string[];
}

class PlanCache {
  private cache = new Map<string, CachedPlan>();
  private readonly maxSize = 100;
  
  get(normalizedCypher: string): CachedPlan | undefined;
  set(normalizedCypher: string, plan: CachedPlan): void;
}
```

---

### 2. Parser Result Caching

**File:** `src/parser.ts`  
**Effort:** Low  
**Impact:** 20-50% for repeated queries

**Problem:** Parsing is done on every query execution, even for identical query strings.

**Solution:**
1. Add LRU cache for parsed ASTs keyed by query string
2. Return cached AST on cache hit
3. Invalidate on schema changes (if any)

**Implementation:**
```typescript
const parseCache = new Map<string, ParseResult>();
const PARSE_CACHE_MAX = 100;

export function parse(cypher: string): ParseResult {
  const cached = parseCache.get(cypher);
  if (cached) {
    // LRU: move to end
    parseCache.delete(cypher);
    parseCache.set(cypher, cached);
    return cached;
  }
  
  const result = parseInternal(cypher);
  // Add to cache with LRU eviction...
  return result;
}
```

---

## P1: High Priority

### 3. Property Value Indexes

**File:** `src/db.ts`, `src/translator.ts`  
**Effort:** Medium  
**Impact:** 10-100x for indexed property lookups

**Problem:** Property lookups use `json_extract()` which requires full table scans.

**Solution:**
1. Allow users to create indexes on specific properties: `CREATE INDEX ON :Label(property)`
2. Store index metadata in a system table
3. Translator checks for available indexes and uses them in WHERE clauses
4. Maintain indexes on INSERT/UPDATE/DELETE

**Schema:**
```sql
CREATE TABLE _indexes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  property TEXT NOT NULL,
  index_name TEXT NOT NULL,
  UNIQUE(label, property)
);

-- Generated index example:
CREATE INDEX idx_User_email ON nodes(json_extract(properties, '$.email'))
  WHERE json_extract(label, '$[0]') = 'User';
```

---

### 4. Batch DELETE Statements

**File:** `src/executor.ts`  
**Effort:** Low  
**Impact:** 5-10x for bulk deletes

**Problem:** DELETE operations execute one statement per node/edge.

**Solution:**
1. Collect all IDs to delete in a single pass
2. Use `DELETE FROM nodes WHERE id IN (...)` with batched IDs
3. Same pattern for edges
4. Handle cascading deletes (edges connected to deleted nodes)

**Implementation:**
```typescript
// Before (one at a time):
for (const nodeId of nodeIds) {
  this.db.execute("DELETE FROM nodes WHERE id = ?", [nodeId]);
}

// After (batched):
const BATCH_SIZE = 500;
for (let i = 0; i < nodeIds.length; i += BATCH_SIZE) {
  const batch = nodeIds.slice(i, i + BATCH_SIZE);
  const placeholders = batch.map(() => '?').join(',');
  this.db.execute(`DELETE FROM nodes WHERE id IN (${placeholders})`, batch);
}
```

---

### 5. MERGE UPSERT Optimization

**File:** `src/executor.ts`  
**Effort:** Medium  
**Impact:** 2-5x for MERGE operations

**Problem:** MERGE does separate SELECT + INSERT/UPDATE, which is slower than SQLite's UPSERT.

**Solution:**
1. Detect simple MERGE patterns that can use `INSERT ... ON CONFLICT`
2. Generate UPSERT SQL for supported patterns
3. Fall back to current implementation for complex MERGE

**Pattern:**
```sql
-- Simple MERGE (n:Label {key: value}) can become:
INSERT INTO nodes (id, label, properties) 
VALUES (?, ?, ?)
ON CONFLICT(id) DO UPDATE SET properties = excluded.properties;
```

---

## P2: Medium Priority

### 6. Push-down Aggregations

**File:** `src/translator.ts`, `src/executor.ts`  
**Effort:** Medium  
**Impact:** 2-10x for aggregate queries

**Problem:** Aggregations like `count()`, `sum()`, `avg()` are often computed in JavaScript after fetching all rows.

**Solution:**
1. Detect when aggregations can be computed in SQL
2. Generate `SELECT COUNT(*), SUM(...)` etc. directly
3. Avoid fetching full result sets for pure aggregation queries

**Example:**
```cypher
MATCH (n:User) RETURN count(n)
```
```sql
-- Current: SELECT * FROM nodes WHERE ... (then count in JS)
-- Optimized: SELECT COUNT(*) FROM nodes WHERE ...
```

---

### 7. Connection Pooling / Statement Pre-warming

**File:** `src/db.ts`, `src/local.ts`  
**Effort:** Low  
**Impact:** ~50% faster cold starts

**Problem:** First queries are slower due to SQLite connection setup and statement compilation.

**Solution:**
1. Pre-compile common statements on database open
2. Keep statements warm in cache
3. For server mode: implement connection pooling

**Common statements to pre-warm:**
```typescript
const WARMUP_STATEMENTS = [
  "SELECT * FROM nodes WHERE id = ?",
  "SELECT * FROM edges WHERE id = ?",
  "SELECT * FROM nodes WHERE json_extract(label, '$[0]') = ?",
  "INSERT INTO nodes (id, label, properties) VALUES (?, ?, ?)",
  "INSERT INTO edges (id, type, source_id, target_id, properties) VALUES (?, ?, ?, ?, ?)",
];
```

---

## P3: Lower Priority

### 8. Parallel Subquery Execution

**File:** `src/executor.ts`  
**Effort:** High  
**Impact:** 2-4x for complex queries with independent subqueries

**Problem:** Complex queries with multiple independent MATCH clauses execute sequentially.

**Solution:**
1. Analyze query for independent subqueries
2. Execute independent parts in parallel using worker threads
3. Merge results for dependent operations

**Challenges:**
- SQLite connections are not thread-safe
- Need separate connections per worker
- Complex dependency analysis
- May not benefit small queries (overhead)

**Candidate patterns:**
```cypher
-- Independent MATCHes that could run in parallel:
MATCH (a:User {id: 1})
MATCH (b:Item {id: 2})
RETURN a, b
```

---

## Notes

- Always run full test suite after changes: `npm test`
- Use TCK tool for regression testing: `npm run tck '<pattern>'`
- Document performance gains in commit messages
- Mark items complete with `[x]` as they're finished
- Phase 3 items require profiling to validate impact before implementation

---

---

# Archive: Phase 1 (Completed)

All Phase 1 optimizations have been implemented. This section is preserved for reference.

## Phase 1 Summary

| Priority | Optimization | Speedup | Effort | Status |
|----------|--------------|---------|--------|--------|
| P0 | SQLite performance pragmas | 2-3x | Low | [x] |
| P0 | Prepared statement cache | 2-5x | Low | [x] |
| P0 | Composite edge indexes | 5-20x | Low | [x] |
| P1 | Label index | 5-20x | Low | [x] |
| P1 | Variable-length path early termination | 10-100x | Medium | [x] |
| P1 | Batch INSERTs for UNWIND+CREATE | 10-100x | Medium | [x] |
| P2 | JSON property parse caching | 2-5x | Low | [x] |
| P2 | Reduce context cloning | 2-3x | Medium | [x] |
| P2 | Single-pass query classifier | 5-10x | Medium | [x] |
| P3 | Tokenizer string allocation | 30-50% | Low | [x] |
| P3 | Batch edge lookups in paths | 5-20x | Medium | [x] |

<details>
<summary>Phase 1 Implementation Details (click to expand)</summary>

### P0: SQLite Performance Pragmas
**File:** `src/db.ts:554-564`

All 6 pragmas implemented:
- `journal_mode = WAL`
- `foreign_keys = ON`
- `synchronous = NORMAL`
- `cache_size = -64000` (64MB)
- `temp_store = MEMORY`
- `mmap_size = 268435456` (256MB)

### P0: Prepared Statement Cache
**File:** `src/db.ts:551-591`

- Map-based cache with FIFO eviction
- Max 100 statements
- Cleared on `close()`

### P0: Composite Edge Indexes
**File:** `src/db.ts:67-68`

Added:
- `idx_edges_source_type ON edges(source_id, type)`
- `idx_edges_target_type ON edges(target_id, type)`

### P1: Label Index
**File:** `src/db.ts:69`

Functional index on primary label:
- `idx_nodes_primary_label ON nodes(json_extract(label, '$[0]'))`

### P1: Variable-Length Path Early Termination
**File:** `src/translator.ts:3354-3357`

- `row_num` column for tracking
- `earlyTerminationLimit = min(limit * 10, 10000)`
- Applied to primary CTE only

### P1: Batch INSERTs for UNWIND+CREATE
**File:** `src/executor.ts:4507-4518`

- Nodes batched at 500 per INSERT
- Multi-row VALUES syntax

### P2: JSON Property Parse Caching
**File:** `src/executor.ts:230-251`

- `propertyCache` Map
- `getNodeProperties()` method
- Cleared at query start

### P2: Reduce Context Cloning
**File:** `src/executor.ts:126-133`

- `cloneRows` parameter added
- `isReadOnlyClause()` skips cloning for MATCH, OPTIONAL_MATCH, RETURN

### P2: Single-Pass Query Classifier
**File:** `src/executor.ts:163-683`

- `QueryPattern` type with 10 patterns
- `classifyQuery()` single-pass flag collection
- Switch-based dispatch

### P3: Tokenizer String Allocation
**File:** `src/parser.ts`

All methods use `slice()`:
- `readIdentifier()` (lines 855-862)
- `readString()` (lines 654-717)
- `readNumber()` (lines 719-847)
- `readBacktickIdentifier()` (lines 864-902)

### P3: Batch Edge Lookups in Paths
**File:** `src/executor.ts:278-298`

- `batchGetEdgeInfo()` method
- Returns `Map<string, EdgeInfo>`
- Used in 2 path-processing locations

</details>
