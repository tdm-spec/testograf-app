const MAX_PAYLOAD_BYTES = 512 * 1024;
const RESULT_PREFIX = "result:";

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

export async function onRequestPost(context) {
  const store = context.env.TESTOGRAF_TESTS;
  if (!store) return jsonResponse({ error: "KV namespace TESTOGRAF_TESTS is not configured" }, 500);

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

  const key = `${RESULT_PREFIX}${result.id}`;
  if (await store.get(key)) return jsonResponse({ error: "Result already exists" }, 409);

  await store.put(key, JSON.stringify({
    schemaVersion: 1,
    result: { ...result, syncStatus: "synced" },
    updatedAt: new Date().toISOString(),
    // Future hardening: rate limiting and automated retention can be added here.
  }));
  return jsonResponse({ id: result.id }, 201);
}

export async function onRequestGet(context) {
  const store = context.env.TESTOGRAF_TESTS;
  if (!store) return jsonResponse({ error: "KV namespace TESTOGRAF_TESTS is not configured" }, 500);

  const authentication = await authenticateAdmin(context);
  if (authentication.error) return jsonResponse({ error: authentication.error }, authentication.status);

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
        if (result?.id) results.push(result);
      } catch {
        // Ignore a corrupted record and keep the rest of the report available.
      }
    });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  results.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  return jsonResponse({ results });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequest() {
  return jsonResponse({ error: "Method not allowed" }, 405);
}
