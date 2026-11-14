'use strict';
// Q7 operational ledger. This is deliberately separate from the 42-table business
// contract: only the explicitly invoked maintenance tool creates this table.
const LEDGER_SQL = `CREATE TABLE IF NOT EXISTS sysbuild_schema_migrations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 from_version INTEGER NOT NULL CHECK (from_version BETWEEN 0 AND 6),
 to_version INTEGER NOT NULL CHECK (to_version BETWEEN 1 AND 6 AND to_version > from_version),
 contract_sha256 TEXT NOT NULL CHECK (length(contract_sha256) = 64),
 backup_sha256 TEXT NOT NULL CHECK (length(backup_sha256) = 64),
 applied_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
)`;
module.exports = { LEDGER_SQL };
