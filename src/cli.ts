#!/usr/bin/env node

import { Command } from "commander";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import {
  createServer,
  GraphDatabase,
  Executor,
  BackupManager,
  generateApiKey,
  VERSION,
} from "./index.js";
import {
  ApiKeyConfig,
  formatBytes,
  formatValue,
  getApiKeysPath,
  loadApiKeys,
  saveApiKeys,
  ensureDataDir,
  calculateColumnWidths,
  formatTableRow,
  listProjects,
  getProjectKeyCount,
} from "./cli-helpers.js";

const program = new Command();

program
  .name("leangraph")
  .description("LeanGraph - SQLite-based graph database with Cypher queries")
  .version(VERSION);

// ============================================================================
// serve - Start the HTTP server
// ============================================================================

program
  .command("serve")
  .description("Start the LeanGraph HTTP server")
  .option("-p, --port <port>", "Port to listen on", "3000")
  .option("-d, --data <path>", "Data directory for databases", "/var/data/leangraph")
  .option("-H, --host <host>", "Host to bind to", "localhost")
  .option("-b, --backup <path>", "Backup directory (enables backup endpoints)")
  .action(async (options: { port: string; data: string; host: string; backup?: string }) => {
    const port = parseInt(options.port, 10);
    const dataPath = path.resolve(options.data);
    const host = options.host;
    const backupPath = options.backup ? path.resolve(options.backup) : undefined;

    // Ensure data directory exists
    ensureDataDir(dataPath);

    // Load API keys from data directory
    let apiKeys: Record<string, ApiKeyConfig> | undefined;
    const keysFile = getApiKeysPath(dataPath);
    
    if (fs.existsSync(keysFile)) {
      try {
        apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf-8"));
        console.log(`Loaded ${Object.keys(apiKeys!).length} API key(s) from ${keysFile}`);
      } catch (err) {
        console.error(`Failed to load API keys from ${keysFile}:`, err);
        process.exit(1);
      }
    }

    const { app, dbManager } = createServer({ 
      port, 
      dataPath,
      backupPath,
      apiKeys,
    });

    const authStatus = apiKeys ? "enabled" : "disabled";
    const backupStatus = backupPath ? backupPath.slice(0, 30) : "disabled";

    console.log(`
╔═══════════════════════════════════════════════════════════╗
║              LeanGraph Server v${VERSION}                      ║
╠═══════════════════════════════════════════════════════════╣
║  Endpoint:  http://${host}:${port.toString().padEnd(5)}                         ║
║  Data:      ${dataPath.slice(0, 43).padEnd(43)} ║
║  Backups:   ${backupStatus.padEnd(43)} ║
║  Auth:      ${authStatus.padEnd(43)} ║
║                                                           ║
║  Routes:                                                  ║
║    POST /query/:project       - Execute Cypher queries    ║
║    GET  /health               - Health check              ║
║    GET  /admin/list           - List all projects         ║
║    GET  /admin/backup         - Backup status             ║
║    POST /admin/backup         - Trigger backup            ║
╚═══════════════════════════════════════════════════════════╝
`);

    serve({
      fetch: app.fetch,
      port,
      hostname: host,
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      dbManager.closeAll();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("\nShutting down...");
      dbManager.closeAll();
      process.exit(0);
    });
  });

// ============================================================================
// create - Create a new project (both production and test DBs)
// ============================================================================

program
  .command("create <project>")
  .description("Create a new project with database and API key")
  .option("-d, --data <path>", "Data directory for databases", "/var/data/leangraph")
  .option("--no-key", "Skip API key generation")
  .action((project: string, options: { data: string; key: boolean }) => {
    const dataPath = path.resolve(options.data);
    ensureDataDir(dataPath);

    const dbPath = path.join(dataPath, `${project}.db`);

    if (fs.existsSync(dbPath)) {
      console.log(`Project '${project}' already exists.`);
      return;
    }

    const db = new GraphDatabase(dbPath);
    db.initialize();
    db.close();
    console.log(`  [created] ${project}.db`);

    // Generate API key for the project
    if (options.key) {
      const keys = loadApiKeys(dataPath);
      const apiKey = generateApiKey();
      keys[apiKey] = { project };
      saveApiKeys(dataPath, keys);

      console.log(`\nProject '${project}' is ready.`);
      console.log(`\nAPI Key: ${apiKey}`);
    } else {
      console.log(`\nProject '${project}' is ready (no API key generated).`);
    }
  });

