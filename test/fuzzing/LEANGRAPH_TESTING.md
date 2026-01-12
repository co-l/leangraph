# Task: Discover Cypher Compatibility Issues

You are a fuzzing agent. Your job is to discover Cypher queries that behave differently between leangraph and Neo4j 3.5.

**Do NOT fix any issues. Only discover and record them.**

## Setup

```bash
# Start Neo4j container (wait ~30s for startup)
npm run fuzz:docker

# Verify it's running
docker logs leangraph-fuzz-neo4j 2>&1 | tail -5
```

## Discovery Loop

Run the fuzzer repeatedly with different seeds to maximize coverage:

```bash
# Run with random seed
npm run fuzz:run -- --count 200

# Run with specific features
npm run fuzz:run -- --count 100 --features functions --append
npm run fuzz:run -- --count 100 --features expressions --append
npm run fuzz:run -- --count 100 --features match,aggregations --append
```

Use `--append` to accumulate failures across runs.

## Output

All discovered issues are written to:
```
test/fuzzing/failures.json
```

Each failure contains:
- `query` - The Cypher query that failed
- `category` - Type: literal, expression, function, clause, aggregation, pattern
- `feature` - Which feature was being tested
- `status` - "fail" (leangraph bug) or "neo4j_error" (skip)
- `mismatch` - Description of the difference
- `neo4jResult` - What Neo4j returned
- `leangraphResult` - What leangraph returned

## Strategy

1. Start with broad coverage (all features, many queries)
2. Note which categories have most failures
3. Focus subsequent runs on problematic categories
4. Use different seeds to explore more query shapes

## Features to Test

| Feature | Flag |
|---------|------|
| Literals | `--features literals` |
| Expressions | `--features expressions` |
| Functions | `--features functions` |
| MATCH patterns | `--features match` |
| CREATE | `--features create` |
| WITH clauses | `--features with` |
| Aggregations | `--features aggregations` |
| UNWIND | `--features unwind` |
| CASE expressions | `--features case` |
| List comprehensions | `--features comprehensions` |

Combine with commas: `--features functions,expressions,case`

## Cleanup

When done discovering:
```bash
npm run fuzz:stop
```

## Success Criteria

Your task is complete when:
1. You have run multiple fuzzing sessions with different seeds/features
2. `failures.json` contains all discovered issues
3. Neo4j container is stopped
