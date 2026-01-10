# LeanGraph Optimization Log

Track performance optimization iterations here. Each entry should document what was tried, results, and learnings.

## How to Use

After each optimization iteration:
1. Run comparison: `npm run benchmark:analyze <baseline> <new>`
2. Add an entry below with the template
3. Commit with the optimization changes

---

## Template

```markdown
## Iteration N - YYYY-MM-DD

### Target
- Query: `query_name`
- Category: lookup/pattern/aggregation/traversal/write
- Baseline p50: XXms

### Hypothesis
What we thought was causing the slowness.

### Changes
- Brief description of changes
- Files modified: src/xxx.ts (lines N-M)

### Results
| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Target query p50 | XXms | YYms | -ZZ% |
| Overall avg p50 | XXms | YYms | -ZZ% |
| Tests | Pass | Pass | - |

### Learnings
What we learned, what to try next.
```

---

## Optimization History

<!-- Add new entries below, newest first -->

### Baseline - Initial State

**Known Bottlenecks (from code analysis):**

1. **No property indexes** - All property lookups (`{id: $val}`) do full table scans with JSON extraction
2. **No label index** - Label stored as JSON array, no index
3. **Variable-length paths** - Recursive CTE expands all paths before LIMIT
4. **JSON extraction overhead** - Every property access calls `json_extract()`

**Comparison with Neo4j/Memgraph:**
- Both create indexes on `User(id)`, `Item(id)`, `Event(id)`, `Item(category)`
- LeanGraph has no equivalent property indexing

**Priority Optimization Targets:**
1. Property indexing for common patterns (`id`, `category`)
2. LIMIT pushdown for variable-length paths
3. Label-based filtering optimization

---

<!-- New iterations go here -->
