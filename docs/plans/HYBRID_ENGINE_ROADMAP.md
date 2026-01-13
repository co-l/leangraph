# Hybrid Engine Roadmap

The hybrid execution engine is now feature-complete for the initial scope. This document outlines future improvements.

## Current State

The hybrid engine (`src/engine/`) provides:
- In-memory graph traversal for variable-length patterns
- Automatic query routing via query planner
- Support for N-node chains and multiple var-length edges
- 8-20% speedup over SQL for traversal queries

### Supported Patterns

```cypher
-- 3-node (original)
(a)-[*]->(b)-[:R]->(c)

-- Longer chains
(a)-[*]->(b)-[:R1]->(c)-[:R2]->(d)

-- Multiple var-length
(a)-[*1..2]->(b)-[*1..3]->(c)

-- Var-length anywhere
(a)-[:R1]->(b)-[*]->(c)-[:R2]->(d)
```

### Current Limitations

Queries are routed to SQL (not hybrid) if they have:
- ORDER BY
- Aggregations (count, sum, etc.)
- DISTINCT, SKIP, LIMIT
- Relationship property predicates
- WHERE on multiple nodes

## Benchmark Optimization Targets

From 170K node benchmark (`npm run benchmark -- -s quick`):

### Pattern Queries (>10ms)
| Query | p50 | Notes |
|-------|-----|-------|
| `user_items` | 31.3ms | 1-hop, candidate for optimization |
| `user_events` | 63.5ms | 1-hop pattern |

### Aggregation Queries (>10ms)
| Query | p50 | Notes |
|-------|-----|-------|
| `user_item_counts` | 88.3ms | COUNT + GROUP BY |
| `user_event_summary` | 62.9ms | Multi-column aggregation |
| `event_type_counts` | 59.2ms | COUNT + GROUP BY |
| `category_stats` | 43.9ms | AVG/COUNT + GROUP BY |

### Already Optimized (hybrid engine)
| Query | p50 |
|-------|-----|
| `related_items_depth1` | 154µs |
| `related_items_depth2` | 548µs |
| `related_items_depth3` | 1.3ms |

---

## Future Work

### P0: Subgraph Caching

**Impact:** 2-5x for repeated queries | **Effort:** Medium

Cache loaded subgraphs for repeated queries on the same region of the graph.

**Implementation:**
- LRU cache keyed by `(anchorLabel, anchorProps, maxDepth)`
- TTL-based invalidation or invalidate on write
- Memory budget with eviction policy
- Metrics: hit rate, memory usage

**Files:** `src/engine/subgraph-loader.ts`

**Example:**
```typescript
// Repeated queries on same anchor benefit from cache
MATCH (u:User {id: 'u1'})-[:KNOWS*1..3]->(f:User)-[:LIKES]->(p:Post) RETURN f, p
MATCH (u:User {id: 'u1'})-[:KNOWS*1..3]->(f:User)-[:WORKS_AT]->(c:Company) RETURN f, c
// Second query reuses subgraph loaded for first
```

---

### P1: ORDER BY Support

**Impact:** Enable more queries | **Effort:** Low

Sort results in-memory after pattern matching.

**Implementation:**
- Extract ORDER BY from ReturnClause in query planner
- Sort `ChainResultRaw[]` before formatting
- Support ASC/DESC, multiple columns, NULLS FIRST/LAST

**Files:** `src/executor.ts` (in `tryHybridVarLengthExecution`)

**Example:**
```cypher
-- Currently falls back to SQL, would use hybrid with this feature
MATCH (a:Person)-[:KNOWS*1..2]->(b:Person)-[:WORKS_AT]->(c:Company)
RETURN a.name, b.name, c.name
ORDER BY b.name
```

---

### P1: SKIP/LIMIT Support

**Impact:** Enable pagination | **Effort:** Low

Apply SKIP/LIMIT after pattern matching.

**Implementation:**
- Extract from ReturnClause
- Apply after sorting (if ORDER BY present) or directly
- Early termination optimization: stop traversal after LIMIT reached (when no ORDER BY)

**Files:** `src/executor.ts`

**Example:**
```cypher
-- Pagination support
MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
RETURN a.name, b.name, c.name
SKIP 10 LIMIT 10
```

---

### P2: DISTINCT Support

**Impact:** Enable deduplication | **Effort:** Low

Deduplicate results based on returned columns.

