# NiceFox GraphDB

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/nicefox-graphdb.svg)](https://www.npmjs.com/package/nicefox-graphdb)

A lightweight, self-hosted graph database with Cypher query support, powered by SQLite.

## Why NiceFox?

| Feature | NiceFox GraphDB | Neo4j |
|---------|-----------------|-------|
| **Deployment** | Single binary, zero config | Complex setup, JVM required |
| **Backup** | Just copy the SQLite file | Enterprise license required |
| **Resource usage** | ~50MB RAM | 1GB+ RAM minimum |
| **Cypher support** | Core subset | Full |
| **Cost** | Free, MIT license | Free tier limited |

NiceFox is ideal for:
- Applications that need graph queries without the ops burden
- Projects that outgrow JSON but don't need a full graph database
- Self-hosted deployments where simplicity matters
- Testing and development with in-memory databases

## Quick Start

### Install

```bash
npm install nicefox-graphdb
```

### Client Usage

```typescript
import { NiceFoxGraphDB } from 'nicefox-graphdb';

const db = new NiceFoxGraphDB({
  url: 'http://localhost:3000',
  project: 'myapp',
  env: 'production',
  apiKey: process.env.GRAPHDB_API_KEY
});

// Create nodes
await db.execute(`
  CREATE (alice:User {id: 'alice', name: 'Alice'}),
         (bob:User {id: 'bob', name: 'Bob'})
`);

// Create relationships
await db.execute(`
  MATCH (a:User {id: 'alice'}), (b:User {id: 'bob'})
  CREATE (a)-[:FOLLOWS]->(b)
`);

// Query with parameters
const followers = await db.query(
  `MATCH (u:User)-[:FOLLOWS]->(target:User {id: $id}) RETURN u`,
  { id: 'bob' }
);
```

### Run the Server

```bash
# Start server (data stored in ./data)
npx nicefox-graphdb serve --data ./data

# Create a project
npx nicefox-graphdb create myapp --data ./data
```

### Testing with In-Memory Database

```typescript
import { createTestClient } from 'nicefox-graphdb';

const client = await createTestClient();

await client.execute('CREATE (n:Test {name: "hello"})');
const results = await client.query('MATCH (n:Test) RETURN n');

client.close();
```

## Cypher Support

### Clauses & Keywords

| Keyword | Status |
|---------|--------|
| `CREATE` | Supported |
| `MATCH` | Supported |
| `MERGE` | Supported |
| `WHERE` | Supported |
| `SET` | Supported |
| `DELETE` | Supported |
| `DETACH DELETE` | Supported |
| `RETURN` | Supported |
| `AS` (aliases) | Supported |
| `LIMIT` | Supported |
| `AND` / `OR` / `NOT` | Supported |
| `IS NULL` / `IS NOT NULL` | Supported |
| `CONTAINS` / `STARTS WITH` / `ENDS WITH` | Supported |
| `IN` | Supported |
| `ORDER BY` | Supported |
| `SKIP` | Supported |
| `DISTINCT` | Supported |
| `OPTIONAL MATCH` | Supported |
| `WITH` | Supported |
| `UNION` / `UNION ALL` | Supported |
| `UNWIND` | Supported |
| `CASE` / `WHEN` / `THEN` / `ELSE` / `END` | Supported |
| `EXISTS` | Supported |
| Variable-length paths (`*1..3`) | Supported |
| `CALL` (procedures) | Supported |

### Operators

| Operator | Description |
|----------|-------------|
| `=`, `<>`, `<`, `>`, `<=`, `>=` | Comparison |
| `+`, `-`, `*`, `/`, `%` | Arithmetic |

### Functions

**Aggregation**: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `COLLECT`

**Scalar**: `ID`, `coalesce`

**String**: `toUpper`, `toLower`, `trim`, `substring`, `replace`, `toString`, `split`

**List**: `size`, `head`, `last`, `tail`, `keys`, `range`

**Node/Relationship**: `labels`, `type`, `properties`

**Math**: `abs`, `ceil`, `floor`, `round`, `rand`, `sqrt`

**Date/Time**: `date`, `datetime`, `timestamp`

### Procedures

```cypher
CALL db.labels() YIELD label RETURN label
CALL db.relationshipTypes() YIELD type RETURN type
CALL db.propertyKeys() YIELD key RETURN key
```

## CLI Reference

```bash
# Server
nicefox-graphdb serve [--port 3000] [--data /path/to/data]

# Project management
nicefox-graphdb create <project>     # Create new project with API keys
nicefox-graphdb delete <project>     # Delete project
nicefox-graphdb list                 # List all projects

# Environment management
nicefox-graphdb clone <project>      # Copy production to test
nicefox-graphdb wipe <project>       # Clear test database

# Backup
nicefox-graphdb backup [--output ./backups]

# API keys
nicefox-graphdb apikey add <project> [--env production|test]
nicefox-graphdb apikey list
nicefox-graphdb apikey remove <prefix>

# Direct queries
nicefox-graphdb query <env> <project> "MATCH (n) RETURN n LIMIT 10"
```

## Documentation

- [Quick Start Guide](docs/QUICKSTART.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE) - Conrad Lelubre
