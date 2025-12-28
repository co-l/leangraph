# NiceFox GraphDB

> **Warning**: This project is under active development and not yet production-ready.

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
| `IN` | Not supported |
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
| `CALL` (procedures) | Not supported |

### Operators

| Operator | Status | Description |
|----------|--------|-------------|
| `=`, `<>`, `<`, `>`, `<=`, `>=` | Supported | Comparison operators |
| `+`, `-`, `*`, `/`, `%` | Not supported | Arithmetic operators |

### Functions

| Function | Status | Description |
|----------|--------|-------------|
| **Aggregation** | | |
| `COUNT(x)` | Supported | Count results |
| `SUM(x.prop)` | Supported | Sum numeric values |
| `AVG(x.prop)` | Supported | Average of numeric values |
| `MIN(x.prop)` | Supported | Minimum value |
| `MAX(x.prop)` | Supported | Maximum value |
| `COLLECT(x)` | Supported | Collect values into a list |
| **Scalar** | | |
| `ID(x)` | Supported | Get node/edge ID |
| `coalesce(a, b, ...)` | Supported | Return first non-null value |
| **String** | | |
| `toUpper(s)` | Supported | Convert to uppercase |
| `toLower(s)` | Supported | Convert to lowercase |
| `trim(s)` | Supported | Remove leading/trailing whitespace |
| `substring(s, start, len)` | Supported | Extract substring |
| `replace(s, from, to)` | Supported | Replace occurrences |
| `toString(x)` | Supported | Convert to string |
| `split(s, delim)` | Supported | Split string into list |
| **List** | | |
| `size(list)` | Supported | Length of list |
| `head(list)` | Supported | First element |
| `last(list)` | Supported | Last element |
| `keys(x)` | Supported | Get property keys |
| `tail(list)` | Supported | All but first element |
| `range(start, end)` | Supported | Generate number list |
| **Node/Relationship** | | |
| `labels(n)` | Supported | Get node labels |
| `type(r)` | Supported | Get relationship type |
| `properties(x)` | Supported | Get all properties as map |
| **Math** | | |
| `abs(x)` | Supported | Absolute value |
| `ceil(x)` | Supported | Round up |
| `floor(x)` | Supported | Round down |
| `round(x)` | Supported | Round to nearest integer |
| `rand()` | Supported | Random float 0-1 |
| `sqrt(x)` | Supported | Square root (requires SQLite math extension) |
| **Date/Time** | | |
| `date()` | Not supported | Current date |
| `datetime()` | Not supported | Current datetime |
| `timestamp()` | Not supported | Unix timestamp |

## Next Implementation Priorities

The following features are planned for implementation (use TDD):

### 1. `IN` operator
```cypher
MATCH (n:Person) WHERE n.name IN ['Alice', 'Bob'] RETURN n
MATCH (n:Person) WHERE n.age IN $ages RETURN n
```

### 2. Arithmetic operators
```cypher
MATCH (n:Order) RETURN n.price * n.quantity AS total
MATCH (n:Product) RETURN n.price + 10 AS adjustedPrice
MATCH (n:Item) RETURN n.total / n.count AS average
```

### 3. Date/Time functions
```cypher
RETURN date() AS today
RETURN datetime() AS now
RETURN timestamp() AS ts
MATCH (n:Event) WHERE n.date > date('2024-01-01') RETURN n
```

### 4. `CALL` procedures (lower priority)
```cypher
CALL db.labels() YIELD label RETURN label
CALL db.relationshipTypes() YIELD type RETURN type
```