// ============================================================================
// delete - Delete a project
// ============================================================================

program
  .command("delete <project>")
  .description("Delete a project (removes database and API keys)")
  .option("-d, --data <path>", "Data directory for databases", "/var/data/leangraph")
  .option("-f, --force", "Skip confirmation prompt", false)
  .action((project: string, options: { data: string; force: boolean }) => {
    const dataPath = path.resolve(options.data);
    const dbPath = path.join(dataPath, `${project}.db`);
    const dbExists = fs.existsSync(dbPath);

    // Check for API keys
    const keys = loadApiKeys(dataPath);
    const projectKeys = Object.entries(keys).filter(
      ([_, config]) => config.project === project
    );

    if (!dbExists && projectKeys.length === 0) {
      console.log(`Project '${project}' does not exist.`);
      process.exit(1);
    }

    if (!options.force) {
      console.log(`This will delete:`);
      if (dbExists) {
        console.log(`  - ${project}.db`);
      }
      if (projectKeys.length > 0) {
        console.log(`  - ${projectKeys.length} API key(s)`);
      }
      console.log(`\nUse --force to confirm deletion.`);
      process.exit(1);
    }

    // Delete database file
    if (dbExists) {
      fs.unlinkSync(dbPath);
      console.log(`  [deleted] ${project}.db`);
    }

    // Delete API keys for this project
    if (projectKeys.length > 0) {
      for (const [key] of projectKeys) {
        delete keys[key];
      }
      saveApiKeys(dataPath, keys);
      console.log(`  [deleted] ${projectKeys.length} API key(s)`);
    }

    console.log(`\nProject '${project}' has been deleted.`);
  });

// ============================================================================
// list - List all projects
// ============================================================================

program
  .command("list")
  .description("List all projects")
  .option("-d, --data <path>", "Data directory for databases", "/var/data/leangraph")
  .action((options: { data: string }) => {
    const dataPath = path.resolve(options.data);

    if (!fs.existsSync(dataPath)) {
      console.log("No data directory found. Run 'leangraph create <project>' first.");
      return;
    }

    const projects = listProjects(dataPath);

    if (projects.length === 0) {
      console.log("No projects found.");
      return;
    }

    // Load API keys to show key count per project
    const keys = loadApiKeys(dataPath);

    console.log("\nProjects:\n");
    for (const project of projects) {
      const keyCount = getProjectKeyCount(keys, project);
      const keyInfo =
        keyCount > 0 ? ` (${keyCount} key${keyCount > 1 ? "s" : ""})` : " (no keys)";
      console.log(`  ${project}${keyInfo}`);
    }
    console.log("");
  });

// ============================================================================
// query - Execute a Cypher query
// ============================================================================

