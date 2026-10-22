import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { seekDbQueryTimeoutMs } from './seekdb-timeouts.js';

export interface SchemaInitializationProgress {
  stage: 'waiting' | 'initializing' | 'migrating' | 'ready';
  message: string;
  migration?: number;
}

export interface SchemaInitializationOptions {
  onProgress?: (progress: SchemaInitializationProgress) => void;
  /** Includes waiting for other hosts and retrying interrupted DDL. */
  timeoutMs?: number;
}

export function schemaLockName(database: string): string {
  return `recast:schema:${createHash('sha256').update(database.toLowerCase()).digest('hex').slice(0, 40)}`;
}

function databaseErrorCode(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'errno' in error && typeof error.errno === 'number'
    ? error.errno : undefined;
}

export function isSchemaBusy(error: unknown): boolean {
  const errno = databaseErrorCode(error);
  // Lock conflicts are retryable. SeekDB's OB_OP_NOT_ALLOW can also be returned
  // while a disconnected predecessor's table redefinition is being cleaned up.
  // Do not treat arbitrary permission, authentication or syntax errors as busy.
  return errno === 1205 || errno === 1213 || errno === 4038 || errno === 1060 || errno === 1061 ||
    errno !== undefined && error instanceof Error && error.message === 'Operation not allowed now';
}

export function schemaInitializationError(error: unknown, operation: string): Error {
  const errno = databaseErrorCode(error);
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`索引数据库初始化失败（${operation}${errno === undefined ? '' : `，数据库错误码 ${errno}`}）：${detail}`, { cause: error });
}

/**
 * Use one session for both the advisory lock and every schema statement.
 * Losing that session releases the lock AND prevents the old host from issuing
 * more DDL. A separate heartbeat/lease would allow two writers after a pause.
 * Server-side DDL may outlive the session, so retry from idempotent probes only.
 */
export async function initializeSchema(
  pool: Pool,
  database: string,
  operation: (connection: PoolConnection) => Promise<void>,
  options: SchemaInitializationOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Schema initialization timeout must be positive.');
  const deadline = Date.now() + timeoutMs;
  const report = options.onProgress ?? (() => {});
  const lock = schemaLockName(database);
  let connection: PoolConnection | undefined;
  let acquired = false;
  let reusable = true;
  let phase = '连接数据库';
  try {
    report({ stage: 'initializing', message: '正在检查索引数据库版本…' });
    connection = await pool.getConnection();
    phase = '等待数据库升级锁';
    while (!acquired) {
      const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 1) AS acquired', [lock]);
      acquired = Number(rows[0]?.acquired) === 1;
      if (acquired) break;
      if (rows[0]?.acquired == null) throw new Error('数据库无法取得升级锁，请检查数据库版本和权限。');
      report({ stage: 'waiting', message: '另一窗口正在初始化索引数据库，完成后将自动继续…' });
      if (Date.now() >= deadline) throw new Error('等待索引数据库升级超时，请稍后重试；已有数据已保留。');
    }
    // DDL on an existing corpus can take minutes; keep its budget separate from search.
    await connection.query(`SET SESSION ob_query_timeout = ${Math.ceil(timeoutMs * 1000)}`);
    while (true) {
      phase = '检查或升级表结构';
      report({ stage: 'initializing', message: '正在检查索引数据库结构…' });
      try { await operation(connection); break; }
      catch (error) {
        if (!isSchemaBusy(error)) throw error;
        if (Date.now() >= deadline) throw new Error('旧数据库升级任务仍未结束，等待超时；请稍后重试，已有数据已保留。', { cause: error });
        report({ stage: 'waiting', message: '正在等待上次数据库升级完成或清理，随后自动恢复…' });
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
      }
    }
    report({ stage: 'ready', message: '索引数据库已就绪。' });
  } catch (error) {
    if (!acquired) reusable = false;
    throw schemaInitializationError(error, phase);
  } finally {
    if (connection) {
      if (acquired) {
        try {
          await connection.query(`SET SESSION ob_query_timeout = ${seekDbQueryTimeoutMs * 1000}`);
          const [rows] = await connection.query<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [lock]);
          reusable = Number(rows[0]?.released) === 1;
        } catch { reusable = false; }
      }
      if (reusable) connection.release();
      else connection.destroy();
    }
  }
}
