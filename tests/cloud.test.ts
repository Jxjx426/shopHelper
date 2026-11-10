import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { schema, type Database } from "../src/lib/db";
import { syncSchema } from "../src/lib/sync-schema";
import { createPostgresDatabase } from "../src/lib/postgres.server";
import { initialiseCloudDatabase } from "../src/lib/cloud-init.server";
import {
  migrationSource,
  migrateEmptyCloud,
  businessFingerprint,
} from "../src/lib/cloud-migration.server";
import {
  hashPassword,
  verifyPassword,
  makeSession,
  tokenHash,
  getSession,
} from "../src/lib/auth";
import { runActionIn, workspace, exportBackup } from "../src/lib/service";
import {
  createImport,
  imageForDraft,
  imageAssetForDraft,
} from "../src/lib/imports.server";
import { documentPreview, documentPdf } from "../src/lib/documents.server";
import { cloudDocumentAsset } from "../src/lib/file-response.server";
import { requestSession } from "../src/lib/request-session.server";
import { syncConfiguration, syncState } from "../src/lib/sync.server";
import { jwtVerify } from "jose";
import { prepareUpload, stagedFile } from "../src/lib/uploads.server";
import { hash, loadBlob } from "../src/lib/file-store.server";
import {
  createCloudJob,
  processCloudJob,
  jobStatus,
} from "../src/lib/cloud-jobs.server";
import { exportCloudRecord } from "../src/lib/cloud-backup.server";
import { cloudMode, cloudConfig } from "../src/lib/cloud-config.server";
import { GET as workspaceGet } from "../src/app/api/workspace/route";
import { GET as syncGet } from "../src/app/api/sync/route";
import { NextRequest } from "next/server";

const enabled = process.env.SHOP_TEST_CLOUD === "true",
  cloudTest = enabled ? test : test.skip;
let pg: EmbeddedPostgres,
  pool: Pool,
  source: PGlite,
  db: Database,
  bundle: Awaited<ReturnType<typeof migrationSource>>;
const adapters: Database[] = [],
  owner = randomUUID(),
  staff = Array.from({ length: 4 }, () => randomUUID()),
  tokens: string[] = [];
const day = "2026-11-08",
  objects = new Map<string, Buffer>(),
  dispatches: { id: string; secret: string }[] = [];
let zone: string,
  restaurant: string,
  orderId: string,
  originalDoc: string,
  imageDraft: string,
  imageBytes: Buffer;
const act = (actor: string, input: unknown, n = 0, key = randomUUID()) =>
  runActionIn(adapters[n] ?? source, actor, key, input);
const current = async () =>
  (await workspace(day)).orders.find((o) => o.id === orderId)!;