program
  .command("query <project> <cypher>")
  .description("Execute a Cypher query against a project database")
  .option("-d, --data <path>", "Data directory for databases", "/var/data/leangraph")
  .option("-p, --params <json>", "Query parameters as JSON", "{}")
  .option("--json", "Output raw JSON", false)
  .action(
    (
      project: string,
      cypher: string,
      options: { data: string; params: string; json: boolean }
    ) => {
      const dataPath = path.resolve(options.data);
      const dbPath = path.join(dataPath, `${project}.db`);

      if (!fs.existsSync(dbPath)) {
        console.error(`Database not found: ${dbPath}`);
        console.error(`Run 'leangraph create ${project}' first.`);
        process.exit(1);
      }

      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(options.params);
      } catch {
        console.error("Invalid JSON in --params");
        process.exit(1);
      }

      const db = new GraphDatabase(dbPath);
      db.initialize();

      const executor = new Executor(db);
      const result = executor.execute(cypher, params);

      db.close();

      if (!result.success) {
        console.error(`Query failed: ${result.error.message}`);
        if (result.error.position !== undefined) {
          console.error(
            `  at position ${result.error.position} (line ${result.error.line}, column ${result.error.column})`
          );
        }
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nResults (${result.meta.count} rows, ${result.meta.time_ms}ms):\n`);

        if (result.data.length === 0) {
          console.log("  (no results)");
        } else {
          // Print as table
          const columns = Object.keys(result.data[0]);
          printTable(columns, result.data);
        }
        console.log("");
      }
    }
  );

// ============================================================================
// wipe - Wipe a database
// ============================================================================

program
  .command("wipe <project>")
  .description("Wipe all data from a project database")
  .option("-d, --data <path>", "Data directory for databases", "/var/data/leangraph")
  .option("-f, --force", "Skip confirmation prompt", false)
  .action((project: string, options: { data: string; force: boolean }) => {
    const dataPath = path.resolve(options.data);
    const dbPath = path.join(dataPath, `${project}.db`);

    if (!fs.existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      process.exit(1);
    }

    if (!options.force) {
      console.log(`This will delete all data in ${project}.db`);
      console.log(`\nUse --force to confirm.`);
      process.exit(1);
    }

    const db = new GraphDatabase(dbPath);
    db.initialize();
    db.execute("DELETE FROM edges");
    db.execute("DELETE FROM nodes");
    db.close();

    console.log(`Wiped ${project}.db`);
  });

// ============================================================================
// clone - Clone one project to another
// ============================================================================

program
  .command("clone <source> <target>")
  .description("Clone a project database to a new project")
  .option("-d, --data <path>", "Data directory for databases", "/var/data/leangraph")
  .option("-f, --force", "Skip confirmation prompt (required if target exists)", false)
  .action(
    (source: string, target: string, options: { data: string; force: boolean }) => {
      const dataPath = path.resolve(options.data);
      const sourcePath = path.join(dataPath, `${source}.db`);
      const targetPath = path.join(dataPath, `${target}.db`);

      if (!fs.existsSync(sourcePath)) {
        console.error(`Source database not found: ${sourcePath}`);
        process.exit(1);
      }

      if (fs.existsSync(targetPath) && !options.force) {
        console.log(`Target ${target}.db already exists.`);
        console.log(`\nUse --force to overwrite.`);
        process.exit(1);
      }

      // Copy file
      fs.copyFileSync(sourcePath, targetPath);

      console.log(`Cloned ${source}.db → ${target}.db`);
    }
  );

// ============================================================================
// migrate - Migrate databases from old label format to JSON array
// ============================================================================

program
  .command("migrate")
  .description("Migrate databases from old label format (TEXT) to new format (JSON array)")
  .option("-d, --data <path>", "Data directory for databases", "/var/data/leangraph")
  .option("-p, --project <name>", "Migrate specific project only")
  .option("--dry-run", "Preview changes without modifying data", false)
  .option("-f, --force", "Skip confirmation prompt", false)
  .action(
    (options: { data: string; project?: string; dryRun: boolean; force: boolean }) => {
      const dataPath = path.resolve(options.data);

      if (!fs.existsSync(dataPath)) {
        console.error(`Data directory not found: ${dataPath}`);
        process.exit(1);
      }

      // Find all databases to migrate
      const databases: { project: string; path: string }[] = [];

      const files = fs.readdirSync(dataPath).filter((f) => f.endsWith(".db"));
      for (const file of files) {
        const project = file.replace(".db", "");
        if (!options.project || options.project === project) {
          databases.push({
            project,
            path: path.join(dataPath, file),
          });
        }
      }

      if (databases.length === 0) {
        if (options.project) {
          console.error(`Project '${options.project}' not found.`);
        } else {
          console.log("No databases found.");
        }
        process.exit(1);
      }

      // Check what needs migration
      console.log("\nChecking databases for migration...\n");

      const toMigrate: { project: string; path: string; count: number }[] = [];

      for (const dbInfo of databases) {
        // Open database directly with better-sqlite3 to avoid schema initialization
        const db = new Database(dbInfo.path);

        try {
          // Check if nodes table exists
          const tableExists = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'"
            )
            .get();

          if (!tableExists) {
            console.log(`  ${dbInfo.project}.db: no nodes table (skipped)`);
            continue;
          }

          // Count nodes that need migration (label is not valid JSON)
          const result = db
            .prepare("SELECT COUNT(*) as count FROM nodes WHERE json_valid(label) = 0")
            .get() as { count: number };

          if (result.count > 0) {
            toMigrate.push({ ...dbInfo, count: result.count });
            console.log(`  ${dbInfo.project}.db: ${result.count} node(s) need migration`);
          } else {
            console.log(`  ${dbInfo.project}.db: already migrated`);
          }
        } finally {
          db.close();
        }
      }

      if (toMigrate.length === 0) {
        console.log("\nAll databases are already migrated.");
        return;
      }

      // Dry run - just show what would be done
      if (options.dryRun) {
        console.log(`\n[dry-run] Would migrate ${toMigrate.length} database(s)`);
        return;
      }

      // Confirm before migrating
      if (!options.force) {
        console.log(`\nThis will migrate ${toMigrate.length} database(s).`);
        console.log("Use --force to confirm, or --dry-run to preview.");
        process.exit(1);
      }

      // Perform migration
      console.log("\nMigrating...\n");
      let successCount = 0;
      let failCount = 0;

      for (const dbInfo of toMigrate) {
        const db = new Database(dbInfo.path);

        try {
          const start = Date.now();

          // Migrate: wrap plain text labels in JSON array
          const result = db
            .prepare(
              "UPDATE nodes SET label = json_array(label) WHERE json_valid(label) = 0"
            )
            .run();

          const duration = Date.now() - start;
          console.log(
            `  ${dbInfo.project}.db: ${result.changes} node(s) migrated (${duration}ms)`
          );
          successCount++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`  ${dbInfo.project}.db: FAILED - ${message}`);
          failCount++;
        } finally {
          db.close();
        }
      }

      console.log(`\nMigration complete: ${successCount} database(s) updated`);
      if (failCount > 0) {
        console.log(`  ${failCount} database(s) failed`);
        process.exit(1);
      }
    }
  );

// ============================================================================
// backup - Backup databases
// ============================================================================

program
  .command("backup")
  .description("Backup databases")
  .option("-d, --data <path>", "Data directory for databases", "/var/data/leangraph")
  .option("-o, --output <path>", "Backup output directory", "./backups")
  .option("-p, --project <name>", "Backup specific project only")
  .option("--keep <count>", "Number of backups to keep per project", "5")
  .option("--status", "Show backup status only", false)
  .action(
    async (options: {
      data: string;
      output: string;
      project?: string;
      keep: string;
      status: boolean;
    }) => {
      const dataPath = path.resolve(options.data);
      const backupPath = path.resolve(options.output);
      const keepCount = parseInt(options.keep, 10);

      const manager = new BackupManager(backupPath);

      // Status only mode
      if (options.status) {
        const status = manager.getBackupStatus();
        console.log("\nBackup Status:\n");
        console.log(`  Total backups:  ${status.totalBackups}`);
        console.log(`  Total size:     ${formatBytes(status.totalSizeBytes)}`);
        console.log(`  Projects:       ${status.projects.join(", ") || "(none)"}`);
        if (status.oldestBackup) {
          console.log(`  Oldest backup:  ${status.oldestBackup}`);
        }
        if (status.newestBackup) {
          console.log(`  Newest backup:  ${status.newestBackup}`);
        }
        console.log("");
        return;
      }

      // Check data directory exists
      if (!fs.existsSync(dataPath)) {
        console.error(`Data directory not found: ${dataPath}`);
        process.exit(1);
      }

      // Single project backup
      if (options.project) {
        const sourcePath = path.join(dataPath, `${options.project}.db`);
        if (!fs.existsSync(sourcePath)) {
          console.error(`Project not found: ${options.project}`);
          process.exit(1);
        }

        console.log(`Backing up ${options.project}...`);
        const result = await manager.backupDatabase(sourcePath, options.project);

        if (result.success) {
          console.log(`  [success] ${result.backupPath}`);
          console.log(
            `  Size: ${formatBytes(result.sizeBytes || 0)}, Duration: ${result.durationMs}ms`
          );

          // Cleanup old backups
          const deleted = manager.cleanOldBackups(options.project, keepCount);
          if (deleted > 0) {
            console.log(`  Cleaned up ${deleted} old backup(s)`);
          }
        } else {
          console.error(`  [failed] ${result.error}`);
          process.exit(1);
        }
        return;
      }

      // Backup all databases
      console.log(`\nBacking up databases from ${dataPath}...\n`);
      const results = await manager.backupAll(dataPath);

      if (results.length === 0) {
        console.log("No databases found to backup.");
        return;
      }

      let successCount = 0;
      let failCount = 0;

      for (const result of results) {
        if (result.success) {
          console.log(
            `  [success] ${result.project} → ${path.basename(result.backupPath!)}`
          );
          successCount++;

          // Cleanup old backups
          const deleted = manager.cleanOldBackups(result.project, keepCount);
          if (deleted > 0) {
            console.log(`            Cleaned up ${deleted} old backup(s)`);
          }
        } else {
          console.log(`  [failed]  ${result.project}: ${result.error}`);
          failCount++;
        }
      }

      console.log(`\nBackup complete: ${successCount} succeeded, ${failCount} failed`);
      if (failCount > 0) {
        process.exit(1);
      }
    }
  );

// ============================================================================
// apikey - API Key Management
// ============================================================================

const apikey = program
  .command("apikey")
  .description("Manage API keys for project access");

apikey
  .command("add <project>")
  .description("Generate and add a new API key for a project")
  .option("-d, --data <path>", "Data directory", "/var/data/leangraph")
  .option("--admin", "Create an admin key (ignores project)", false)
  .action((project: string, options: { data: string; admin: boolean }) => {
    const dataPath = path.resolve(options.data);
    const keys = loadApiKeys(dataPath);

    // Generate new key
    const newKey = generateApiKey();

    // Build config
    const config: ApiKeyConfig = {};
    if (options.admin) {
      config.admin = true;
    } else {
      config.project = project;
    }

    keys[newKey] = config;
    saveApiKeys(dataPath, keys);

    console.log(`\nAPI Key: ${newKey}`);
    if (options.admin) {
      console.log(`Access:  admin (full access)`);
    } else {
      console.log(`Project: ${project}`);
    }
  });

apikey
  .command("list")
  .description("List all API keys (shows prefixes only)")
  .option("-d, --data <path>", "Data directory", "/var/data/leangraph")
  .action((options: { data: string }) => {
    const dataPath = path.resolve(options.data);
    const keys = loadApiKeys(dataPath);

    if (Object.keys(keys).length === 0) {
      console.log("No API keys configured.");
      return;
    }

    console.log("\nAPI Keys:\n");
    console.log("  Prefix      | Access");
    console.log("  ------------+---------------------------");

    for (const [key, config] of Object.entries(keys)) {
      const prefix = key.slice(0, 8) + "...";
      let access: string;
      if (config.admin) {
        access = "admin";
      } else if (config.project) {
        access = config.project;
      } else {
        access = "*";
      }
      console.log(`  ${prefix.padEnd(12)}| ${access}`);
    }
    console.log("");
  });

apikey
  .command("remove <prefix>")
  .description("Remove an API key by its prefix (first 8+ characters)")
  .option("-d, --data <path>", "Data directory", "/var/data/leangraph")
  .action((prefix: string, options: { data: string }) => {
    const dataPath = path.resolve(options.data);
    const keys = loadApiKeys(dataPath);

    // Find key by prefix
    const matchingKeys = Object.keys(keys).filter((k) => k.startsWith(prefix));

    if (matchingKeys.length === 0) {
      console.error(`No key found with prefix: ${prefix}`);
      process.exit(1);
    }

    if (matchingKeys.length > 1) {
      console.error(`Multiple keys match prefix '${prefix}'. Please be more specific.`);
      for (const key of matchingKeys) {
        console.error(`  - ${key.slice(0, 12)}...`);
      }
      process.exit(1);
    }

    const keyToRemove = matchingKeys[0];
    const config = keys[keyToRemove];
    delete keys[keyToRemove];

    saveApiKeys(dataPath, keys);

    console.log(`\nRemoved API key: ${keyToRemove.slice(0, 8)}...`);
    if (config.admin) {
      console.log(`Access: admin`);
    } else {
      console.log(`Access: ${config.project || "*"}`);
    }
  });

// ============================================================================
// Helpers
// ============================================================================

function printTable(columns: string[], rows: Record<string, unknown>[]): void {
  const widths = calculateColumnWidths(columns, rows);

  // Print header
  const header = columns.map((col) => col.padEnd(widths[col])).join(" | ");
  console.log(`  ${header}`);
  console.log(`  ${columns.map((col) => "-".repeat(widths[col])).join("-+-")}`);

  // Print rows
  for (const row of rows) {
    console.log(`  ${formatTableRow(columns, row, widths)}`);
  }
}

// Parse and run
program.parse();
