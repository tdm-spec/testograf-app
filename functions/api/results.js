const MAX_PAYLOAD_BYTES = 512 * 1024;
const RESULT_PREFIX = "result:";
const DELETED_RESULT_PREFIX = "deleted-result:";
const BACKUP_RESULT_PREFIX = "backup:result:";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
});

const authenticateAdmin = async (context) => {
  const apiKey = context.env.FIREBASE_API_KEY;
  const adminEmail = (context.env.ADMIN_EMAIL || "").toLowerCase();
  if (!apiKey || !adminEmail) return { error: "API authentication is not configured", status: 500 };

  const authorization = context.request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return { error: "Authentication required", status: 401 };

  try {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: token }),
    });
    if (!response.ok) return { error: "Invalid authentication token", status: 401 };
    const user = (await response.json()).users?.[0];
    if (!user?.email || user.email.toLowerCase() !== adminEmail) {
      return { error: "Administrator access required", status: 403 };
    }
    return { user };
  } catch {
    return { error: "Authentication service unavailable", status: 503 };
  }
};

const validateResult = (result) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "Result data is required";
  if (typeof result.id !== "string" || !/^cand_[a-zA-Z0-9_-]{8,80}$/.test(result.id)) return "Invalid result id";
  if (typeof result.testId !== "string" || !result.testId.trim()) return "Test id is required";
  if (typeof result.name !== "string" || !result.name.trim()) return "Candidate name is required";
  if (!Number.isFinite(Number(result.timestamp))) return "Result timestamp is required";
  if (result.answers != null && !Array.isArray(result.answers) && typeof result.answers !== "object") return "Invalid answers";
  return null;
};

const backupResult = async (store, result, deletedAt = null) => {
  if (!store) return;
  await store.put(`${BACKUP_RESULT_PREFIX}${result.id}`, JSON.stringify({
    schemaVersion: 1,
    result,
    deletedAt,
    backedUpAt: new Date().toISOString(),
  }));
};

const saveToD1 = async (db, result) => {
  const existing = await db.prepare("SELECT deleted_at FROM results WHERE id = ?").bind(result.id).first();
  if (existing?.deleted_at) return { status: 410 };
  if (existing) return { status: 409 };
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO results
    (id, test_id, candidate_name, submitted_at, payload, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
    .bind(result.id, result.testId, result.name, Number(result.timestamp), JSON.stringify({ ...result, syncStatus: "synced" }), now, now)
    .run();
  return { status: 201 };
};

const ensureD1Schema = async (db) => {
  if (!db) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS results (
      id TEXT PRIMARY KEY, test_id TEXT NOT NULL, candidate_name TEXT NOT NULL,
      submitted_at INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, deleted_at TEXT)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_results_active_submitted ON results(deleted_at, submitted_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_results_test ON results(test_id, deleted_at, submitted_at DESC)"),
  ]);
};

