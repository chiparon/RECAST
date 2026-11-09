import { createRequire } from "node:module";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  HashSearchEmbeddingProvider,
  InMemoryIndexStore,
  ModelSearchEmbeddingProvider,
  Sag2Bm25IndexStore,
  SeekDbIndexStore,
} from "../../../weichai/services/code-intelligence-service/src/index.ts";

export interface WorkerJob {
  caseId: string;
  config:
    | "seekdb-model"
    | "seekdb-hash"
    | "sag2-memory"
    | "sag2-sqlite-file"
    | "sag2-over-seekdb";
  workDir: string;
  repositories: {
    id: string;
    root: string;
    loc?: number;
    sourceList?: string;
    sourceFiles?: string[];
  }[];
  resultFile: string;
  database?: string;
  increments?: ("one" | "1pct" | "10pct")[];
  queries?: boolean;
  agent?: boolean;
}

const require = createRequire(
  new URL(
    "../../../weichai/services/code-intelligence-service/package.json",
    import.meta.url,
  ),
);
async function bytes(path: string) {
  try {
    return (await stat(path)).size;
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
}

// Observe the unmodified production provider, keeping its DB-backed model cache enabled.
// Each benchmark worker is a dedicated process, including its Embedding provider class.
export function countEmbeddingCalls(counter: {
  calls: number;
  vectors: number;
  httpCalls: number;
  httpInputs: number;
}) {
  for (const proto of [
    HashSearchEmbeddingProvider.prototype,
    ModelSearchEmbeddingProvider.prototype,
  ]) {
    const original = proto.embed;
    proto.embed = async function (texts, signal) {
      counter.calls++;
      const vectors = await original.call(this, texts, signal);
      counter.vectors += vectors.length;
      return vectors;
    };
  }
  const fetchImpl = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (
      new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname.endsWith("/embeddings")
    ) {
      counter.httpCalls++;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      counter.httpInputs += Array.isArray(body.input) ? body.input.length : 1;
    }
    return fetchImpl(input, init);
  };
}

export function buildStore(job: WorkerJob) {
  const db = job.database;
  const isSql =
    job.config.startsWith("seekdb-") || job.config === "sag2-over-seekdb";
  const isSag = job.config.startsWith("sag2-");
  const useModel = isSql && job.config !== "seekdb-hash";
  if (isSql && !/^recast_bench_[a-z0-9_]+$/.test(db ?? ""))
    throw Error("Expected an isolated recast_bench_* database");
  const env = process.env;
  const sql = {
    host: env.CODE_INTELLIGENCE_SEEKDB_HOST || "127.0.0.1",
    port: Number(env.CODE_INTELLIGENCE_SEEKDB_PORT || 2881),
    user: env.CODE_INTELLIGENCE_SEEKDB_USER || "root",
    password: env.CODE_INTELLIGENCE_SEEKDB_PASSWORD || "",
    database: db,
  };
  const vectorDimension = Number(
    env.CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION ||
      env.CODE_INTELLIGENCE_VECTOR_DIMENSION ||
      384,
  );
  const embedding = useModel
    ? {
        url:
          env.CODE_INTELLIGENCE_EMBEDDING_URL ||
          "http://127.0.0.1:4021/v1/embeddings",
        model:
          env.CODE_INTELLIGENCE_EMBEDDING_MODEL ||
          "Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78",
        apiKey: env.CODE_INTELLIGENCE_EMBEDDING_API_KEY || "",
        supportsDimensions:
          env.CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS === "true",
        queryPrefix: env.CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX ?? "query: ",
        documentPrefix:
          env.CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX ?? "passage: ",
        variant: env.CODE_INTELLIGENCE_EMBEDDING_VARIANT,
      }
    : undefined;
  const inner = isSql
    ? new SeekDbIndexStore({
        ...sql,
        database: db!,
        vectorDimension,
        embedding,
      })
    : new InMemoryIndexStore();
  const sqliteFile =
    job.config === "sag2-sqlite-file"
      ? join(job.workDir, "fts.sqlite")
      : undefined;
  const sag = isSag
    ? new Sag2Bm25IndexStore({ inner, bm25: { databasePath: sqliteFile } })
    : undefined;
  const store = sag ?? inner;
  const pool = isSql
    ? require("mysql2/promise").createPool({ ...sql, connectionLimit: 1 })
    : undefined;
  return {
    store,
    async documentCount(scope) {
      if (sag)
        return Number(
          sag.bm25.db
            .prepare(
              "SELECT count(*) AS n FROM sag2_documents WHERE repository_id=? AND analysis_revision=?",
            )
            .get(scope.repositoryId, scope.analysisRevision).n,
        );
      const [rows] = await pool.query(
        "SELECT /*+ QUERY_TIMEOUT(2000000) */ count(*) AS n FROM search_documents WHERE repository_id=? AND analysis_revision=?",
        [scope.repositoryId, scope.analysisRevision],
      );
      return Number(rows[0].n);
    },
    async storage() {
      let seekdbBytes: null | number = null,
        seekdbMeasurementError: string | undefined;
      let seekdbMemtableBytes: null | number = null,
        seekdbMeasurement: string | undefined;
      if (pool)
        try {
          const [rows] = await pool.query(
            "SELECT SUM(DATA_LENGTH + INDEX_LENGTH) AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA=?",
            [db],
          );
          if (rows[0].bytes != null && Number(rows[0].bytes) > 0) {
            seekdbBytes = Number(rows[0].bytes);
            seekdbMeasurement = "information_schema.TABLES data and index";
          } else {
            // Small newly created stores can still live predominantly in memtables.
            // Never force compaction on the shared server. Sample both sizes separately.
            const [tabletSizes] = await pool.query(
              "SELECT COUNT(*) AS n, " +
                "SUM(CASE WHEN s.TABLE_TYPE LIKE '%MEMTABLE' THEN s.SIZE ELSE 0 END) AS mem, " +
                "SUM(CASE WHEN s.TABLE_TYPE LIKE '%MEMTABLE' THEN 0 ELSE s.SIZE END) AS disk " +
                "FROM oceanbase.__all_database d JOIN oceanbase.__all_table t ON t.database_id=d.database_id " +
                "JOIN oceanbase.`GV$OB_SSTABLES` s ON s.TABLET_ID=t.tablet_id " +
                "WHERE d.database_name=? AND t.tablet_id>0",
              [db],
            );
            if (Number(tabletSizes[0].n) > 0) {
              seekdbBytes = Number(tabletSizes[0].disk);
              seekdbMemtableBytes = Number(tabletSizes[0].mem);
              seekdbMeasurement =
                "GV$OB_SSTABLES SIZE for database-owned tablets; disk excludes memtables";
            } else
              seekdbMeasurementError =
                "Server did not report bytes for this database's tablets";
          }
        } catch (e) {
          seekdbMeasurementError = String(e.message);
        }
      const page = (p: string) =>
        Number(Object.values(sag!.bm25.db.prepare("PRAGMA " + p).get())[0]);
      return {
        sqliteBytes: sag ? page("page_count") * page("page_size") : null,
        sqliteDiskBytes: sqliteFile
          ? (await bytes(sqliteFile)) +
            (await bytes(sqliteFile + "-wal")) +
            (await bytes(sqliteFile + "-shm"))
          : null,
        seekdbBytes,
        seekdbMemtableBytes,
        seekdbMeasurement,
        seekdbMeasurementError,
      };
    },
    async close() {
      try {
        await store.close?.();
      } finally {
        await pool?.end();
      }
    },
  };
}
