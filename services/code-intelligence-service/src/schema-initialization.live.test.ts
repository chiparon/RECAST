import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import mysql from 'mysql2/promise';
import { expect, it } from 'vitest';
import { SeekDbIndexStore } from './seekdb-index-store.js';
import { initializeSchema, schemaLockName, type SchemaInitializationProgress } from './schema-initialization.js';

// Opt-in: uses a uniquely named disposable database, never the application's index.
const live = process.env.RECAST_TEST_SEEKDB === '1';
const connectionOptions = { host: process.env.CODE_INTELLIGENCE_SEEKDB_HOST || '127.0.0.1',
  port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT || 2881), user: process.env.CODE_INTELLIGENCE_SEEKDB_USER || 'root',
  password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD || '', connectTimeout: 5000 };

it.skipIf(!live)('serializes two real schema initializers and resumes an upgrade whose column exists but acknowledgement is missing', async () => {
  const database = `recast_schema_test_${randomUUID().replaceAll('-', '')}`;
  const admin = await mysql.createConnection(connectionOptions);
  const progress: SchemaInitializationProgress[] = [];
  const config = { ...connectionOptions, database, vectorDimension: 8, initialization: { onProgress: (p: SchemaInitializationProgress) => progress.push(p) } };
  const first = new SeekDbIndexStore(config), second = new SeekDbIndexStore(config);
  try {
    await admin.query('SELECT GET_LOCK(?, 0)', [schemaLockName(database)]);
    const initializing = Promise.all([first.initialize(), second.initialize()]);
    // Install a handler immediately, including if a connection fails before release.
    const completed = initializing.then(() => undefined, error => error);
    await new Promise(resolve => setTimeout(resolve, 1500));
    await admin.query('SELECT RELEASE_LOCK(?)', [schemaLockName(database)]);
    expect(await completed).toBeUndefined();
    expect(progress.some(p => p.stage === 'waiting')).toBe(true);
    expect(progress.filter(p => p.stage === 'migrating' && p.migration === 4)).toHaveLength(1);
    // Simulate the crash window after successful DDL but before recording its version.
    await admin.query(`DELETE FROM \`${database}\`.schema_migrations WHERE version = 4`);
    await second.initialize();
    const [rows] = await admin.query(`SELECT version FROM \`${database}\`.schema_migrations ORDER BY version`);
    expect(rows).toEqual([1, 2, 3, 4, 5].map(version => ({ version })));
  } finally {
    await Promise.all([first.close(), second.close()]);
    await admin.query('SELECT RELEASE_LOCK(?)', [schemaLockName(database)]);
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
}, 120_000);

it.skipIf(!live)('a new process proceeds after the previous lock owner is terminated', async () => {
  const database = `recast_lock_test_${randomUUID().replaceAll('-', '')}`;
  const lock = schemaLockName(database);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import mysql from 'mysql2/promise';
    const config = JSON.parse(process.env.RECAST_LOCK_TEST_CONFIG);
    const connection = await mysql.createConnection(config.connection);
    await connection.query('SELECT GET_LOCK(?, 0)', [config.lock]);
    process.send({ ready: true });
    setInterval(() => {}, 1000);
  `], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, RECAST_LOCK_TEST_CONFIG: JSON.stringify({ connection: connectionOptions, lock }) } });
  const pool = mysql.createPool({ ...connectionOptions, connectionLimit: 1 });
  const progress: SchemaInitializationProgress[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Lock holder did not become ready')), 10_000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Lock holder exited before readiness')); });
    });
    let ran = false;
    const result = initializeSchema(pool, database, async () => { ran = true; }, { timeoutMs: 15_000, onProgress: p => progress.push(p) });
    const completed = result.then(() => undefined, error => error);
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(ran).toBe(false);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    expect(await completed).toBeUndefined();
    expect(ran).toBe(true);
    expect(progress.some(p => p.stage === 'waiting')).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    await pool.end();
  }
}, 30_000);