export async function onRequestPost(context) {
  const store = context.env.TESTOGRAF_TESTS;
  const db = context.env.RESULTS_DB;
  if (!store && !db) return jsonResponse({ error: "Results storage is not configured" }, 500);

  const rawBody = await context.request.text();
  if (new TextEncoder().encode(rawBody).length > MAX_PAYLOAD_BYTES) {
    return jsonResponse({ error: "Result payload is too large" }, 413);
  }

  let result;
  try {
    result = JSON.parse(rawBody)?.result;
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const validationError = validateResult(result);
  if (validationError) return jsonResponse({ error: validationError }, 400);

  if (db) {
    await ensureD1Schema(db);
    const saved = await saveToD1(db, result);
    if (saved.status === 410) return jsonResponse({ error: "Result was deleted" }, 410);
    await backupResult(store, { ...result, syncStatus: "synced" });
    return jsonResponse({ id: result.id, storage: "d1", confirmed: true }, saved.status);
  }

  const key = `${RESULT_PREFIX}${result.id}`;
  if (await store.get(`${DELETED_RESULT_PREFIX}${result.id}`)) return jsonResponse({ error: "Result was deleted" }, 410);
  if (await store.get(key)) return jsonResponse({ error: "Result already exists" }, 409);

  await store.put(key, JSON.stringify({
    schemaVersion: 1,
    result: { ...result, syncStatus: "synced" },
    updatedAt: new Date().toISOString(),
    // Future hardening: rate limiting and automated retention can be added here.
  }));
  await backupResult(store, { ...result, syncStatus: "synced" });
  return jsonResponse({ id: result.id, storage: "kv", confirmed: true }, 201);
}

export async function onRequestGet(context) {
  const store = context.env.TESTOGRAF_TESTS;
  const db = context.env.RESULTS_DB;
  if (!store && !db) return jsonResponse({ error: "Results storage is not configured" }, 500);

  const authentication = await authenticateAdmin(context);
  if (authentication.error) return jsonResponse({ error: authentication.error }, authentication.status);

  const showDeleted = new URL(context.request.url).searchParams.get("deleted") === "1";
  if (db) {
    await ensureD1Schema(db);
    const query = showDeleted
      ? "SELECT payload, deleted_at FROM results WHERE deleted_at IS NOT NULL ORDER BY submitted_at DESC"
      : "SELECT payload, deleted_at FROM results WHERE deleted_at IS NULL ORDER BY submitted_at DESC";
    const rows = await db.prepare(query).all();
    const results = (rows.results || []).map(row => ({ ...JSON.parse(row.payload), deletedAt: row.deleted_at || null }));
    return jsonResponse({ results, storage: "d1" });
  }

  const results = [];
  let cursor;
  do {
    const page = await store.list({ prefix: RESULT_PREFIX, cursor, limit: 1000 });
    const values = await Promise.all(page.keys.map(({ name }) => store.get(name)));
    values.forEach((value) => {
      if (!value) return;
      try {
        const parsed = JSON.parse(value);
        const result = parsed?.result || parsed;
        if (result?.id && Boolean(result.deletedAt) === showDeleted) results.push(result);
      } catch {
        // Ignore a corrupted record and keep the rest of the report available.
      }
    });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  results.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  return jsonResponse({ results });
}

export async function onRequestDelete(context) {
  const store = context.env.TESTOGRAF_TESTS;
  const db = context.env.RESULTS_DB;
  if (!store && !db) return jsonResponse({ error: "Results storage is not configured" }, 500);
  const authentication = await authenticateAdmin(context);
  if (authentication.error) return jsonResponse({ error: authentication.error }, authentication.status);
  const id = new URL(context.request.url).searchParams.get("id");
  if (!id || !/^cand_[a-zA-Z0-9_-]{8,80}$/.test(id)) return jsonResponse({ error: "Invalid result id" }, 400);
  const deletedAt = new Date().toISOString();
  if (db) {
    await ensureD1Schema(db);
    const existing = await db.prepare("SELECT payload FROM results WHERE id = ? AND deleted_at IS NULL").bind(id).first();
    if (!existing) return jsonResponse({ error: "Result not found" }, 404);
    await db.prepare("UPDATE results SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(deletedAt, deletedAt, id).run();
    await backupResult(store, JSON.parse(existing.payload), deletedAt);
    return new Response(null, { status: 204 });
  }
  const key = `${RESULT_PREFIX}${id}`;
  const existingRaw = await store.get(key);
  if (!existingRaw) return jsonResponse({ error: "Result not found" }, 404);
  const existing = JSON.parse(existingRaw);
  const deletedResult = { ...(existing.result || existing), deletedAt };
  await store.put(key, JSON.stringify({ schemaVersion: 1, result: deletedResult, updatedAt: deletedAt }));
  await store.put(`${DELETED_RESULT_PREFIX}${id}`, deletedAt);
  await backupResult(store, deletedResult, deletedAt);
  return new Response(null, { status: 204 });
}

export async function onRequestPatch(context) {
  const store = context.env.TESTOGRAF_TESTS;
  const db = context.env.RESULTS_DB;
  if (!store && !db) return jsonResponse({ error: "Results storage is not configured" }, 500);
  const authentication = await authenticateAdmin(context);
  if (authentication.error) return jsonResponse({ error: authentication.error }, authentication.status);
  const id = new URL(context.request.url).searchParams.get("id");
  if (!id || !/^cand_[a-zA-Z0-9_-]{8,80}$/.test(id)) return jsonResponse({ error: "Invalid result id" }, 400);
  if (db) {
    await ensureD1Schema(db);
    const existing = await db.prepare("SELECT payload FROM results WHERE id = ? AND deleted_at IS NOT NULL").bind(id).first();
    if (!existing) return jsonResponse({ error: "Deleted result not found" }, 404);
    const now = new Date().toISOString();
    await db.prepare("UPDATE results SET deleted_at = NULL, updated_at = ? WHERE id = ?").bind(now, id).run();
    await backupResult(store, JSON.parse(existing.payload));
    return jsonResponse({ id, restored: true });
  }
  const key = `${RESULT_PREFIX}${id}`;
  const raw = await store.get(key);
  if (!raw) return jsonResponse({ error: "Deleted result not found" }, 404);
  const parsed = JSON.parse(raw);
  const result = { ...(parsed.result || parsed) };
  delete result.deletedAt;
  await store.put(key, JSON.stringify({ schemaVersion: 1, result, updatedAt: new Date().toISOString() }));
  await store.delete(`${DELETED_RESULT_PREFIX}${id}`);
  await backupResult(store, result);
  return jsonResponse({ id, restored: true });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequest() {
  return jsonResponse({ error: "Method not allowed" }, 405);
}
