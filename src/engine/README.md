# Hybrid Execution Engine

A proof-of-concept hybrid query execution approach that combines SQL for efficient indexed lookups with in-memory graph traversal for complex pattern matching.

## Overview

LeanGraph's standard executor translates Cypher queries entirely into SQL, using recursive CTEs for variable-length paths. While this achieves 100% TCK compliance, the generated SQL becomes complex and slow for multi-hop traversals.

The hybrid engine takes a different approach:
- **SQL** for what it's good at: indexed lookups, filtering by properties/labels, bulk fetching
- **In-memory traversal** for what SQL struggles with: variable-length paths, pattern matching

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ User Request │────▶│  SubgraphLoader  │────▶│  HybridExecutor │
│              │     │  (SQL anchors)   │     │  (in-memory)    │
└──────────────┘     └──────────────────┘     └─────────────────┘
                            │                        │
                     ┌──────▼──────┐          ┌──────▼──────┐
                     │ findAnchors │          │ MemoryGraph │
                     │ (indexed)   │          │ traversePaths│
                     └─────────────┘          └─────────────┘
```

### Components

| Component | Purpose |
|-----------|---------|
| `MemoryGraph` | In-memory graph with O(1) node lookups and adjacency lists |
| `SubgraphLoader` | Loads bounded subgraphs from SQLite into memory |
| `HybridExecutor` | Executes pattern queries using in-memory traversal |

## Usage

```typescript
import { GraphDatabase, HybridExecutor } from 'leangraph';

const db = new GraphDatabase(':memory:');
db.initialize();

// Set up test data
db.insertNode('alice', 'Person', { name: 'Alice', age: 30 });
db.insertNode('bob', 'Person', { name: 'Bob', age: 25 });
db.insertNode('acme', 'Company', { name: 'Acme Corp' });
db.insertEdge('e1', 'KNOWS', 'alice', 'bob', {});
db.insertEdge('e2', 'WORKS_AT', 'bob', 'acme', {});

// Execute pattern query
const hybrid = new HybridExecutor(db);
const results = hybrid.executeVarLengthPattern({
  // Anchor: (a:Person {name: 'Alice'})
  anchorLabel: 'Person',
  anchorProps: { name: 'Alice' },
  
  // Variable-length: -[:KNOWS*1..3]->
  varEdgeType: 'KNOWS',
  varMinDepth: 1,
  varMaxDepth: 3,
  varDirection: 'out',
  
  // Middle node: (b:Person) WHERE b.age > 20
  middleLabel: 'Person',
  middleFilter: (node) => (node.properties.age as number) > 20,
  
  // Final hop: -[:WORKS_AT]->(c:Company)
  finalEdgeType: 'WORKS_AT',
  finalDirection: 'out',
  finalLabel: 'Company',
});

// Results: [{ a: {name: 'Alice', ...}, b: {name: 'Bob', ...}, c: {name: 'Acme Corp', ...} }]
```

## Supported Patterns

The POC currently supports this query pattern:

```cypher
MATCH (a:Label {props})-[:TYPE*min..max]->(b:Label)-[:TYPE]->(c:Label)
WHERE <filter on b>
RETURN a, b, c
```

Equivalent to:
```
(anchor) -[variable-length]-> (middle) -[fixed]-> (final)
```

### Parameters

| Parameter | Description |
|-----------|-------------|
| `anchorLabel` | Label of the starting node |
| `anchorProps` | Property filters for anchor (uses SQL indexes) |
| `varEdgeType` | Edge type for variable-length traversal (`null` = any) |
| `varMinDepth` | Minimum path length |
| `varMaxDepth` | Maximum path length |
| `varDirection` | `'out'`, `'in'`, or `'both'` |
| `middleLabel` | Required label for middle node |
| `middleFilter` | Optional predicate function for middle node |
| `finalEdgeType` | Edge type for final hop |
| `finalDirection` | Direction for final hop |
| `finalLabel` | Required label for final node |

## Benchmark Results

Comparing hybrid vs pure SQL execution for the target query pattern.

### Test Setup
- Graph: 5,000 nodes, 17,150 edges
- Query: `(Person {name})-[:KNOWS*1..N]->(Person)-[:WORKS_AT]->(Company) WHERE age > 25`

### Results

| Depth | SQL | Hybrid | Speedup |
|-------|-----|--------|---------|
| 1..1 | 3.84ms | 0.68ms | **5.6x** |
| 1..2 | 11.38ms | 1.22ms | **9.3x** |
| 1..3 | 41.45ms | 2.40ms | **17.3x** |

The speedup increases with depth because:
1. SQL recursive CTEs grow exponentially in complexity
2. In-memory traversal with adjacency lists is O(edges) per hop
3. Subgraph loading is bounded and done once upfront

### Running the Benchmark

```bash
# Quick test (1000 nodes)
npx tsx bench/hybrid-vs-sql.ts --nodes 1000 --runs 5

# Full benchmark (10000 nodes)
npx tsx bench/hybrid-vs-sql.ts --nodes 10000 --runs 10

# Help
npx tsx bench/hybrid-vs-sql.ts --help
```

## API Reference

### MemoryGraph

In-memory graph structure optimized for traversal.

```typescript
class MemoryGraph {
  // Build from SQLite row data
  static fromRows(nodeRows: NodeRow[], edgeRows: EdgeRow[]): MemoryGraph;
  
  // O(1) node lookup
  getNode(id: string): MemoryNode | undefined;
  
  // Adjacency access
  getOutEdges(nodeId: string, type?: string): MemoryEdge[];
  getInEdges(nodeId: string, type?: string): MemoryEdge[];
  neighbors(nodeId: string, direction: Direction, type?: string): MemoryNode[];
  
  // Variable-length path traversal (generator)
  *traversePaths(
    startId: string,
    edgeType: string | null,
    minDepth: number,
    maxDepth: number,
    direction: Direction
  ): Generator<Path>;
}
```

### SubgraphLoader

Loads bounded subgraphs from SQLite.

```typescript
class SubgraphLoader {
  constructor(db: GraphDatabase);
  
  // Find anchor nodes using indexed SQL
  findAnchors(label: string, propertyFilters?: PropertyFilter): string[];
  
  // Load subgraph within bounds
  loadSubgraph(bounds: SubgraphBounds): MemoryGraph;
}

interface SubgraphBounds {
  anchorNodeIds: string[];
  maxDepth: number;
  edgeTypes: string[] | null;
  direction: Direction;
}
```

### HybridExecutor

Pattern matching engine.

```typescript
class HybridExecutor {
  constructor(db: GraphDatabase);
  
  // Execute pattern, return properties
  executeVarLengthPattern(params: VarLengthPatternParams): Record<string, unknown>[];
  
  // Execute pattern, return full nodes
  executeVarLengthPatternRaw(params: VarLengthPatternParams): PatternResult[];
}
```

## Future Work

Potential enhancements (not yet implemented):

1. **shortestPath()** - BFS on MemoryGraph (parser already supports it)
2. **Query Planner** - Auto-detect suitable queries and route to hybrid executor
3. **Subgraph Caching** - Cache loaded subgraphs for repeated neighborhood queries
4. **Generalized Patterns** - Support longer chains, multiple var-length segments
5. **allShortestPaths()** - All shortest paths between two nodes

## Tests

```bash
# Run engine tests only
npm test -- test/engine/

# Run specific test file
npm test -- test/engine/memory-graph.test.ts
```

Test coverage:
- `memory-graph.test.ts` - 35 tests
- `subgraph-loader.test.ts` - 24 tests  
- `hybrid-executor.test.ts` - 17 tests (includes correctness vs SQL)
