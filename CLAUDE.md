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

1. **`CALL` procedures** - Database introspection
   ```cypher
   CALL db.labels() YIELD label RETURN label
   CALL db.relationshipTypes() YIELD type RETURN type
   ```

2. **Path expressions** - Named paths and path functions
   ```cypher
   MATCH p = (a:Person)-[:KNOWS*]->(b:Person) RETURN p
   RETURN length(p) AS pathLength
   ```

3. **List comprehensions** - Filter and transform lists
   ```cypher
   RETURN [x IN range(1, 10) WHERE x % 2 = 0] AS evens
   ```

## Key Patterns

- Parser produces AST (see interfaces in `parser.ts`: `Query`, `Clause`, `Expression`, etc.)
- Translator maintains context (`ctx`) to track variables, aliases, patterns
- Executor uses multi-phase execution for MATCH+CREATE/SET/DELETE queries
- Tests mirror source structure: `test/parser.test.ts`, `test/translator.test.ts`, etc.

## Implementation Notes

### Adding a new WHERE operator (e.g., `IN`)
1. Add keyword to `KEYWORDS` set in `parser.ts` if needed
2. Add condition type to `WhereCondition` interface (e.g., `"in"`)
3. Implement parsing in `parseComparisonCondition()` - check for keyword after expression
4. Add case handling in `translateWhere()` in `translator.ts`
5. Write tests first in `translator.test.ts`

Example: `IN` uses `WhereCondition.list` for the array expression.

### Adding a new function
1. Add function handling in `translateExpression()` in `translator.ts`
2. Use `translateFunctionArg()` for argument translation
3. Map to appropriate SQLite function or expression
4. For use in WHERE, also add case `"function"` in `translateWhereExpression()`
5. Write tests first in `translator.test.ts`

### Adding binary operators (arithmetic)
1. Add token types (`PLUS`, `SLASH`, `PERCENT`) to tokenizer's `singleCharTokens`
2. Extend `Expression` type to include `"binary"` with `operator`, `left`, `right`
3. Use precedence parsing: `parseExpression()` → `parseAdditiveExpression()` → `parseMultiplicativeExpression()` → `parsePrimaryExpression()`
4. Add `translateBinaryExpression()` in translator
5. Handle in `translateWhereExpression()` for WHERE clause arithmetic

## Specs

See `graph-db-spec.md` for full project specification.