before(async () => {
  if (!enabled) return;
  process.env.SHOP_BACKEND = "local";
  process.env.GEMINI_FREE_TIER_CONFIRMED = "false";
  source = new PGlite();
  await source.waitReady;
  await source.exec(schema);
  await source.exec(syncSchema());
  globalThis.shopDatabase = Promise.resolve(source);
  globalThis.shopDatabaseSchema = 12;
  await source.query(
    "INSERT INTO users(id,name,username,password_hash) VALUES($1,'云端迁移测试店主','owner',$2)",
    [owner, hashPassword("cloud-test-only")],
  );
  for (let n = 0; n < 4; n++)
    await source.query(
      "INSERT INTO users(id,name,username,password_hash,role,can_import) VALUES($1,$2,$3,$4,'staff',$5)",
      [
        staff[n],
        `员工${n + 1}`,
        `staff${n + 1}`,
        hashPassword("cloud-test-only"),
        n === 2,
      ],
    );
  zone = (
    await act(owner, { action: "saveZone", name: "云端测试区", active: true })
  ).id;
  restaurant = (
    await act(owner, {
      action: "saveRestaurant",
      name: "云端大福屋",
      aliases: [],
      active: true,
    })
  ).id;
  const products = [];
  for (let n = 0; n < 4; n++)
    products.push(
      (
        await act(owner, {
          action: "saveProduct",
          name: `苹果${n + 1}`,
          aliases: [],
          zoneId: zone,
          sortOrder: n,
          active: true,
          units: [{ orderUnit: "kg", billingUnit: "kg", price: "6.00" }],
        })
      ).id,
    );
  orderId = (
    await act(owner, {
      action: "saveOrder",
      restaurantId: restaurant,
      date: day,
      urgent: false,
      items: products.map((productId) => ({
        productId,
        quantity: "10",
        unit: "kg",
      })),
    })
  ).id;
  const historical = (
    await act(owner, {
      action: "saveOrder",
      restaurantId: restaurant,
      date: "2026-11-07",
      urgent: false,
      items: [{ productId: products[0], quantity: "2.5", unit: "kg" }],
    })
  ).id;
  const item = (await workspace("2026-11-07")).orders[0].items[0];
  await act(owner, {
    action: "setPicking",
    id: item.id,
    version: item.task_version,
    picked: true,
  });
  await act(owner, {
    action: "saveActual",
    id: item.id,
    version: item.version,
    quantity: "2.5",
    unit: "kg",
  });
  const preview = await documentPreview(historical);
  await act(owner, {
    action: "finalizeOrder",
    id: historical,
    token: preview.token,
    finalChecked: true,
  });
  originalDoc = (await documentPreview(historical)).documents[0].id;
  imageBytes = await sharp({
    create: { width: 80, height: 120, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const image = { mime: "image/png", base64: imageBytes.toString("base64") };
  imageDraft = (
    await createImport(owner, randomUUID(), {
      restaurantId: restaurant,
      date: day,
      kind: "image",
      original: image,
      prepared: image,
    })
  ).id;
  await source.query(
    "INSERT INTO extraction_cache(cache_key,actor_id,result) VALUES('migration-cache',$1,'{\"kept\":true}')",
    [owner],
  );
  bundle = await migrationSource(source);
  const testPort = Number(process.env.SHOP_TEST_PG_PORT ?? 55440);
  assert(Number.isInteger(testPort) && testPort >= 1024 && testPort <= 65535);
  pg = new EmbeddedPostgres({
    databaseDir: path.join(
      process.cwd(),
      "test-results",
      `pg-cloud-${randomUUID()}`,
    ),
    port: testPort,
    user: "postgres",
    password: "isolated-test-only",
    // Keep the isolated test directory for diagnosis. On Windows, deleting
    // immediately after pg_ctl exits can race file handles held by the OS.
    persistent: true,
    createPostgresUser: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: ["-h", "127.0.0.1"],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  const options = {
    connectionString: `postgresql://postgres:isolated-test-only@127.0.0.1:${testPort}/postgres`,
    ssl: false as const,
  };
  pool = new Pool(options);
  await pool.query(
    "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; GRANT USAGE ON SCHEMA public TO anon,authenticated",
  );
  for (let n = 0; n < 4; n++) adapters.push(createPostgresDatabase(options));
  db = adapters[0];
  await initialiseCloudDatabase(db);
  Object.assign(process.env, {
    SHOP_BACKEND: "supabase",
    SHOP_CLOUD_FREE_TIER_CONFIRMED: "true",
    DATABASE_URL: options.connectionString,
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "test-public",
    SUPABASE_SERVICE_ROLE_KEY: "test-secret",
    SUPABASE_JWT_SECRET: "isolated-test-signing-secret-32-characters",
    SHOP_PUBLIC_ORIGIN: "https://test.netlify.app",
  });
  globalThis.shopDatabase = Promise.resolve(db);
  globalThis.shopFileStore = {
    async put(p, b) {
      objects.set(p, Buffer.from(b));
    },
    async get(p) {
      if (!objects.has(p)) throw new Error("missing test object");
      return objects.get(p)!;
    },
    async signRead(p) {
      return `https://storage.invalid/${p}`;
    },
    async signUpload(p) {
      return `https://storage.invalid/${p}`;
    },
    async remove(paths) {
      for (const p of paths) objects.delete(p);
    },
  };
  globalThis.shopJobDispatch = async (id, secret) => {
    dispatches.push({ id, secret });
  };
});
after(async () => {
  if (!enabled) return;
  globalThis.shopDatabase = undefined;
  globalThis.shopFileStore = undefined;
  globalThis.shopJobDispatch = undefined;
  await source?.close();
  await Promise.all(adapters.map((d) => d.close()));
  await pool?.end();
  await pg?.stop();
});

cloudTest(
  "cold migration preserves every business row, password hash, role, extraction cache, screenshot and historical PDF; existing cloud cannot be overwritten",
  async () => {
    await migrateEmptyCloud(db, bundle);
    assert.equal(
      businessFingerprint(await exportBackup()),
      businessFingerprint(bundle.backup),
    );
    const users = (await db.query<any>("SELECT * FROM users")).rows;
    assert.equal(users.length, 5);
    assert(
      users.every((u) => verifyPassword("cloud-test-only", u.password_hash)),
    );
    assert.equal(
      (await db.query<any>("SELECT result FROM extraction_cache")).rows[0]
        .result.kept,
      true,
    );
    assert.deepEqual(
      (await imageForDraft(owner, imageDraft, false)).bytes,
      imageBytes,
    );
    const old = (bundle.backup.tables.documents as any[])[0];
    assert.equal(hash((await documentPdf(originalDoc)).bytes), old.pdf_sha256);
    assert.equal(
      (await db.query<any>("SELECT pdf FROM documents")).rows[0].pdf,
      null,
    );
    await assert.rejects(migrateEmptyCloud(db, bundle), /已有资料/);
    for (let n = 0; n < 4; n++)
      tokens.push(
        await adapters[n].transaction((tx) => makeSession(tx, staff[n])),
      );
  },
);
cloudTest(
  "four independent PostgreSQL clients commit different items and exactly one wins same-item edits",
  async () => {
    const items = (await current()).items;
    await Promise.all(
      items.map((item, n) =>
        requestSession.run(tokenHash(tokens[n]), () =>
          act(
            staff[n],
            {
              action: "saveActual",
              id: item.id,
              version: item.version,
              quantity: String(10 + n / 10),
              unit: "kg",
            },
            n,
          ),
        ),
      ),
    );
    assert.deepEqual(
      (await current()).items.map((i) => i.amount),
      ["60.00", "60.60", "61.20", "61.80"],
    );
    const item = (await current()).items[0];
    const results = await Promise.allSettled(
      staff.map((actor, n) =>
        act(
          actor,
          {
            action: "saveActual",
            id: item.id,
            version: item.version,
            quantity: ["9.6", "9.7", "9.8", "9.9"][n],
            unit: "kg",
          },
          n,
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.filter((r) => r.status === "rejected" && r.reason.status === 409)
        .length,
      3,
    );
  },
);
cloudTest(
  "cross-instance lost-response retries create one audit entry; rollback retry succeeds; staff permissions and revoked queued sessions are enforced",
  async () => {
    const item = (await current()).items[1],
      key = randomUUID(),
      input = {
        action: "setPicking",
        id: item.id,
        version: item.task_version,
        picked: true,
      };
    const results = await Promise.all(
      adapters.map((_, n) => act(staff[0], input, n, key)),
    );
    assert(results.every((r) => r.id === item.id));
    assert.equal(
      (
        await db.query<any>(
          "SELECT count(*)::int n FROM operation_requests WHERE key=$1",
          [key],
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      act(staff[0], { action: "saveZone", name: "无权区域", active: true }),
      (e) => (e as any).status === 403,
    );
    const failedKey = randomUUID();
    await assert.rejects(
      adapters[2].transaction(async (tx) => {
        await tx.query("UPDATE shop SET name='must rollback'");
        throw new Error("lost before commit");
      }),
    );
    assert.notEqual(
      (await db.query<any>("SELECT name FROM shop")).rows[0].name,
      "must rollback",
    );
    await act(
      staff[1],
      {
        action: "saveActual",
        id: item.id,
        version: item.version,
        quantity: "10.2",
        unit: "kg",
      },
      1,
      failedKey,
    );
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (release = r));
    const revoke = adapters[0].transaction(async (tx) => {
      await tx.query("DELETE FROM sessions WHERE token_hash=$1", [
        tokenHash(tokens[3]),
      ]);
      started();
      await gate;
    });
    await blocked;
    const queued = requestSession.run(tokenHash(tokens[3]), () =>
      act(
        staff[3],
        { action: "setPicking", id: item.id, version: 2, picked: false },
        3,
      ),
    );
    queued.catch(() => {});
    release();
    await revoke;
    await assert.rejects(queued, (e) => (e as any).status === 401);
  },
);
cloudTest(
  "one sync revision per transaction; signed token has no secrets; RLS permits only active sessions and only the revision row",
  async () => {
    const initial = BigInt((await syncState()).revision);
    await db.transaction(async (tx) => {
      await tx.query("UPDATE products SET sort_order=sort_order+1");
      await tx.query("UPDATE shop SET name=name");
    });
    assert.equal(BigInt((await syncState()).revision), initial + 1n);
    const config = await syncConfiguration(staff[0], tokenHash(tokens[0]));
    assert.equal(config.mode, "supabase");
    if (config.mode !== "supabase") throw new Error();
    const claims = (
      await jwtVerify(
        config.token,
        new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET),
      )
    ).payload;
    assert.equal(claims.shop_session, tokenHash(tokens[0]));
    assert(!JSON.stringify(config).includes("test-secret"));
    assert(!JSON.stringify(config).includes(process.env.SUPABASE_JWT_SECRET!));
    const rls = async (token: string) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ shop_session: token }),
        ]);
        const rows = (await c.query("SELECT * FROM public.shop_sync")).rows;
        await c.query("ROLLBACK");
        return rows;
      } finally {
        c.release();
      }
    };
    assert.equal((await rls(tokenHash(tokens[0]))).length, 1);
    assert.equal((await rls("invalid")).length, 0);
    assert.equal((await rls(tokenHash(tokens[3]))).length, 0);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authenticated");
      await assert.rejects(
        c.query("SELECT password_hash FROM shop_private.users"),
        /permission denied/,
      );
      await c.query("ROLLBACK");
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE anon");
      await assert.rejects(
        c.query("SELECT * FROM public.shop_sync"),
        /permission denied/,
      );
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  },
);
cloudTest(
  "light cloud sync authenticates and reads revision in one SQL roundtrip, without leaking business content",
  async () => {
    const read = db.read!;
    let reads = 0;
    db.read = async <T>(sql: string, params?: any[]) => {
      reads++;
      return read<T>(sql, params);
    };
    try {
      const request = (token: string) =>
        new NextRequest("https://test.netlify.app/api/sync?light=1", {
          headers: { cookie: `fresh_session=${token}` },
        });
      const response = await syncGet(request(tokens[0]));
      assert.equal(response.status, 200);
      assert.equal(reads, 1);
      assert.deepEqual(Object.keys(await response.json()).sort(), [
        "generation",
        "revision",
      ]);
      assert.equal((await syncGet(request(tokens[3]))).status, 401);
    } finally {
      db.read = read;
    }
  },
);
cloudTest(
  "workspace ETags avoid full repeat responses without mixing delivery dates; cloud image/PDF references reuse saved files",
  async () => {
    const token = await db.transaction((tx) => makeSession(tx, owner));
    const request = (date: string, etag?: string) =>
      new NextRequest(`https://test.netlify.app/api/workspace?date=${date}`, {
        headers: {
          cookie: `fresh_session=${token}`,
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      });
    const first = await workspaceGet(request(day));
    assert.equal(first.status, 200);
    const etag = first.headers.get("ETag")!;
    assert.equal((await workspaceGet(request(day, etag))).status, 304);
    assert.equal((await workspaceGet(request("2026-11-07", etag))).status, 200);
    assert(await imageAssetForDraft(owner, imageDraft, false));
    await assert.rejects(imageAssetForDraft(staff[0], imageDraft, false));
    const firstPdf = await cloudDocumentAsset(originalDoc),
      count = objects.size;
    assert.deepEqual(await cloudDocumentAsset(originalDoc), firstPdf);
    assert.equal(objects.size, count);
    await assert.rejects(
      cloudDocumentAsset(originalDoc, false, "en"),
      /补填英文商品名/,
    );
    const oldBytes = Buffer.from((await documentPdf(originalDoc)).bytes);
    await db.query(
      "UPDATE products SET english_name='Apple' WHERE id=(SELECT snapshot->'items'->0->>'productId' FROM documents WHERE id=$1)",
      [originalDoc],
    );
    const english = await cloudDocumentAsset(originalDoc, false, "en");
    assert.notEqual(english.id, firstPdf.id);
    assert.deepEqual(
      await cloudDocumentAsset(originalDoc, false, "en"),
      english,
    );
    await db.query(
      "UPDATE products SET english_name='Fresh Apple' WHERE id=(SELECT snapshot->'items'->0->>'productId' FROM documents WHERE id=$1)",
      [originalDoc],
    );
    assert.notEqual(
      (await cloudDocumentAsset(originalDoc, false, "en")).id,
      english.id,
    );
    assert.deepEqual(
      Buffer.from((await documentPdf(originalDoc)).bytes),
      oldBytes,
    );
    assert.deepEqual(await cloudDocumentAsset(originalDoc), firstPdf);
  },
);
cloudTest(
  "signed uploads enforce account, type, length and chunk limits; incomplete files never become imports",
  async () => {
    await assert.rejects(
      prepareUpload(staff[0], {
        kind: "backup",
        mime: "application/json",
        size: 10,
      }),
    );
    await assert.rejects(
      prepareUpload(owner, {
        kind: "image",
        mime: "image/png",
        size: 6 * 1024 * 1024,
      }),
    );
    const upload = await prepareUpload(owner, {
      kind: "image",
      mime: "image/png",
      size: imageBytes.length,
    });
    assert(upload.direct);
    if (!upload.direct) throw new Error();
    await assert.rejects(stagedFile(owner, upload.id, "image"));
    const p = new URL(upload.parts[0].url).pathname.slice(1);
    objects.set(p, imageBytes);
    assert.deepEqual(
      (await stagedFile(owner, upload.id, "image")).bytes,
      imageBytes,
    );
    await assert.rejects(stagedFile(staff[2], upload.id, "image"), /不属于/);
    const draft = await createImport(owner, randomUUID(), {
      kind: "image",
      restaurantId: restaurant,
      date: day,
      originalAssetId: upload.id,
      preparedAssetId: upload.id,
    });
    assert(draft.id);
  },
);
cloudTest(
  "background jobs are bounded and idempotent, reject wrong nonce/actor, and private full backups retain historical prices",
  async () => {
    const token = await db.transaction((tx) => makeSession(tx, owner)),
      key = `${owner}:${randomUUID()}`;
    const job = await createCloudJob(
      owner,
      tokenHash(token),
      { kind: "backup" },
      key,
    );
    assert.deepEqual(
      await createCloudJob(owner, tokenHash(token), { kind: "backup" }, key),
      job,
    );
    assert.equal(dispatches.filter((d) => d.id === job.jobId).length, 1);
    await assert.rejects(processCloudJob(job.jobId, "wrong"));
    await assert.rejects(jobStatus(staff[0], job.jobId));
    const sent = dispatches.find((d) => d.id === job.jobId)!;
    await processCloudJob(sent.id, sent.secret);
    await processCloudJob(sent.id, sent.secret);
    const status = await jobStatus(owner, job.jobId);
    assert.equal(status.status, "succeeded");
    const row = (
      await db.query<any>("SELECT response FROM cloud_jobs WHERE id=$1", [
        job.jobId,
      ])
    ).rows[0];
    const full = JSON.parse(
      (await loadBlob(null, row.response.assetId)).toString(),
    );
    assert.equal(full.tables.documents[0].snapshot.items[0].price, "6.00");
    assert(!JSON.stringify(full).includes("password_hash"));
    const pdfJob = await createCloudJob(owner, tokenHash(token), {
      kind: "pdf-range",
      from: "2026-11-07",
      to: "2026-11-07",
      language: "en",
      summary: "first",
    });
    const dispatched = dispatches.find((d) => d.id === pdfJob.jobId)!;
    await processCloudJob(dispatched.id, dispatched.secret);
    const pdfStatus = await jobStatus(owner, pdfJob.jobId);
    assert.equal(pdfStatus.status, "succeeded");
    const pdfResponse = (
      await db.query<any>("SELECT response FROM cloud_jobs WHERE id=$1", [
        pdfJob.jobId,
      ])
    ).rows[0].response;
    assert(pdfResponse.filename.endsWith("-en.pdf"));
    assert.equal(pdfResponse.count, 1);
  },
);
cloudTest(
  "cloud restore records safety snapshot and completion atomically, preserves credentials/files, revokes sessions, and receipt survives a lost response",
  async () => {
    const token = await db.transaction((tx) => makeSession(tx, owner)),
      snapshot = await exportBackup();
    const bytes = Buffer.from(JSON.stringify(snapshot)),
      upload = await prepareUpload(owner, {
        kind: "backup",
        mime: "application/json",
        size: bytes.length,
      });
    if (!upload.direct) throw new Error();
    let offset = 0;
    for (const part of upload.parts) {
      objects.set(
        new URL(part.url).pathname.slice(1),
        bytes.subarray(offset, offset + part.size),
      );
      offset += part.size;
    }
    const previewJob = await createCloudJob(owner, tokenHash(token), {
      kind: "restore-preview",
      uploadId: upload.id,
    });
    let sent = dispatches.at(-1)!;
    await processCloudJob(sent.id, sent.secret);
    const preview = (await jobStatus(owner, previewJob.jobId)).result;
    assert(preview.token);
    const confirm = await createCloudJob(owner, tokenHash(token), {
      kind: "restore-confirm",
      token: preview.token,
      shopName: preview.shopName,
      confirm: true,
    });
    sent = dispatches.at(-1)!;
    await processCloudJob(sent.id, sent.secret);
    const result = await jobStatus(null, confirm.jobId, confirm.receipt);
    assert.equal(result.status, "succeeded");
    assert(result.result.restored);
    assert.equal(await getSession(token), null);
    const before = businessFingerprint(await exportBackup());
    await processCloudJob(sent.id, sent.secret);
    assert.equal(businessFingerprint(await exportBackup()), before);
    const safety = await exportCloudRecord(result.result.safetyFile);
    assert.equal(businessFingerprint(safety), businessFingerprint(snapshot));
    assert.deepEqual(
      (await imageForDraft(owner, imageDraft, false)).bytes,
      imageBytes,
    );
    assert(
      (await documentPdf(originalDoc)).bytes.subarray(0, 5).toString() ===
        "%PDF-",
    );
    assert(
      (
        await db.query<any>("SELECT password_hash FROM users WHERE id=$1", [
          owner,
        ])
      ).rows[0].password_hash ===
        bundle.users.find((u) => u.id === owner)!.password_hash,
    );
  },
);
cloudTest(
  "daily backup reuses immutable business files; maintenance clears only expired unreferenced temporary files",
  async () => {
    const beforeBusiness = new Set(
      [...objects.keys()].filter((k) =>
        k.includes((bundle.backup.tables.documents as any[])[0].pdf_sha256),
      ),
    );
    const job = await createCloudJob(
        owner,
        null,
        { kind: "daily-backup" },
        `daily:test`,
      ),
      sent = dispatches.at(-1)!;
    await processCloudJob(sent.id, sent.secret);
    const state = await jobStatus(owner, job.jobId);
    assert.equal(state.status, "succeeded");
    assert.equal(
      (await db.query("SELECT id FROM backup_records WHERE kind='daily'")).rows
        .length,
      1,
    );
    for (const p of beforeBusiness) assert(objects.has(p));
    const temporary = (
      await db.query<any>(
        "SELECT id,parts FROM file_assets WHERE kind='temporary' LIMIT 1",
      )
    ).rows[0];
    assert(temporary);
    await db.query(
      "UPDATE file_assets SET expires_at=now()-interval '2 days' WHERE id=$1",
      [temporary.id],
    );
    const maintenance = await createCloudJob(owner, null, {
      kind: "maintenance",
    });
    const next = dispatches.at(-1)!;
    await processCloudJob(next.id, next.secret);
    assert.equal(
      (await jobStatus(owner, maintenance.jobId)).status,
      "succeeded",
    );
    assert.equal(
      (await db.query("SELECT id FROM file_assets WHERE id=$1", [temporary.id]))
        .rows.length,
      0,
    );
    assert((await documentPdf(originalDoc)).bytes.length > 0);
  },
);
cloudTest(
  "enqueue failure preserves a failed job without automatic replay; pending quotas and explicit manual retry stay bounded",
  async () => {
    let calls = 0;
    globalThis.shopJobDispatch = async () => {
      calls++;
      throw new Error("offline");
    };
    const key = `${owner}:${randomUUID()}`,
      job = await createCloudJob(owner, null, { kind: "backup" }, key);
    assert.equal((await jobStatus(owner, job.jobId)).status, "failed");
    await createCloudJob(owner, null, { kind: "backup" }, key);
    assert.equal(calls, 1);
    globalThis.shopJobDispatch = async (id, secret) => {
      dispatches.push({ id, secret });
    };
    const a = await createCloudJob(owner, null, { kind: "backup" }),
      b = await createCloudJob(owner, null, { kind: "backup" });
    await assert.rejects(
      createCloudJob(owner, null, { kind: "backup" }),
      (e) => (e as any).status === 429,
    );
    for (const id of [a.jobId, b.jobId]) {
      const sent = dispatches.find((d) => d.id === id)!;
      await processCloudJob(sent.id, sent.secret);
      assert.equal((await jobStatus(owner, id)).status, "succeeded");
    }
  },
);
cloudTest(
  "cloud refuses unconfirmed plans and Netlify local fallback; corrupt private objects fail checksum validation",
  async () => {
    process.env.SHOP_CLOUD_FREE_TIER_CONFIRMED = "false";
    assert.throws(cloudConfig, /免费/);
    process.env.SHOP_CLOUD_FREE_TIER_CONFIRMED = "true";
    process.env.NETLIFY = "true";
    process.env.SHOP_BACKEND = "local";
    assert.throws(cloudMode, /持久/);
    delete process.env.NETLIFY;
    process.env.SHOP_BACKEND = "supabase";
    const asset = (
        await db.query<any>(
          "SELECT id,parts FROM file_assets WHERE kind='business' LIMIT 1",
        )
      ).rows[0],
      p = asset.parts[0].path,
      original = objects.get(p)!;
    objects.set(p, Buffer.alloc(original.length, 1));
    await assert.rejects(loadBlob(null, asset.id), /校验/);
    objects.set(p, original);
    assert.equal(hash(await loadBlob(null, asset.id)), asset.id);
  },
);
