// NiceFox GraphDB - Unified Package
// Re-exports everything from client and server packages

// ============================================================================
// Client exports
// ============================================================================

export {
  // Main client class
  NiceFoxGraphDB,
  // Test client factory
  createTestClient,
  // Error class
  GraphDBError,
  // Types
  type ClientOptions,
  type TestClient,
  type TestClientOptions,
  type QueryResponse,
  type HealthResponse,
  type NodeResult,
} from "nicefox-graphdb-client";

// Default export (client class)
export { default } from "nicefox-graphdb-client";

// ============================================================================
// Server exports
// ============================================================================

export {
  // Parser
  parse,
  type Query,
  type Clause,
  type CreateClause,
  type MatchClause,
  type MergeClause,
  type SetClause,
  type DeleteClause,
  type ReturnClause,
  type NodePattern,
  type RelationshipPattern,
  type EdgePattern,
  type WhereCondition,
  type Expression,
  type PropertyValue,
  type ParameterRef,
  type ParseResult,
  type ParseError,

  // Translator
  translate,
  Translator,
  type SqlStatement,
  type TranslationResult,

  // Database
  GraphDatabase,
  DatabaseManager,
  type Node,
  type Edge,
  type NodeRow,
  type EdgeRow,
  type QueryResult,

  // Executor
  Executor,
  executeQuery,
  type ExecutionResult,
  type ExecutionError,
  type QueryResponse as ServerQueryResponse,

  // Routes / Server
  createApp,
  createServer,
  type QueryRequest,
  type ServerOptions,

  // Backup
  BackupManager,
  type BackupResult,
  type BackupStatus,
  type BackupAllOptions,

  // Auth
  ApiKeyStore,
  authMiddleware,
  generateApiKey,
  type ApiKeyConfig,
  type ValidationResult,
  type KeyInfo,

  // Version
  VERSION,
} from "nicefox-graphdb-server";
