/**
 * Random Cypher query generator for fuzzing.
 * Generates syntactically valid Cypher queries to test leangraph.
 */

export interface GeneratorConfig {
  seed?: number;
  maxDepth?: number;
  features?: Feature[];
}

export type Feature =
  | "literals"
  | "expressions"
  | "functions"
  | "match"
  | "create"
  | "with"
  | "where"
  | "orderby"
  | "aggregations"
  | "unwind"
  | "case"
  | "comprehensions";

export type Category =
  | "literal"
  | "expression"
  | "function"
  | "clause"
  | "aggregation"
  | "pattern";

export interface GeneratedQuery {
  query: string;
  category: Category;
  feature: Feature;
  needsSetup: boolean;
  setup?: string[];
}

// Seeded random number generator (mulberry32)
function createRng(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class QueryGenerator {
  private rng: () => number;
  private maxDepth: number;
  private features: Set<Feature>;

  // Neo4j 3.5 compatible functions
  private mathFunctions = [
    "abs",
    "ceil",
    "floor",
    "round",
    "sign",
    "sqrt",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "atan2",
    "exp",
    "log",
    "log10",
    "rand",
    "toInteger",
    "toFloat",
  ];

  private stringFunctions = [
    "left",
    "right",
    "ltrim",
    "rtrim",
    "trim",
    "replace",
    "reverse",
    "split",
    "substring",
    "toLower",
    "toUpper",
    "toString",
    "size",
  ];

  private listFunctions = [
    "head",
    "last",
    "tail",
    "size",
    "range",
    "reverse",
    "keys",
  ];

  private aggregateFunctions = [
    "count",
    "sum",
    "avg",
    "min",
    "max",
    "collect",
    "stDev",
    "stDevP",
  ];

  private predicateFunctions = [
    "exists",
    "all",
    "any",
    "none",
    "single",
  ];

  private labels = ["Person", "Movie", "Actor", "Director", "Company"];
  private relTypes = ["KNOWS", "ACTED_IN", "DIRECTED", "WORKS_FOR", "FRIENDS_WITH"];
  private propNames = ["name", "age", "title", "year", "rating", "active", "score"];
  private varNames = ["n", "m", "p", "q", "r", "x", "y", "a", "b", "c"];

  constructor(config: GeneratorConfig = {}) {
    const seed = config.seed ?? Math.floor(Math.random() * 1000000);
    this.rng = createRng(seed);
    this.maxDepth = config.maxDepth ?? 3;
    this.features = new Set(
      config.features ?? [
        "literals",
        "expressions",
        "functions",
        "match",
        "create",
        "with",
        "where",
        "orderby",
        "aggregations",
        "unwind",
        "case",
        "comprehensions",
      ]
    );
  }

  /**
   * Generate a random query.
   */
  generate(): GeneratedQuery {
    const generators: Array<() => GeneratedQuery> = [];

    if (this.features.has("literals")) {
      generators.push(() => this.generateLiteralQuery());
    }
    if (this.features.has("expressions")) {
      generators.push(() => this.generateExpressionQuery());
    }
    if (this.features.has("functions")) {
      generators.push(() => this.generateFunctionQuery());
    }
    if (this.features.has("match")) {
      generators.push(() => this.generateMatchQuery());
    }
    if (this.features.has("create")) {
      generators.push(() => this.generateCreateQuery());
    }
    if (this.features.has("with")) {
      generators.push(() => this.generateWithQuery());
    }
    if (this.features.has("aggregations")) {
      generators.push(() => this.generateAggregationQuery());
    }
    if (this.features.has("unwind")) {
      generators.push(() => this.generateUnwindQuery());
    }
    if (this.features.has("case")) {
      generators.push(() => this.generateCaseQuery());
    }
    if (this.features.has("comprehensions")) {
      generators.push(() => this.generateComprehensionQuery());
    }

    if (generators.length === 0) {
      return this.generateLiteralQuery();
    }

    return this.pick(generators)();
  }

  // ========== Query Generators ==========

  private generateLiteralQuery(): GeneratedQuery {
    const literal = this.generateLiteral();
    return {
      query: `RETURN ${literal}`,
      category: "literal",
      feature: "literals",
      needsSetup: false,
    };
  }

  private generateExpressionQuery(): GeneratedQuery {
    const expr = this.generateExpression(0);
    return {
      query: `RETURN ${expr}`,
      category: "expression",
      feature: "expressions",
      needsSetup: false,
    };
  }

  private generateFunctionQuery(): GeneratedQuery {
    const funcCall = this.generateFunctionCall();
    return {
      query: `RETURN ${funcCall}`,
      category: "function",
      feature: "functions",
      needsSetup: false,
    };
  }

  private generateMatchQuery(): GeneratedQuery {
    const v = this.pick(this.varNames);
    const label = this.pick(this.labels);
    const prop = this.pick(this.propNames);

    const patterns = [
      // Simple node match
      () => ({
        query: `MATCH (${v}:${label}) RETURN ${v}.${prop}, ${v}`,
        setup: [`CREATE (:${label} {${prop}: ${this.generateLiteral()}})`],
      }),
      // Match with WHERE
      () => ({
        query: `MATCH (${v}:${label}) WHERE ${v}.${prop} IS NOT NULL RETURN ${v}`,
        setup: [`CREATE (:${label} {${prop}: ${this.generateLiteral()}})`],
      }),
      // Match with relationship
      () => {
        const v2 = this.pickDifferent(this.varNames, v);
        const relType = this.pick(this.relTypes);
        return {
          query: `MATCH (${v}:${label})-[:${relType}]->(${v2}) RETURN ${v}, ${v2}`,
          setup: [
            `CREATE (:${label} {${prop}: 1})-[:${relType}]->(:${label} {${prop}: 2})`,
          ],
        };
      },
      // Match with ORDER BY and LIMIT
      () => ({
        query: `MATCH (${v}:${label}) RETURN ${v}.${prop} ORDER BY ${v}.${prop} DESC LIMIT 5`,
        setup: [
          `CREATE (:${label} {${prop}: 1})`,
          `CREATE (:${label} {${prop}: 2})`,
          `CREATE (:${label} {${prop}: 3})`,
        ],
      }),
      // Match with SKIP
      () => ({
        query: `MATCH (${v}:${label}) RETURN ${v} SKIP 1 LIMIT 2`,
        setup: [
          `CREATE (:${label} {${prop}: 1})`,
          `CREATE (:${label} {${prop}: 2})`,
          `CREATE (:${label} {${prop}: 3})`,
        ],
      }),
    ];

    const chosen = this.pick(patterns)();
    return {
      query: chosen.query,
      category: "pattern",
      feature: "match",
      needsSetup: true,
      setup: chosen.setup,
    };
  }

  private generateCreateQuery(): GeneratedQuery {
    const v = this.pick(this.varNames);
    const label = this.pick(this.labels);
    const prop = this.pick(this.propNames);
    const value = this.generateLiteral();

    const patterns = [
      // Simple CREATE
      `CREATE (${v}:${label} {${prop}: ${value}}) RETURN ${v}`,
      // CREATE with multiple properties
      `CREATE (${v}:${label} {${prop}: ${value}, active: true}) RETURN ${v}.${prop}`,
      // CREATE relationship
      `CREATE (a:${label})-[r:${this.pick(this.relTypes)}]->(b:${label}) RETURN a, r, b`,
    ];

    return {
      query: this.pick(patterns),
      category: "clause",
      feature: "create",
      needsSetup: false,
    };
  }

  private generateWithQuery(): GeneratedQuery {
    const expr = this.generateExpression(0);

    const patterns = [
      `WITH ${expr} AS x RETURN x`,
      `WITH ${expr} AS x, ${this.generateLiteral()} AS y RETURN x, y`,
      `WITH [1, 2, 3] AS list RETURN size(list)`,
      `WITH {a: 1, b: 2} AS map RETURN map.a, map.b`,
      `WITH ${this.generateLiteral()} AS x WHERE x IS NOT NULL RETURN x`,
    ];

    return {
      query: this.pick(patterns),
      category: "clause",
      feature: "with",
      needsSetup: false,
    };
  }

  private generateAggregationQuery(): GeneratedQuery {
    const label = this.pick(this.labels);
    const prop = this.pick(this.propNames);
    const aggFunc = this.pick(["count", "sum", "avg", "min", "max", "collect"]);

    const patterns = [
      // count(*)
      () => ({
        query: `MATCH (n:${label}) RETURN count(*)`,
        setup: [`CREATE (:${label})`, `CREATE (:${label})`],
      }),
      // Aggregate on property
      () => ({
        query: `MATCH (n:${label}) RETURN ${aggFunc}(n.${prop})`,
        setup: [
          `CREATE (:${label} {${prop}: 10})`,
          `CREATE (:${label} {${prop}: 20})`,
        ],
      }),
      // Group by with aggregation
      () => ({
        query: `MATCH (n:${label}) RETURN n.type, count(*) AS cnt`,
        setup: [
          `CREATE (:${label} {type: 'A'})`,
          `CREATE (:${label} {type: 'A'})`,
          `CREATE (:${label} {type: 'B'})`,
        ],
      }),
      // DISTINCT
      () => ({
        query: `MATCH (n:${label}) RETURN DISTINCT n.${prop}`,
        setup: [
          `CREATE (:${label} {${prop}: 1})`,
          `CREATE (:${label} {${prop}: 1})`,
          `CREATE (:${label} {${prop}: 2})`,
        ],
      }),
    ];

    const chosen = this.pick(patterns)();
    return {
      query: chosen.query,
      category: "aggregation",
      feature: "aggregations",
      needsSetup: true,
      setup: chosen.setup,
    };
  }

  private generateUnwindQuery(): GeneratedQuery {
    const patterns = [
      `UNWIND [1, 2, 3] AS x RETURN x`,
      `UNWIND range(1, 5) AS x RETURN x * 2`,
      `WITH [1, 2, 3] AS list UNWIND list AS x RETURN x`,
      `UNWIND [{a: 1}, {a: 2}] AS map RETURN map.a`,
      `UNWIND [[1, 2], [3, 4]] AS inner RETURN inner`,
    ];

    return {
      query: this.pick(patterns),
      category: "clause",
      feature: "unwind",
      needsSetup: false,
    };
  }

  private generateCaseQuery(): GeneratedQuery {
    const patterns = [
      `RETURN CASE WHEN true THEN 1 ELSE 0 END`,
      `RETURN CASE WHEN 1 > 2 THEN 'a' WHEN 2 > 1 THEN 'b' ELSE 'c' END`,
      `WITH 5 AS x RETURN CASE x WHEN 1 THEN 'one' WHEN 5 THEN 'five' ELSE 'other' END`,
      `RETURN CASE WHEN null IS NULL THEN 'null' ELSE 'not null' END`,
      `WITH [1, 2, 3] AS list RETURN CASE WHEN size(list) > 0 THEN head(list) ELSE null END`,
    ];

    return {
      query: this.pick(patterns),
      category: "expression",
      feature: "case",
      needsSetup: false,
    };
  }

  private generateComprehensionQuery(): GeneratedQuery {
    const patterns = [
      `RETURN [x IN [1, 2, 3] | x * 2]`,
      `RETURN [x IN range(1, 5) WHERE x % 2 = 0]`,
      `RETURN [x IN [1, 2, 3] WHERE x > 1 | x * x]`,
      `WITH [1, 2, 3, 4, 5] AS list RETURN [x IN list WHERE x > 2]`,
      `RETURN [x IN ['a', 'b', 'c'] | toUpper(x)]`,
    ];

    return {
      query: this.pick(patterns),
      category: "expression",
      feature: "comprehensions",
      needsSetup: false,
    };
  }

  // ========== Expression Generators ==========

  private generateLiteral(): string {
    const type = this.randInt(0, 7);
    switch (type) {
      case 0: // Integer
        return String(this.randInt(-100, 100));
      case 1: // Float
        return (this.rng() * 200 - 100).toFixed(2);
      case 2: // String
        return `'${this.pick(["hello", "world", "test", "foo", "bar"])}'`;
      case 3: // Boolean
        return this.rng() < 0.5 ? "true" : "false";
      case 4: // null
        return "null";
      case 5: // List
        return `[${this.generateLiteral()}, ${this.generateLiteral()}]`;
      case 6: // Map
        return `{a: ${this.generateLiteral()}, b: ${this.generateLiteral()}}`;
      default:
        return String(this.randInt(0, 10));
    }
  }

  private generateExpression(depth: number): string {
    if (depth >= this.maxDepth) {
      return this.generateLiteral();
    }

    const type = this.randInt(0, 5);
    switch (type) {
      case 0: // Arithmetic
        return this.generateArithmeticExpr(depth);
      case 1: // Comparison (wrapped for RETURN)
        return this.generateComparisonExpr(depth);
      case 2: // String concat
        return `'hello' + ' ' + 'world'`;
      case 3: // Property access on map
        return `{a: 1, b: 2}.${this.rng() < 0.5 ? "a" : "b"}`;
      case 4: // List index
        return `[1, 2, 3][${this.randInt(0, 2)}]`;
      default:
        return this.generateLiteral();
    }
  }

  private generateArithmeticExpr(depth: number): string {
    const left = depth < this.maxDepth - 1 ? this.generateExpression(depth + 1) : this.generateLiteral();
    const right = depth < this.maxDepth - 1 ? this.generateExpression(depth + 1) : this.generateLiteral();
    const op = this.pick(["+", "-", "*", "/", "%", "^"]);

    // Avoid division by zero and modulo by zero
    if (op === "/" || op === "%") {
      return `(${left}) ${op} (${this.randInt(1, 10)})`;
    }

    return `(${left}) ${op} (${right})`;
  }

  private generateComparisonExpr(depth: number): string {
    const left = this.generateLiteral();
    const right = this.generateLiteral();
    const op = this.pick(["=", "<>", "<", ">", "<=", ">="]);
    return `${left} ${op} ${right}`;
  }

  private generateFunctionCall(): string {
    const category = this.randInt(0, 4);

    switch (category) {
      case 0: // Math function
        return this.generateMathFunction();
      case 1: // String function
        return this.generateStringFunction();
      case 2: // List function
        return this.generateListFunction();
      case 3: // Type functions
        return this.generateTypeFunction();
      default:
        return this.generateMathFunction();
    }
  }

  private generateMathFunction(): string {
    const func = this.pick(this.mathFunctions);
    const num = (this.rng() * 20 - 10).toFixed(2);

    switch (func) {
      case "atan2":
        return `atan2(${num}, ${(this.rng() * 10).toFixed(2)})`;
      case "rand":
        return "rand()";
      case "toInteger":
        return `toInteger(${num})`;
      case "toFloat":
        return `toFloat(${this.randInt(-10, 10)})`;
      default:
        // For trig functions, use abs to avoid domain errors
        if (["asin", "acos"].includes(func)) {
          return `${func}(${(this.rng() * 2 - 1).toFixed(2)})`;
        }
        // For sqrt/log, use abs
        if (["sqrt", "log", "log10"].includes(func)) {
          return `${func}(abs(${num}) + 1)`;
        }
        return `${func}(${num})`;
    }
  }

  private generateStringFunction(): string {
    const func = this.pick(this.stringFunctions);
    const str = `'${this.pick(["hello", "world", "TEST", "  spaces  ", "foo bar"])}'`;

    switch (func) {
      case "left":
      case "right":
        return `${func}(${str}, ${this.randInt(1, 5)})`;
      case "substring":
        return `substring(${str}, ${this.randInt(0, 3)}, ${this.randInt(1, 5)})`;
      case "replace":
        return `replace(${str}, 'o', 'O')`;
      case "split":
        return `split(${str}, ' ')`;
      case "size":
        return `size(${str})`;
      default:
        return `${func}(${str})`;
    }
  }

  private generateListFunction(): string {
    const func = this.pick(this.listFunctions);
    const list = `[1, 2, 3, 4, 5]`;

    switch (func) {
      case "range":
        return `range(${this.randInt(0, 5)}, ${this.randInt(5, 10)})`;
      case "keys":
        return `keys({a: 1, b: 2, c: 3})`;
      default:
        return `${func}(${list})`;
    }
  }

  private generateTypeFunction(): string {
    const funcs = [
      `type(null)`,
      `coalesce(null, 1, 2)`,
      `coalesce(null, null, 'default')`,
    ];
    return this.pick(funcs);
  }

  // ========== Utility Methods ==========

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rng() * arr.length)];
  }

  private pickDifferent<T>(arr: T[], exclude: T): T {
    const filtered = arr.filter((x) => x !== exclude);
    return this.pick(filtered.length > 0 ? filtered : arr);
  }

  private randInt(min: number, max: number): number {
    return Math.floor(this.rng() * (max - min + 1)) + min;
  }
}
