// Cypher → SQL Translator
// ============================================================================
// Translator
// ============================================================================
export class Translator {
    ctx;
    constructor(paramValues = {}) {
        this.ctx = {
            variables: new Map(),
            paramValues,
            aliasCounter: 0,
        };
    }
    translate(query) {
        const statements = [];
        let returnColumns;
        for (const clause of query.clauses) {
            const result = this.translateClause(clause);
            if (result.statements) {
                statements.push(...result.statements);
            }
            if (result.returnColumns) {
                returnColumns = result.returnColumns;
            }
        }
        return { statements, returnColumns };
    }
    translateClause(clause) {
        switch (clause.type) {
            case "CREATE":
                return { statements: this.translateCreate(clause) };
            case "MATCH":
                return { statements: this.translateMatch(clause, false) };
            case "OPTIONAL_MATCH":
                return { statements: this.translateMatch(clause, true) };
            case "MERGE":
                return { statements: this.translateMerge(clause) };
            case "SET":
                return { statements: this.translateSet(clause) };
            case "DELETE":
                return { statements: this.translateDelete(clause) };
            case "RETURN":
                return this.translateReturn(clause);
            case "WITH":
                return { statements: this.translateWith(clause) };
            case "UNWIND":
                return { statements: this.translateUnwind(clause) };
            case "UNION":
                return this.translateUnion(clause);
            default:
                throw new Error(`Unknown clause type: ${clause.type}`);
        }
    }
    // ============================================================================
    // CREATE
    // ============================================================================
    translateCreate(clause) {
        const statements = [];
        for (const pattern of clause.patterns) {
            if (this.isRelationshipPattern(pattern)) {
                statements.push(...this.translateCreateRelationship(pattern));
            }
            else {
                statements.push(this.translateCreateNode(pattern));
            }
        }
        return statements;
    }
    translateCreateNode(node) {
        const id = this.generateId();
        const label = node.label || "";
        const properties = this.serializeProperties(node.properties || {});
        if (node.variable) {
            this.ctx.variables.set(node.variable, { type: "node", alias: id });
        }
        return {
            sql: "INSERT INTO nodes (id, label, properties) VALUES (?, ?, ?)",
            params: [id, label, properties.json],
        };
    }
    translateCreateRelationship(rel) {
        const statements = [];
        // Create source node if it has a label (new node)
        let sourceId;
        if (rel.source.label) {
            const sourceStmt = this.translateCreateNode(rel.source);
            statements.push(sourceStmt);
            sourceId = sourceStmt.params[0];
        }
        else if (rel.source.variable) {
            const existing = this.ctx.variables.get(rel.source.variable);
            if (!existing) {
                throw new Error(`Unknown variable: ${rel.source.variable}`);
            }
            sourceId = existing.alias;
        }
        else {
            throw new Error("Source node must have a label or reference an existing variable");
        }
        // Create target node if it has a label (new node)
        let targetId;
        if (rel.target.label) {
            const targetStmt = this.translateCreateNode(rel.target);
            statements.push(targetStmt);
            targetId = targetStmt.params[0];
        }
        else if (rel.target.variable) {
            const existing = this.ctx.variables.get(rel.target.variable);
            if (!existing) {
                throw new Error(`Unknown variable: ${rel.target.variable}`);
            }
            targetId = existing.alias;
        }
        else {
            throw new Error("Target node must have a label or reference an existing variable");
        }
        // Create edge
        const edgeId = this.generateId();
        const edgeType = rel.edge.type || "";
        const edgeProperties = this.serializeProperties(rel.edge.properties || {});
        if (rel.edge.variable) {
            this.ctx.variables.set(rel.edge.variable, { type: "edge", alias: edgeId });
        }
        // Swap source/target for left-directed relationships
        const [actualSource, actualTarget] = rel.edge.direction === "left" ? [targetId, sourceId] : [sourceId, targetId];
        statements.push({
            sql: "INSERT INTO edges (id, type, source_id, target_id, properties) VALUES (?, ?, ?, ?, ?)",
            params: [edgeId, edgeType, actualSource, actualTarget, edgeProperties.json],
        });
        return statements;
    }
    // ============================================================================
    // MATCH
    // ============================================================================
    translateMatch(clause, optional = false) {
        // MATCH doesn't produce standalone statements - it sets up context for RETURN/SET/DELETE
        // The actual SELECT is generated when we encounter RETURN
        for (const pattern of clause.patterns) {
            if (this.isRelationshipPattern(pattern)) {
                this.registerRelationshipPattern(pattern, optional);
            }
            else {
                this.registerNodePattern(pattern, optional);
            }
        }
        // Store the where clause in context for later use
        // For OPTIONAL MATCH, we need to associate the where with the optional patterns
        if (clause.where) {
            if (optional) {
                // Store optional where clauses separately to apply them correctly
                if (!this.ctx.optionalWhereClauses) {
                    this.ctx.optionalWhereClauses = [];
                }
                this.ctx.optionalWhereClauses.push(clause.where);
            }
            else {
                this.ctx.whereClause = clause.where;
            }
        }
        return [];
    }
    registerNodePattern(node, optional = false) {
        const alias = `n${this.ctx.aliasCounter++}`;
        if (node.variable) {
            this.ctx.variables.set(node.variable, { type: "node", alias });
        }
        // Store pattern info for later
        this.ctx[`pattern_${alias}`] = node;
        // Track if this node pattern is optional
        this.ctx[`optional_${alias}`] = optional;
        return alias;
    }
    registerRelationshipPattern(rel, optional = false) {
        // Check if source node is already registered (for chained patterns or multi-MATCH)
        let sourceAlias;
        let sourceIsNew = false;
        if (rel.source.variable && this.ctx.variables.has(rel.source.variable)) {
            sourceAlias = this.ctx.variables.get(rel.source.variable).alias;
        }
        else {
            sourceAlias = this.registerNodePattern(rel.source, optional);
            sourceIsNew = true;
        }
        // Check if target node is already registered (for multi-MATCH shared variables)
        let targetAlias;
        let targetIsNew = false;
        if (rel.target.variable && this.ctx.variables.has(rel.target.variable)) {
            targetAlias = this.ctx.variables.get(rel.target.variable).alias;
        }
        else {
            targetAlias = this.registerNodePattern(rel.target, optional);
            targetIsNew = true;
        }
        const edgeAlias = `e${this.ctx.aliasCounter++}`;
        if (rel.edge.variable) {
            this.ctx.variables.set(rel.edge.variable, { type: "edge", alias: edgeAlias });
        }
        this.ctx[`pattern_${edgeAlias}`] = rel.edge;
        this.ctx[`optional_${edgeAlias}`] = optional;
        // Store relationship patterns as an array to support multi-hop
        if (!this.ctx.relationshipPatterns) {
            this.ctx.relationshipPatterns = [];
        }
        // Check if this is a variable-length pattern
        const isVariableLength = rel.edge.minHops !== undefined || rel.edge.maxHops !== undefined;
        this.ctx.relationshipPatterns.push({
            sourceAlias,
            targetAlias,
            edgeAlias,
            edge: rel.edge,
            optional,
            sourceIsNew,
            targetIsNew,
            isVariableLength,
            minHops: rel.edge.minHops,
            maxHops: rel.edge.maxHops,
        });
        // Keep backwards compatibility with single pattern
        this.ctx.relationshipPattern = { sourceAlias, targetAlias, edgeAlias, edge: rel.edge, optional };
    }
    // ============================================================================
    // MERGE
    // ============================================================================
    translateMerge(clause) {
        // MERGE: Create if not exists, match if exists
        // This requires multiple statements or an UPSERT pattern
        const node = clause.pattern;
        const label = node.label || "";
        const props = node.properties || {};
        const serialized = this.serializeProperties(props);
        // Build condition to find existing node
        const conditions = ["label = ?"];
        const params = [label];
        for (const [key, value] of Object.entries(props)) {
            if (this.isParameterRef(value)) {
                conditions.push(`json_extract(properties, '$.${key}') = ?`);
                params.push(this.ctx.paramValues[value.name]);
            }
            else {
                conditions.push(`json_extract(properties, '$.${key}') = ?`);
                params.push(value);
            }
        }
        const id = this.generateId();
        if (node.variable) {
            this.ctx.variables.set(node.variable, { type: "node", alias: id });
        }
        // SQLite INSERT OR IGNORE + SELECT approach
        // First, try to insert
        const insertSql = `INSERT OR IGNORE INTO nodes (id, label, properties) 
      SELECT ?, ?, ? 
      WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE ${conditions.join(" AND ")})`;
        return [
            {
                sql: insertSql,
                params: [id, label, serialized.json, ...params],
            },
        ];
    }
    // ============================================================================
    // SET
    // ============================================================================
    translateSet(clause) {
        const statements = [];
        for (const assignment of clause.assignments) {
            const varInfo = this.ctx.variables.get(assignment.variable);
            if (!varInfo) {
                throw new Error(`Unknown variable: ${assignment.variable}`);
            }
            const table = varInfo.type === "node" ? "nodes" : "edges";
            const value = this.evaluateExpression(assignment.value);
            // Use json_set to update the property
            statements.push({
                sql: `UPDATE ${table} SET properties = json_set(properties, '$.${assignment.property}', json(?)) WHERE id = ?`,
                params: [JSON.stringify(value), varInfo.alias],
            });
        }
        return statements;
    }
    // ============================================================================
    // DELETE
    // ============================================================================
    translateDelete(clause) {
        const statements = [];
        for (const variable of clause.variables) {
            const varInfo = this.ctx.variables.get(variable);
            if (!varInfo) {
                throw new Error(`Unknown variable: ${variable}`);
            }
            const table = varInfo.type === "node" ? "nodes" : "edges";
            if (clause.detach && varInfo.type === "node") {
                // DETACH DELETE: First delete all edges connected to this node
                statements.push({
                    sql: "DELETE FROM edges WHERE source_id = ? OR target_id = ?",
                    params: [varInfo.alias, varInfo.alias],
                });
            }
            statements.push({
                sql: `DELETE FROM ${table} WHERE id = ?`,
                params: [varInfo.alias],
            });
        }
        return statements;
    }
    // ============================================================================
    // RETURN
    // ============================================================================
    translateReturn(clause) {
        const selectParts = [];
        const returnColumns = [];
        const fromParts = [];
        const joinParts = [];
        const joinParams = []; // Parameters for JOIN ON clauses
        const whereParts = [];
        const whereParams = []; // Parameters for WHERE clause
        // Apply WITH modifiers if present
        const withDistinct = this.ctx.withDistinct;
        const withOrderBy = this.ctx.withOrderBy;
        const withSkip = this.ctx.withSkip;
        const withLimit = this.ctx.withLimit;
        const withWhere = this.ctx.withWhere;
        // Track which tables we need
        const neededTables = new Set();
        // Process return items
        const exprParams = [];
        for (const item of clause.items) {
            const { sql: exprSql, tables, params: itemParams } = this.translateExpression(item.expression);
            tables.forEach((t) => neededTables.add(t));
            exprParams.push(...itemParams);
            const alias = item.alias || this.getExpressionName(item.expression);
            selectParts.push(`${exprSql} AS ${alias}`);
            returnColumns.push(alias);
        }
        // Build FROM clause based on registered patterns
        const relPatterns = this.ctx.relationshipPatterns;
        // Check if any pattern is variable-length
        const hasVariableLengthPattern = relPatterns?.some(p => p.isVariableLength);
        if (hasVariableLengthPattern && relPatterns) {
            // Use recursive CTE for variable-length paths
            return this.translateVariableLengthPath(clause, relPatterns, selectParts, returnColumns, exprParams, whereParams);
        }
        if (relPatterns && relPatterns.length > 0) {
            // Track which node aliases we've already added to FROM/JOIN
            const addedNodeAliases = new Set();
            // Track which node aliases have had their filters added (to avoid duplicates)
            const filteredNodeAliases = new Set();
            // Relationship query - handle multi-hop patterns
            for (let i = 0; i < relPatterns.length; i++) {
                const relPattern = relPatterns[i];
                const isOptional = relPattern.optional === true;
                const joinType = isOptional ? "LEFT JOIN" : "JOIN";
                if (i === 0 && !isOptional) {
                    // First non-optional relationship: add source node to FROM
                    fromParts.push(`nodes ${relPattern.sourceAlias}`);
                    addedNodeAliases.add(relPattern.sourceAlias);
                }
                else if (!addedNodeAliases.has(relPattern.sourceAlias)) {
                    // For subsequent patterns, if source is not already added, we need to JOIN it
                    // For optional patterns, use LEFT JOIN
                    if (isOptional && relPattern.sourceIsNew) {
                        // This shouldn't happen often - optional patterns usually reference existing nodes
                        joinParts.push(`${joinType} nodes ${relPattern.sourceAlias} ON 1=1`);
                    }
                    else if (i === 0) {
                        // First pattern is optional but source is new - add to FROM
                        fromParts.push(`nodes ${relPattern.sourceAlias}`);
                    }
                    else {
                        joinParts.push(`JOIN nodes ${relPattern.sourceAlias} ON 1=1`);
                    }
                    addedNodeAliases.add(relPattern.sourceAlias);
                }
                // Build ON conditions for the edge join
                let edgeOnConditions = [];
                let edgeOnParams = [];
                // Add edge join - need to determine direction based on whether source/target already exist
                if (addedNodeAliases.has(relPattern.targetAlias) && !addedNodeAliases.has(relPattern.sourceAlias)) {
                    edgeOnConditions.push(`${relPattern.edgeAlias}.target_id = ${relPattern.targetAlias}.id`);
                }
                else {
                    edgeOnConditions.push(`${relPattern.edgeAlias}.source_id = ${relPattern.sourceAlias}.id`);
                }
                // For optional patterns, add type filter to ON clause instead of WHERE
                if (relPattern.edge.type) {
                    if (isOptional) {
                        edgeOnConditions.push(`${relPattern.edgeAlias}.type = ?`);
                        edgeOnParams.push(relPattern.edge.type);
                    }
                    else {
                        whereParts.push(`${relPattern.edgeAlias}.type = ?`);
                        whereParams.push(relPattern.edge.type);
                    }
                }
                joinParts.push(`${joinType} edges ${relPattern.edgeAlias} ON ${edgeOnConditions.join(" AND ")}`);
                joinParams.push(...edgeOnParams);
                // Build ON conditions for the target node join
                let targetOnConditions = [];
                let targetOnParams = [];
                // Add target node join if not already added
                if (!addedNodeAliases.has(relPattern.targetAlias)) {
                    targetOnConditions.push(`${relPattern.edgeAlias}.target_id = ${relPattern.targetAlias}.id`);
                    // For optional patterns, add label and property filters to ON clause
                    const targetPattern = this.ctx[`pattern_${relPattern.targetAlias}`];
                    if (isOptional && targetPattern?.label) {
                        targetOnConditions.push(`${relPattern.targetAlias}.label = ?`);
                        targetOnParams.push(targetPattern.label);
                        filteredNodeAliases.add(relPattern.targetAlias);
                    }
                    if (isOptional && targetPattern?.properties) {
                        for (const [key, value] of Object.entries(targetPattern.properties)) {
                            if (this.isParameterRef(value)) {
                                targetOnConditions.push(`json_extract(${relPattern.targetAlias}.properties, '$.${key}') = ?`);
                                targetOnParams.push(this.ctx.paramValues[value.name]);
                            }
                            else {
                                targetOnConditions.push(`json_extract(${relPattern.targetAlias}.properties, '$.${key}') = ?`);
                                targetOnParams.push(value);
                            }
                        }
                    }
                    joinParts.push(`${joinType} nodes ${relPattern.targetAlias} ON ${targetOnConditions.join(" AND ")}`);
                    joinParams.push(...targetOnParams);
                    addedNodeAliases.add(relPattern.targetAlias);
                }
                else {
                    // Target was already added, but we need to ensure edge connects to it
                    // Add WHERE condition to connect edge's target to the existing node
                    if (isOptional) {
                        // For optional, we need to handle this in ON clause of edge
                        // This is already handled above by adding to edgeOnConditions
                        whereParts.push(`(${relPattern.edgeAlias}.id IS NULL OR ${relPattern.edgeAlias}.target_id = ${relPattern.targetAlias}.id)`);
                    }
                    else {
                        whereParts.push(`${relPattern.edgeAlias}.target_id = ${relPattern.targetAlias}.id`);
                    }
                }
                // Add source node filters (label and properties) if not already done and not optional
                if (!filteredNodeAliases.has(relPattern.sourceAlias)) {
                    const sourcePattern = this.ctx[`pattern_${relPattern.sourceAlias}`];
                    const sourceIsOptional = this.ctx[`optional_${relPattern.sourceAlias}`] === true;
                    if (sourcePattern?.label) {
                        if (sourceIsOptional) {
                            // For optional source nodes, this shouldn't happen often
                            // as optional patterns usually reference required nodes
                        }
                        else {
                            whereParts.push(`${relPattern.sourceAlias}.label = ?`);
                            whereParams.push(sourcePattern.label);
                        }
                    }
                    if (sourcePattern?.properties && !sourceIsOptional) {
                        for (const [key, value] of Object.entries(sourcePattern.properties)) {
                            if (this.isParameterRef(value)) {
                                whereParts.push(`json_extract(${relPattern.sourceAlias}.properties, '$.${key}') = ?`);
                                whereParams.push(this.ctx.paramValues[value.name]);
                            }
                            else {
                                whereParts.push(`json_extract(${relPattern.sourceAlias}.properties, '$.${key}') = ?`);
                                whereParams.push(value);
                            }
                        }
                    }
                    filteredNodeAliases.add(relPattern.sourceAlias);
                }
                // Add target node filters (label and properties) if not already done and not optional
                if (!filteredNodeAliases.has(relPattern.targetAlias)) {
                    const targetPattern = this.ctx[`pattern_${relPattern.targetAlias}`];
                    if (!isOptional) {
                        if (targetPattern?.label) {
                            whereParts.push(`${relPattern.targetAlias}.label = ?`);
                            whereParams.push(targetPattern.label);
                        }
                        if (targetPattern?.properties) {
                            for (const [key, value] of Object.entries(targetPattern.properties)) {
                                if (this.isParameterRef(value)) {
                                    whereParts.push(`json_extract(${relPattern.targetAlias}.properties, '$.${key}') = ?`);
                                    whereParams.push(this.ctx.paramValues[value.name]);
                                }
                                else {
                                    whereParts.push(`json_extract(${relPattern.targetAlias}.properties, '$.${key}') = ?`);
                                    whereParams.push(value);
                                }
                            }
                        }
                    }
                    filteredNodeAliases.add(relPattern.targetAlias);
                }
            }
        }
        else {
            // Simple node query (no relationships)
            let hasFromClause = false;
            for (const [variable, info] of this.ctx.variables) {
                const pattern = this.ctx[`pattern_${info.alias}`];
                const isOptional = this.ctx[`optional_${info.alias}`] === true;
                if (pattern && info.type === "node") {
                    if (!hasFromClause && !isOptional) {
                        // First non-optional node goes in FROM
                        fromParts.push(`nodes ${info.alias}`);
                        hasFromClause = true;
                        if (pattern.label) {
                            whereParts.push(`${info.alias}.label = ?`);
                            whereParams.push(pattern.label);
                        }
                        if (pattern.properties) {
                            for (const [key, value] of Object.entries(pattern.properties)) {
                                if (this.isParameterRef(value)) {
                                    whereParts.push(`json_extract(${info.alias}.properties, '$.${key}') = ?`);
                                    whereParams.push(this.ctx.paramValues[value.name]);
                                }
                                else {
                                    whereParts.push(`json_extract(${info.alias}.properties, '$.${key}') = ?`);
                                    whereParams.push(value);
                                }
                            }
                        }
                    }
                    else if (isOptional) {
                        // Optional node - use LEFT JOIN
                        const onConditions = ["1=1"];
                        const onParams = [];
                        if (pattern.label) {
                            onConditions.push(`${info.alias}.label = ?`);
                            onParams.push(pattern.label);
                        }
                        if (pattern.properties) {
                            for (const [key, value] of Object.entries(pattern.properties)) {
                                if (this.isParameterRef(value)) {
                                    onConditions.push(`json_extract(${info.alias}.properties, '$.${key}') = ?`);
                                    onParams.push(this.ctx.paramValues[value.name]);
                                }
                                else {
                                    onConditions.push(`json_extract(${info.alias}.properties, '$.${key}') = ?`);
                                    onParams.push(value);
                                }
                            }
                        }
                        joinParts.push(`LEFT JOIN nodes ${info.alias} ON ${onConditions.join(" AND ")}`);
                        joinParams.push(...onParams);
                    }
                    else {
                        // Non-optional node that's not the first - use regular JOIN
                        fromParts.push(`nodes ${info.alias}`);
                        if (pattern.label) {
                            whereParts.push(`${info.alias}.label = ?`);
                            whereParams.push(pattern.label);
                        }
                        if (pattern.properties) {
                            for (const [key, value] of Object.entries(pattern.properties)) {
                                if (this.isParameterRef(value)) {
                                    whereParts.push(`json_extract(${info.alias}.properties, '$.${key}') = ?`);
                                    whereParams.push(this.ctx.paramValues[value.name]);
                                }
                                else {
                                    whereParts.push(`json_extract(${info.alias}.properties, '$.${key}') = ?`);
                                    whereParams.push(value);
                                }
                            }
                        }
                    }
                }
            }
        }
        // Add UNWIND tables using json_each
        const unwindClauses = this.ctx.unwindClauses;
        if (unwindClauses && unwindClauses.length > 0) {
            for (const unwindClause of unwindClauses) {
                // Use CROSS JOIN with json_each to expand the array
                if (fromParts.length === 0 && joinParts.length === 0) {
                    // No FROM yet, use json_each directly
                    fromParts.push(`json_each(${unwindClause.jsonExpr}) ${unwindClause.alias}`);
                }
                else {
                    // Add as a cross join
                    joinParts.push(`CROSS JOIN json_each(${unwindClause.jsonExpr}) ${unwindClause.alias}`);
                }
                exprParams.push(...unwindClause.params);
            }
        }
        // Add WHERE conditions from MATCH
        const matchWhereClause = this.ctx.whereClause;
        if (matchWhereClause) {
            const { sql: whereSql, params: conditionParams } = this.translateWhere(matchWhereClause);
            whereParts.push(whereSql);
            whereParams.push(...conditionParams);
        }
        // Add WHERE conditions from OPTIONAL MATCH
        // These should be applied as: (optional_var IS NULL OR condition)
        // This ensures the main row is still returned even if the optional match fails the WHERE
        const optionalWhereClauses = this.ctx.optionalWhereClauses;
        if (optionalWhereClauses && optionalWhereClauses.length > 0) {
            for (const optionalWhere of optionalWhereClauses) {
                const { sql: whereSql, params: conditionParams } = this.translateWhere(optionalWhere);
                // Find the main variable in the condition to check for NULL
                const optionalVars = this.findVariablesInCondition(optionalWhere);
                if (optionalVars.length > 0) {
                    // Get the first optional variable's alias to check for NULL
                    const firstVar = optionalVars[0];
                    const varInfo = this.ctx.variables.get(firstVar);
                    if (varInfo) {
                        whereParts.push(`(${varInfo.alias}.id IS NULL OR ${whereSql})`);
                        whereParams.push(...conditionParams);
                    }
                }
                else {
                    // No variables found, just add the condition
                    whereParts.push(whereSql);
                    whereParams.push(...conditionParams);
                }
            }
        }
        // Add WHERE conditions from WITH clause
        if (withWhere) {
            const { sql: whereSql, params: conditionParams } = this.translateWhere(withWhere);
            whereParts.push(whereSql);
            whereParams.push(...conditionParams);
        }
        // Build final SQL
        // Apply DISTINCT from either the RETURN clause or preceding WITH
        const distinctKeyword = (clause.distinct || withDistinct) ? "DISTINCT " : "";
        let sql = `SELECT ${distinctKeyword}${selectParts.join(", ")}`;
        if (fromParts.length > 0) {
            sql += ` FROM ${fromParts.join(", ")}`;
        }
        if (joinParts.length > 0) {
            sql += ` ${joinParts.join(" ")}`;
        }
        if (whereParts.length > 0) {
            sql += ` WHERE ${whereParts.join(" AND ")}`;
        }
        // Add ORDER BY clause - use WITH orderBy if RETURN doesn't have one
        const effectiveOrderBy = clause.orderBy && clause.orderBy.length > 0 ? clause.orderBy : withOrderBy;
        if (effectiveOrderBy && effectiveOrderBy.length > 0) {
            const orderParts = effectiveOrderBy.map(({ expression, direction }) => {
                const { sql: exprSql } = this.translateOrderByExpression(expression);
                return `${exprSql} ${direction}`;
            });
            sql += ` ORDER BY ${orderParts.join(", ")}`;
        }
        // Add LIMIT and OFFSET (SKIP) - combine WITH and RETURN values
        const effectiveLimit = clause.limit !== undefined ? clause.limit : withLimit;
        const effectiveSkip = clause.skip !== undefined ? clause.skip : withSkip;
        if (effectiveLimit !== undefined || effectiveSkip !== undefined) {
            if (effectiveLimit !== undefined) {
                sql += ` LIMIT ?`;
                whereParams.push(effectiveLimit);
            }
            else if (effectiveSkip !== undefined) {
                // SKIP without LIMIT - need a large limit for SQLite
                sql += ` LIMIT -1`;
            }
            if (effectiveSkip !== undefined) {
                sql += ` OFFSET ?`;
                whereParams.push(effectiveSkip);
            }
        }
        // Combine params in the order they appear in SQL: SELECT -> JOINs -> WHERE
        const allParams = [...exprParams, ...joinParams, ...whereParams];
        return {
            statements: [{ sql, params: allParams }],
            returnColumns,
        };
    }
    // ============================================================================
    // WITH
    // ============================================================================
    translateWith(clause) {
        // WITH clause stores its info in context for subsequent clauses
        // It creates a new "scope" by updating variable mappings
        if (!this.ctx.withClauses) {
            this.ctx.withClauses = [];
        }
        this.ctx.withClauses.push(clause);
        // Store where clause for later use
        if (clause.where) {
            this.ctx.withWhere = clause.where;
        }
        // Store ORDER BY, SKIP, LIMIT for later use  
        if (clause.orderBy) {
            this.ctx.withOrderBy = clause.orderBy;
        }
        if (clause.skip !== undefined) {
            this.ctx.withSkip = clause.skip;
        }
        if (clause.limit !== undefined) {
            this.ctx.withLimit = clause.limit;
        }
        if (clause.distinct) {
            this.ctx.withDistinct = true;
        }
        // Update variable mappings for WITH items
        // Variables without aliases keep their current mappings
        // Variables with aliases create new mappings based on expression type
        for (const item of clause.items) {
            const alias = item.alias;
            if (item.expression.type === "variable") {
                // Variable passthrough - keep or create mapping
                const originalVar = item.expression.variable;
                const originalInfo = this.ctx.variables.get(originalVar);
                if (originalInfo && alias) {
                    this.ctx.variables.set(alias, originalInfo);
                }
            }
            else if (item.expression.type === "property" && alias) {
                // Property access with alias - this creates a "virtual" variable
                // We'll track this separately for the return phase
                if (!this.ctx.withAliases) {
                    this.ctx.withAliases = new Map();
                }
                this.ctx.withAliases.set(alias, item.expression);
            }
            else if (item.expression.type === "function" && alias) {
                // Function with alias - track for return phase
                if (!this.ctx.withAliases) {
                    this.ctx.withAliases = new Map();
                }
                this.ctx.withAliases.set(alias, item.expression);
            }
        }
        // WITH doesn't generate SQL statements directly - 
        // the SQL is generated by the final RETURN clause
        return [];
    }
    // ============================================================================
    // UNWIND
    // ============================================================================
    // ============================================================================
    // Variable-length paths
    // ============================================================================
    translateVariableLengthPath(clause, relPatterns, selectParts, returnColumns, exprParams, whereParams) {
        // For variable-length paths, we use SQLite's recursive CTEs
        // Pattern: WITH RECURSIVE path(start_id, end_id, depth) AS (
        //   SELECT source_id, target_id, 1 FROM edges WHERE ...
        //   UNION ALL
        //   SELECT p.start_id, e.target_id, p.depth + 1
        //   FROM path p JOIN edges e ON p.end_id = e.source_id
        //   WHERE p.depth < max_depth
        // )
        // SELECT ... FROM nodes n0, path, nodes n1 WHERE n0.id = path.start_id AND n1.id = path.end_id ...
        const varLengthPattern = relPatterns.find(p => p.isVariableLength);
        if (!varLengthPattern) {
            throw new Error("No variable-length pattern found");
        }
        const minHops = varLengthPattern.minHops ?? 1;
        // For unbounded paths (*), use a reasonable default max
        // For fixed length (*2), maxHops equals minHops
        const maxHops = varLengthPattern.maxHops ?? 10;
        const edgeType = varLengthPattern.edge.type;
        const sourceAlias = varLengthPattern.sourceAlias;
        const targetAlias = varLengthPattern.targetAlias;
        const allParams = [...exprParams];
        // Build the recursive CTE
        const pathCteName = `path_${this.ctx.aliasCounter++}`;
        // Base condition for edges
        let edgeCondition = "1=1";
        if (edgeType) {
            edgeCondition = "type = ?";
            allParams.push(edgeType);
        }
        // Build the CTE
        // The depth represents the number of edges traversed
        // For *2, we want exactly 2 edges, so depth should stop at maxHops
        // The condition is p.depth < maxHops to allow one more recursion step
        const cte = `WITH RECURSIVE ${pathCteName}(start_id, end_id, depth) AS (
  SELECT source_id, target_id, 1 FROM edges WHERE ${edgeCondition}
  UNION ALL
  SELECT p.start_id, e.target_id, p.depth + 1
  FROM ${pathCteName} p
  JOIN edges e ON p.end_id = e.source_id
  WHERE p.depth < ?${edgeType ? " AND e.type = ?" : ""}
)`;
        // For maxHops=2, we need depth to reach 2, so recursion limit should be maxHops
        allParams.push(maxHops);
        if (edgeType) {
            allParams.push(edgeType);
        }
        // Build WHERE conditions
        const whereParts = [];
        // Connect source node to path start
        whereParts.push(`${sourceAlias}.id = ${pathCteName}.start_id`);
        // Connect target node to path end
        whereParts.push(`${targetAlias}.id = ${pathCteName}.end_id`);
        // Apply min depth constraint
        if (minHops > 1) {
            whereParts.push(`${pathCteName}.depth >= ?`);
            allParams.push(minHops);
        }
        // Add source/target label filters
        const sourcePattern = this.ctx[`pattern_${sourceAlias}`];
        if (sourcePattern?.label) {
            whereParts.push(`${sourceAlias}.label = ?`);
            allParams.push(sourcePattern.label);
        }
        if (sourcePattern?.properties) {
            for (const [key, value] of Object.entries(sourcePattern.properties)) {
                if (this.isParameterRef(value)) {
                    whereParts.push(`json_extract(${sourceAlias}.properties, '$.${key}') = ?`);
                    allParams.push(this.ctx.paramValues[value.name]);
                }
                else {
                    whereParts.push(`json_extract(${sourceAlias}.properties, '$.${key}') = ?`);
                    allParams.push(value);
                }
            }
        }
        const targetPattern = this.ctx[`pattern_${targetAlias}`];
        if (targetPattern?.label) {
            whereParts.push(`${targetAlias}.label = ?`);
            allParams.push(targetPattern.label);
        }
        if (targetPattern?.properties) {
            for (const [key, value] of Object.entries(targetPattern.properties)) {
                if (this.isParameterRef(value)) {
                    whereParts.push(`json_extract(${targetAlias}.properties, '$.${key}') = ?`);
                    allParams.push(this.ctx.paramValues[value.name]);
                }
                else {
                    whereParts.push(`json_extract(${targetAlias}.properties, '$.${key}') = ?`);
                    allParams.push(value);
                }
            }
        }
        // Add WHERE clause from MATCH if present
        const matchWhereClause = this.ctx.whereClause;
        if (matchWhereClause) {
            const { sql: whereSql, params: conditionParams } = this.translateWhere(matchWhereClause);
            whereParts.push(whereSql);
            allParams.push(...conditionParams);
        }
        // Build final SQL
        const distinctKeyword = clause.distinct ? "DISTINCT " : "";
        let sql = `${cte}\nSELECT ${distinctKeyword}${selectParts.join(", ")}`;
        sql += ` FROM nodes ${sourceAlias}, ${pathCteName}, nodes ${targetAlias}`;
        if (whereParts.length > 0) {
            sql += ` WHERE ${whereParts.join(" AND ")}`;
        }
        // Add ORDER BY if present
        if (clause.orderBy && clause.orderBy.length > 0) {
            const orderParts = clause.orderBy.map(({ expression, direction }) => {
                const { sql: exprSql } = this.translateOrderByExpression(expression);
                return `${exprSql} ${direction}`;
            });
            sql += ` ORDER BY ${orderParts.join(", ")}`;
        }
        // Add LIMIT and SKIP
        if (clause.limit !== undefined || clause.skip !== undefined) {
            if (clause.limit !== undefined) {
                sql += ` LIMIT ?`;
                allParams.push(clause.limit);
            }
            else if (clause.skip !== undefined) {
                sql += ` LIMIT -1`;
            }
            if (clause.skip !== undefined) {
                sql += ` OFFSET ?`;
                allParams.push(clause.skip);
            }
        }
        return {
            statements: [{ sql, params: allParams }],
            returnColumns,
        };
    }
    // ============================================================================
    // UNION
    // ============================================================================
    translateUnion(clause) {
        // Translate left query (create a fresh translator to avoid context contamination)
        const leftTranslator = new Translator(this.ctx.paramValues);
        const leftResult = leftTranslator.translate(clause.left);
        // Translate right query
        const rightTranslator = new Translator(this.ctx.paramValues);
        const rightResult = rightTranslator.translate(clause.right);
        // Get the SQL from both sides (should be SELECT statements)
        const leftSql = leftResult.statements.map(s => s.sql).join("; ");
        const rightSql = rightResult.statements.map(s => s.sql).join("; ");
        // Combine params from both sides
        const allParams = [
            ...leftResult.statements.flatMap(s => s.params),
            ...rightResult.statements.flatMap(s => s.params),
        ];
        // Build UNION SQL
        const unionKeyword = clause.all ? "UNION ALL" : "UNION";
        const sql = `${leftSql} ${unionKeyword} ${rightSql}`;
        // Return columns come from the left query
        const returnColumns = leftResult.returnColumns || [];
        return {
            statements: [{ sql, params: allParams }],
            returnColumns,
        };
    }
    translateUnwind(clause) {
        // UNWIND expands an array into rows using SQLite's json_each()
        // We store the unwind info in context for use in RETURN
        const alias = `unwind${this.ctx.aliasCounter++}`;
        // Store the unwind information for later use
        if (!this.ctx.unwindClauses) {
            this.ctx.unwindClauses = [];
        }
        // Determine the expression for json_each
        let jsonExpr;
        let params = [];
        if (clause.expression.type === "literal") {
            // Literal array - serialize to JSON
            jsonExpr = "?";
            params.push(JSON.stringify(clause.expression.value));
        }
        else if (clause.expression.type === "parameter") {
            // Parameter - will be resolved at runtime
            jsonExpr = "?";
            const paramValue = this.ctx.paramValues[clause.expression.name];
            params.push(JSON.stringify(paramValue));
        }
        else if (clause.expression.type === "variable") {
            // Variable reference - could be from WITH/COLLECT
            const varName = clause.expression.variable;
            const withAliases = this.ctx.withAliases;
            if (withAliases && withAliases.has(varName)) {
                // It's a WITH alias - need to inline the expression
                const originalExpr = withAliases.get(varName);
                const translated = this.translateExpression(originalExpr);
                jsonExpr = translated.sql;
                params.push(...translated.params);
            }
            else {
                // It's a regular variable
                const varInfo = this.ctx.variables.get(varName);
                if (varInfo) {
                    jsonExpr = `${varInfo.alias}.properties`;
                }
                else {
                    throw new Error(`Unknown variable in UNWIND: ${varName}`);
                }
            }
        }
        else if (clause.expression.type === "property") {
            // Property access on a variable
            const varInfo = this.ctx.variables.get(clause.expression.variable);
            if (!varInfo) {
                throw new Error(`Unknown variable: ${clause.expression.variable}`);
            }
            jsonExpr = `json_extract(${varInfo.alias}.properties, '$.${clause.expression.property}')`;
        }
        else {
            throw new Error(`Unsupported expression type in UNWIND: ${clause.expression.type}`);
        }
        this.ctx.unwindClauses.push({
            alias,
            variable: clause.alias,
            jsonExpr,
            params,
        });
        // Register the unwind alias as a variable for subsequent use
        // We use 'unwind' as the type to distinguish it from nodes/edges
        this.ctx.variables.set(clause.alias, { type: "node", alias }); // Using 'node' as a placeholder type
        // Store special marker that this is an unwind variable
        this.ctx[`unwind_${alias}`] = true;
        // UNWIND doesn't generate SQL directly - it sets up context for RETURN
        return [];
    }
    translateExpression(expr) {
        const tables = [];
        const params = [];
        switch (expr.type) {
            case "variable": {
                // First check if this is a WITH alias
                const withAliases = this.ctx.withAliases;
                if (withAliases && withAliases.has(expr.variable)) {
                    // This variable is actually an alias from WITH - translate the underlying expression
                    const originalExpr = withAliases.get(expr.variable);
                    return this.translateExpression(originalExpr);
                }
                // Check if this is an UNWIND variable
                const unwindClauses = this.ctx.unwindClauses;
                if (unwindClauses) {
                    const unwindClause = unwindClauses.find(u => u.variable === expr.variable);
                    if (unwindClause) {
                        tables.push(unwindClause.alias);
                        // UNWIND variables access the 'value' column from json_each
                        return {
                            sql: `${unwindClause.alias}.value`,
                            tables,
                            params,
                        };
                    }
                }
                const varInfo = this.ctx.variables.get(expr.variable);
                if (!varInfo) {
                    throw new Error(`Unknown variable: ${expr.variable}`);
                }
                tables.push(varInfo.alias);
                // Return the whole row as JSON for variables
                return {
                    sql: `json_object('id', ${varInfo.alias}.id, 'label', ${varInfo.alias}.label, 'properties', ${varInfo.alias}.properties)`,
                    tables,
                    params,
                };
            }
            case "property": {
                const varInfo = this.ctx.variables.get(expr.variable);
                if (!varInfo) {
                    throw new Error(`Unknown variable: ${expr.variable}`);
                }
                tables.push(varInfo.alias);
                // Use -> operator to preserve JSON types (returns 'true'/'false' not 1/0)
                return {
                    sql: `${varInfo.alias}.properties -> '$.${expr.property}'`,
                    tables,
                    params,
                };
            }
            case "function": {
                if (expr.functionName === "COUNT") {
                    if (expr.args && expr.args.length > 0) {
                        const argExpr = this.translateExpression(expr.args[0]);
                        tables.push(...argExpr.tables);
                        params.push(...argExpr.params);
                        return { sql: `COUNT(*)`, tables, params };
                    }
                    return { sql: "COUNT(*)", tables, params };
                }
                if (expr.functionName === "ID") {
                    if (expr.args && expr.args.length > 0 && expr.args[0].type === "variable") {
                        const varInfo = this.ctx.variables.get(expr.args[0].variable);
                        if (!varInfo) {
                            throw new Error(`Unknown variable: ${expr.args[0].variable}`);
                        }
                        tables.push(varInfo.alias);
                        return { sql: `${varInfo.alias}.id`, tables, params };
                    }
                }
                // Aggregation functions: SUM, AVG, MIN, MAX
                if (expr.functionName === "SUM" || expr.functionName === "AVG" ||
                    expr.functionName === "MIN" || expr.functionName === "MAX") {
                    if (expr.args && expr.args.length > 0) {
                        const arg = expr.args[0];
                        if (arg.type === "property") {
                            const varInfo = this.ctx.variables.get(arg.variable);
                            if (!varInfo) {
                                throw new Error(`Unknown variable: ${arg.variable}`);
                            }
                            tables.push(varInfo.alias);
                            // Use json_extract for numeric properties in aggregations
                            return {
                                sql: `${expr.functionName}(json_extract(${varInfo.alias}.properties, '$.${arg.property}'))`,
                                tables,
                                params,
                            };
                        }
                        else if (arg.type === "variable") {
                            const varInfo = this.ctx.variables.get(arg.variable);
                            if (!varInfo) {
                                throw new Error(`Unknown variable: ${arg.variable}`);
                            }
                            tables.push(varInfo.alias);
                            // For variable, aggregate the id
                            return {
                                sql: `${expr.functionName}(${varInfo.alias}.id)`,
                                tables,
                                params,
                            };
                        }
                    }
                    throw new Error(`${expr.functionName} requires a property or variable argument`);
                }
                // COLLECT: gather values into an array using SQLite's json_group_array
                if (expr.functionName === "COLLECT") {
                    if (expr.args && expr.args.length > 0) {
                        const arg = expr.args[0];
                        if (arg.type === "property") {
                            const varInfo = this.ctx.variables.get(arg.variable);
                            if (!varInfo) {
                                throw new Error(`Unknown variable: ${arg.variable}`);
                            }
                            tables.push(varInfo.alias);
                            return {
                                sql: `json_group_array(json_extract(${varInfo.alias}.properties, '$.${arg.property}'))`,
                                tables,
                                params,
                            };
                        }
                        else if (arg.type === "variable") {
                            const varInfo = this.ctx.variables.get(arg.variable);
                            if (!varInfo) {
                                throw new Error(`Unknown variable: ${arg.variable}`);
                            }
                            tables.push(varInfo.alias);
                            // For full variable, collect as JSON objects
                            return {
                                sql: `json_group_array(json_object('id', ${varInfo.alias}.id, 'label', ${varInfo.alias}.label, 'properties', ${varInfo.alias}.properties))`,
                                tables,
                                params,
                            };
                        }
                    }
                    throw new Error(`COLLECT requires a property or variable argument`);
                }
                throw new Error(`Unknown function: ${expr.functionName}`);
            }
            case "literal": {
                // Convert booleans to 1/0 for SQLite
                const value = expr.value === true ? 1 : expr.value === false ? 0 : expr.value;
                params.push(value);
                return { sql: "?", tables, params };
            }
            case "parameter": {
                params.push(this.ctx.paramValues[expr.name]);
                return { sql: "?", tables, params };
            }
            case "case": {
                return this.translateCaseExpression(expr);
            }
            default:
                throw new Error(`Unknown expression type: ${expr.type}`);
        }
    }
    translateCaseExpression(expr) {
        const tables = [];
        const params = [];
        let sql = "CASE";
        // Process each WHEN clause
        for (const when of expr.whens || []) {
            // Translate the condition
            const { sql: condSql, params: condParams } = this.translateWhere(when.condition);
            params.push(...condParams);
            // Translate the result expression
            const { sql: resultSql, tables: resultTables, params: resultParams } = this.translateExpression(when.result);
            tables.push(...resultTables);
            params.push(...resultParams);
            sql += ` WHEN ${condSql} THEN ${resultSql}`;
        }
        // Add ELSE clause if present
        if (expr.elseExpr) {
            const { sql: elseSql, tables: elseTables, params: elseParams } = this.translateExpression(expr.elseExpr);
            tables.push(...elseTables);
            params.push(...elseParams);
            sql += ` ELSE ${elseSql}`;
        }
        sql += " END";
        return { sql, tables, params };
    }
    translateWhere(condition) {
        switch (condition.type) {
            case "comparison": {
                const left = this.translateWhereExpression(condition.left);
                const right = this.translateWhereExpression(condition.right);
                return {
                    sql: `${left.sql} ${condition.operator} ${right.sql}`,
                    params: [...left.params, ...right.params],
                };
            }
            case "and": {
                const parts = condition.conditions.map((c) => this.translateWhere(c));
                return {
                    sql: `(${parts.map((p) => p.sql).join(" AND ")})`,
                    params: parts.flatMap((p) => p.params),
                };
            }
            case "or": {
                const parts = condition.conditions.map((c) => this.translateWhere(c));
                return {
                    sql: `(${parts.map((p) => p.sql).join(" OR ")})`,
                    params: parts.flatMap((p) => p.params),
                };
            }
            case "not": {
                const inner = this.translateWhere(condition.condition);
                return {
                    sql: `NOT (${inner.sql})`,
                    params: inner.params,
                };
            }
            case "contains": {
                const left = this.translateWhereExpression(condition.left);
                const right = this.translateWhereExpression(condition.right);
                return {
                    sql: `${left.sql} LIKE '%' || ${right.sql} || '%'`,
                    params: [...left.params, ...right.params],
                };
            }
            case "startsWith": {
                const left = this.translateWhereExpression(condition.left);
                const right = this.translateWhereExpression(condition.right);
                return {
                    sql: `${left.sql} LIKE ${right.sql} || '%'`,
                    params: [...left.params, ...right.params],
                };
            }
            case "endsWith": {
                const left = this.translateWhereExpression(condition.left);
                const right = this.translateWhereExpression(condition.right);
                return {
                    sql: `${left.sql} LIKE '%' || ${right.sql}`,
                    params: [...left.params, ...right.params],
                };
            }
            case "isNull": {
                const left = this.translateWhereExpression(condition.left);
                return {
                    sql: `${left.sql} IS NULL`,
                    params: left.params,
                };
            }
            case "isNotNull": {
                const left = this.translateWhereExpression(condition.left);
                return {
                    sql: `${left.sql} IS NOT NULL`,
                    params: left.params,
                };
            }
            case "exists": {
                return this.translateExistsCondition(condition);
            }
            default:
                throw new Error(`Unknown condition type: ${condition.type}`);
        }
    }
    translateExistsCondition(condition) {
        const pattern = condition.pattern;
        if (!pattern) {
            throw new Error("EXISTS condition must have a pattern");
        }
        const params = [];
        let sql;
        if (this.isRelationshipPattern(pattern)) {
            // EXISTS with relationship pattern: EXISTS((n)-[:TYPE]->(m))
            // Generate: EXISTS (SELECT 1 FROM edges e WHERE e.source_id = n.id AND e.type = ? AND ...)
            const rel = pattern;
            // Get the source variable's alias from context
            const sourceVar = rel.source.variable;
            const sourceInfo = sourceVar ? this.ctx.variables.get(sourceVar) : null;
            if (!sourceInfo) {
                throw new Error(`EXISTS pattern references unknown variable: ${sourceVar}`);
            }
            const edgeAlias = `exists_e${this.ctx.aliasCounter++}`;
            const targetAlias = `exists_n${this.ctx.aliasCounter++}`;
            const conditions = [];
            // Connect edge to source node
            if (rel.edge.direction === "left") {
                conditions.push(`${edgeAlias}.target_id = ${sourceInfo.alias}.id`);
            }
            else {
                conditions.push(`${edgeAlias}.source_id = ${sourceInfo.alias}.id`);
            }
            // Filter by edge type if specified
            if (rel.edge.type) {
                conditions.push(`${edgeAlias}.type = ?`);
                params.push(rel.edge.type);
            }
            // Check if target has a label - need to join to nodes table
            let fromClause = `edges ${edgeAlias}`;
            if (rel.target.label) {
                if (rel.edge.direction === "left") {
                    fromClause += ` JOIN nodes ${targetAlias} ON ${edgeAlias}.source_id = ${targetAlias}.id`;
                }
                else {
                    fromClause += ` JOIN nodes ${targetAlias} ON ${edgeAlias}.target_id = ${targetAlias}.id`;
                }
                conditions.push(`${targetAlias}.label = ?`);
                params.push(rel.target.label);
            }
            sql = `EXISTS (SELECT 1 FROM ${fromClause} WHERE ${conditions.join(" AND ")})`;
        }
        else {
            // EXISTS with node-only pattern: EXISTS((n))
            // This is less common but valid - check if the node variable exists
            const node = pattern;
            const nodeVar = node.variable;
            const nodeInfo = nodeVar ? this.ctx.variables.get(nodeVar) : null;
            if (!nodeInfo) {
                throw new Error(`EXISTS pattern references unknown variable: ${nodeVar}`);
            }
            // Node exists if it has an id (always true for matched nodes)
            sql = `${nodeInfo.alias}.id IS NOT NULL`;
        }
        return { sql, params };
    }
    translateOrderByExpression(expr) {
        switch (expr.type) {
            case "property": {
                const varInfo = this.ctx.variables.get(expr.variable);
                if (!varInfo) {
                    throw new Error(`Unknown variable: ${expr.variable}`);
                }
                return {
                    sql: `json_extract(${varInfo.alias}.properties, '$.${expr.property}')`,
                };
            }
            case "variable": {
                // Check if this is an UNWIND variable
                const unwindClauses = this.ctx.unwindClauses;
                if (unwindClauses) {
                    const unwindClause = unwindClauses.find(u => u.variable === expr.variable);
                    if (unwindClause) {
                        return { sql: `${unwindClause.alias}.value` };
                    }
                }
                const varInfo = this.ctx.variables.get(expr.variable);
                if (!varInfo) {
                    throw new Error(`Unknown variable: ${expr.variable}`);
                }
                return { sql: `${varInfo.alias}.id` };
            }
            case "function": {
                if (expr.functionName === "ID") {
                    if (expr.args && expr.args.length > 0 && expr.args[0].type === "variable") {
                        const varInfo = this.ctx.variables.get(expr.args[0].variable);
                        if (!varInfo) {
                            throw new Error(`Unknown variable: ${expr.args[0].variable}`);
                        }
                        return { sql: `${varInfo.alias}.id` };
                    }
                }
                throw new Error(`Cannot order by function: ${expr.functionName}`);
            }
            default:
                throw new Error(`Cannot order by expression of type ${expr.type}`);
        }
    }
    translateWhereExpression(expr) {
        switch (expr.type) {
            case "property": {
                const varInfo = this.ctx.variables.get(expr.variable);
                if (!varInfo) {
                    throw new Error(`Unknown variable: ${expr.variable}`);
                }
                return {
                    sql: `json_extract(${varInfo.alias}.properties, '$.${expr.property}')`,
                    params: [],
                };
            }
            case "literal": {
                // Convert booleans to 1/0 for SQLite
                const value = expr.value === true ? 1 : expr.value === false ? 0 : expr.value;
                return { sql: "?", params: [value] };
            }
            case "parameter": {
                let value = this.ctx.paramValues[expr.name];
                // Convert booleans to 1/0 for SQLite
                if (value === true)
                    value = 1;
                else if (value === false)
                    value = 0;
                return { sql: "?", params: [value] };
            }
            case "variable": {
                // First check if this is a WITH alias
                const withAliases = this.ctx.withAliases;
                if (withAliases && withAliases.has(expr.variable)) {
                    // This variable is actually an alias from WITH - translate the underlying expression
                    const originalExpr = withAliases.get(expr.variable);
                    return this.translateWhereExpression(originalExpr);
                }
                // Check if this is an UNWIND variable
                const unwindClauses = this.ctx.unwindClauses;
                if (unwindClauses) {
                    const unwindClause = unwindClauses.find(u => u.variable === expr.variable);
                    if (unwindClause) {
                        // UNWIND variables access the 'value' column from json_each
                        return { sql: `${unwindClause.alias}.value`, params: [] };
                    }
                }
                const varInfo = this.ctx.variables.get(expr.variable);
                if (!varInfo) {
                    throw new Error(`Unknown variable: ${expr.variable}`);
                }
                return { sql: `${varInfo.alias}.id`, params: [] };
            }
            default:
                throw new Error(`Unknown expression type in WHERE: ${expr.type}`);
        }
    }
    // ============================================================================
    // Helpers
    // ============================================================================
    isRelationshipPattern(pattern) {
        return "source" in pattern && "edge" in pattern && "target" in pattern;
    }
    findVariablesInCondition(condition) {
        const vars = [];
        const collectFromExpression = (expr) => {
            if (!expr)
                return;
            if (expr.type === "property" && expr.variable) {
                vars.push(expr.variable);
            }
            else if (expr.type === "variable" && expr.variable) {
                vars.push(expr.variable);
            }
        };
        const collectFromCondition = (cond) => {
            collectFromExpression(cond.left);
            collectFromExpression(cond.right);
            if (cond.conditions) {
                for (const c of cond.conditions) {
                    collectFromCondition(c);
                }
            }
            if (cond.condition) {
                collectFromCondition(cond.condition);
            }
        };
        collectFromCondition(condition);
        return [...new Set(vars)];
    }
    isParameterRef(value) {
        return typeof value === "object" && value !== null && "type" in value && value.type === "parameter";
    }
    serializeProperties(props) {
        const resolved = {};
        const params = [];
        for (const [key, value] of Object.entries(props)) {
            if (this.isParameterRef(value)) {
                resolved[key] = this.ctx.paramValues[value.name];
            }
            else {
                resolved[key] = value;
            }
        }
        return { json: JSON.stringify(resolved), params };
    }
    evaluateExpression(expr) {
        switch (expr.type) {
            case "literal":
                return expr.value;
            case "parameter":
                return this.ctx.paramValues[expr.name];
            default:
                throw new Error(`Cannot evaluate expression of type ${expr.type}`);
        }
    }
    getExpressionName(expr) {
        switch (expr.type) {
            case "variable":
                return expr.variable;
            case "property":
                return `${expr.variable}_${expr.property}`;
            case "function":
                return expr.functionName.toLowerCase();
            default:
                return "expr";
        }
    }
    generateId() {
        return crypto.randomUUID();
    }
}
// Convenience function
export function translate(query, params = {}) {
    return new Translator(params).translate(query);
}
//# sourceMappingURL=translator.js.map