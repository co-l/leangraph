# NiceFox GraphDB

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/nicefox-graphdb.svg)](https://www.npmjs.com/package/nicefox-graphdb)

A lightweight, self-hosted graph database with Cypher query support, powered by SQLite.

## Install

```bash
npm install nicefox-graphdb
```

## Quick Start

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

// Query
const followers = await db.query(
  `MATCH (u:User)-[:FOLLOWS]->(target:User {id: $id}) RETURN u`,
  { id: 'bob' }
);
```

## Run the Server

```bash
# Start server
npx nicefox-graphdb serve --data ./data

# Create a project
npx nicefox-graphdb create myapp --data ./data
```

## Testing

```typescript
import { createTestClient } from 'nicefox-graphdb';

const client = await createTestClient();

await client.execute('CREATE (n:Test {name: "hello"})');
const results = await client.query('MATCH (n:Test) RETURN n');

client.close();
```

## Documentation

See the full documentation at [GitHub](https://github.com/co-l/nicefox-graphdb).

## License

[MIT](https://github.com/co-l/nicefox-graphdb/blob/main/LICENSE) - Conrad Lelubre
