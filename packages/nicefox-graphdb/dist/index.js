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
GraphDBError, } from "nicefox-graphdb-client";
// Default export (client class)
export { default } from "nicefox-graphdb-client";
// ============================================================================
// Server exports
// ============================================================================
export { 
// Parser
parse, 
// Translator
translate, Translator, 
// Database
GraphDatabase, DatabaseManager, 
// Executor
Executor, executeQuery, 
// Routes / Server
createApp, createServer, 
// Backup
BackupManager, 
// Auth
ApiKeyStore, authMiddleware, generateApiKey, 
// Version
VERSION, } from "nicefox-graphdb-server";
//# sourceMappingURL=index.js.map