**Implementation:**
- Hash results by returned values
- Use Set or Map for O(1) duplicate detection
- Apply before SKIP/LIMIT

**Files:** `src/executor.ts`

**Example:**
```cypher
-- Deduplicate companies reachable through friends
MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
RETURN DISTINCT c.name
```

---

### P2: Multi-Node WHERE Filters

**Impact:** More expressive queries | **Effort:** Medium

Currently WHERE only filters one node. Extend to multiple independent filters.

**Implementation:**
- Track which nodes each condition references
- Apply filter to correct ChainNode in params
- Still reject cross-node comparisons (`a.x > b.x`)
- Support AND of conditions on different nodes

**Files:** `src/engine/query-planner.ts`

**Example:**
```cypher
-- Currently rejected, would work with this feature
MATCH (a:Person)-[:KNOWS*1..2]->(b:Person)-[:WORKS_AT]->(c:Company)
WHERE a.age > 25 AND b.city = 'NYC'
RETURN a, b, c
```

---

### P2: Anchor Node Filters

**Impact:** More query shapes | **Effort:** Low

Support WHERE conditions on anchor node, not just chain nodes.

**Implementation:**
- Detect WHERE on anchor variable
- Add filter to anchor ChainNode
- Apply in `executePatternChain` before starting traversal

**Files:** `src/engine/query-planner.ts`, `src/engine/hybrid-executor.ts`

**Example:**
```cypher
-- Filter on anchor node
MATCH (a:Person)-[:KNOWS*1..2]->(b:Person)-[:WORKS_AT]->(c:Company)
WHERE a.verified = true
RETURN a, b, c
```

---

### P3: Query Explain

**Impact:** Debugging/observability | **Effort:** Low

Show which execution path (hybrid vs SQL) was used.

**Implementation:**
- Add `explain?: boolean` option to `execute()`
- Return metadata: `{ executionPath: "hybrid" | "sql", reason?: string }`
- Optional: include timing breakdown

**Files:** `src/executor.ts`, `src/types.ts`

**Example:**
```typescript
const result = await db.execute(query, params, { explain: true });
// result.meta = { executionPath: "hybrid", loadTime: 5, traverseTime: 2 }
```

---

### P3: Aggregation Support

**Impact:** Enable count/sum/etc | **Effort:** Medium

Compute aggregations in-memory after pattern matching.

**Implementation:**
- Detect aggregation functions in RETURN
- Group results by non-aggregated columns
- Compute aggregates: count, sum, avg, min, max, collect
- Handle DISTINCT in aggregations

**Files:** `src/executor.ts`

**Example:**
```cypher
-- Aggregation in hybrid
MATCH (a:Person)-[:KNOWS*1..3]->(b:Person)-[:WORKS_AT]->(c:Company)
RETURN c.name, count(DISTINCT b) as employees
```

---

## Implementation Guide

### Adding a New Feature

1. **Write failing tests first** (TDD)
   ```bash
   # Add tests to appropriate file
   test/engine/query-planner.test.ts   # For routing logic
   test/engine/hybrid-executor.test.ts # For execution logic
   ```

2. **Implement the feature**

3. **Verify all tests pass**
   ```bash
   npm test
   ```

4. **Benchmark to ensure no regression**
   ```bash
   npx tsx bench/hybrid-vs-sql.ts --nodes 20000
   npm run benchmark -- -s micro -d leangraph
   ```

5. **Update this roadmap** - mark feature complete

### Key Files

| File | Purpose |
|------|---------|
| `src/engine/hybrid-executor.ts` | Pattern chain execution |
| `src/engine/query-planner.ts` | Query analysis and routing |
| `src/engine/memory-graph.ts` | In-memory graph structure |
| `src/engine/subgraph-loader.ts` | SQL-to-memory loading |
| `src/executor.ts` | Integration point |

### Testing Commands

```bash
# Run all engine tests
npm test -- test/engine/

# Run specific test file
npm test -- test/engine/query-planner.test.ts

# Run hybrid vs SQL benchmark
npx tsx bench/hybrid-vs-sql.ts --nodes 20000

# Run micro benchmark
npm run benchmark -- -s micro -d leangraph
```

## Completed

- [x] Hybrid execution engine (Phase 1)
- [x] Query planner with automatic routing (Phase 2)
- [x] Longer pattern chains (4+ nodes)
- [x] Multiple variable-length edges
- [x] Var-length at any position in chain
