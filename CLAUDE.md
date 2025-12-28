# NiceFox GraphDB

SQLite-based graph database with Cypher query support.

## Architecture

```
packages/server/src/
├── parser.ts      # Cypher tokenizer & parser → AST
├── translator.ts  # AST → SQL translation
├── executor.ts    # Query execution (handles multi-phase queries)
├── db.ts          # SQLite wrapper (nodes/edges tables)
├── routes.ts      # HTTP API endpoints
└── auth.ts        # API key authentication
```

## Development

```bash
pnpm test              # Run all tests
pnpm test -- --run     # Run once (no watch)
```

Use TDD: write failing tests first, then implement.

## Next Implementation Priorities

See `README.md` for the full support table. Priority candidates for implementation:

1. **`IN` operator** - List membership check in WHERE
   ```cypher
   MATCH (n:Person) WHERE n.name IN ['Alice', 'Bob'] RETURN n
   ```

2. **Arithmetic operators** - `+`, `-`, `*`, `/`, `%` in expressions
   ```cypher
   MATCH (n:Order) RETURN n.price * n.quantity AS total
   ```

3. **Date/Time functions** - `date()`, `datetime()`, `timestamp()`
   ```cypher
   RETURN date() AS today
   MATCH (n:Event) WHERE n.date > date('2024-01-01') RETURN n
   ```

4. **`CALL` procedures** - Lower priority
   ```cypher
   CALL db.labels() YIELD label RETURN label
   ```

## Key Patterns

- Parser produces AST (see interfaces in `parser.ts`: `Query`, `Clause`, `Expression`, etc.)
- Translator maintains context (`ctx`) to track variables, aliases, patterns
- Executor uses multi-phase execution for MATCH+CREATE/SET/DELETE queries
- Tests mirror source structure: `test/parser.test.ts`, `test/translator.test.ts`, etc.

## Implementation Notes

### Adding a new operator (e.g., `IN`)
1. Add token type in `parser.ts` tokenizer if needed
2. Add keyword to `KEYWORDS` set in `parser.ts`
3. Add condition type to `WhereCondition` interface
4. Implement parsing in `parsePrimaryCondition()` or `parseComparisonCondition()`
5. Implement SQL translation in `translateWhere()` in `translator.ts`
6. Write tests first in `translator.test.ts`

### Adding a new function
1. Add function handling in `translateExpression()` in `translator.ts`
2. Use `translateFunctionArg()` for argument translation
3. Map to appropriate SQLite function or expression
4. Write tests first in `translator.test.ts`

### Adding arithmetic operators
1. Extend `Expression` type to support binary operations
2. Add operator tokens (`PLUS`, `MINUS`, etc.) to tokenizer
3. Implement expression parsing with proper precedence
4. Translate to SQL arithmetic in `translateExpression()`

## Specs

See `graph-db-spec.md` for full project specification.
