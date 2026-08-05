const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;
const MAX_QUESTIONS = 500;
const ID_PATTERN = /^[a-zA-Z0-9_-]{6,40}$/;

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
});

const getStore = (context) => context.env.TESTOGRAF_TESTS;

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
    const data = await response.json();
    const user = data.users?.[0];
    if (!user?.email || user.email.toLowerCase() !== adminEmail) {
      return { error: "Administrator access required", status: 403 };
    }
    return { user };
  } catch {
    return { error: "Authentication service unavailable", status: 503 };
  }
};

const generateTestId = () => `t_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

const hasValidOptions = (options) => {
  if (Array.isArray(options)) return options.filter(Boolean).length >= 2;
  if (options && typeof options === "object") return Object.values(options).filter(Boolean).length >= 2;
  return false;
};

const validateCampaign = (campaign) => {
  if (!campaign || typeof campaign !== "object") return "Invalid test data: campaign is required";
  if (typeof campaign.title !== "string" || !campaign.title.trim()) return "Invalid test data: title is required";
  if (!Array.isArray(campaign.localQuestions)) return "Invalid test data: localQuestions must be an array";
  if (campaign.localQuestions.length > MAX_QUESTIONS) return `Invalid test data: maximum ${MAX_QUESTIONS} questions are allowed`;

  const invalidIndex = campaign.localQuestions.findIndex((question) => {
    if (!question || typeof question !== "object") return true;
    if (typeof question.question !== "string" || !question.question.trim()) return true;
    if (!hasValidOptions(question.options)) return true;
    return false;
  });

  if (invalidIndex >= 0) return `Invalid test data: question ${invalidIndex + 1} is incomplete`;
  return null;
};

const generateUniqueId = async (store) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = generateTestId();
    const existing = await store.get(id);
    if (!existing) return id;
  }
  return null;
};

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestPost(context) {
  const store = getStore(context);
  if (!store) return jsonResponse({ error: "KV namespace TESTOGRAF_TESTS is not configured" }, 500);

  const authentication = await authenticateAdmin(context);
  if (authentication.error) return jsonResponse({ error: authentication.error }, authentication.status);

  const rawBody = await context.request.text();
  if (new TextEncoder().encode(rawBody).length > MAX_PAYLOAD_BYTES) {
    return jsonResponse({ error: "Test payload is too large" }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const campaign = payload?.campaign || payload;
  const validationError = validateCampaign(campaign);
  if (validationError) return jsonResponse({ error: validationError }, 400);

  const id = await generateUniqueId(store);
  if (!id) return jsonResponse({ error: "Could not generate unique test id" }, 500);
  const storedCampaign = { ...campaign, id, shortCode: id };
  await store.put(id, JSON.stringify({
    schemaVersion: 1,
    campaign: storedCampaign,
    firebaseConfig: payload?.firebaseConfig || null,
    createdBy: authentication.user.localId,
    updatedAt: new Date().toISOString(),
    // Future hardening: rate limits, TTL/retention policy, and archival of large tests to R2.
  }));

  return jsonResponse({ id });
}

export async function onRequestGet(context) {
  const store = getStore(context);
  if (!store) return jsonResponse({ error: "KV namespace TESTOGRAF_TESTS is not configured" }, 500);

  const params = new URL(context.request.url).searchParams;
  if (params.get("list") === "1") {
    const authentication = await authenticateAdmin(context);
    if (authentication.error) return jsonResponse({ error: authentication.error }, authentication.status);
    const tests = [];
    let cursor;
    do {
      const page = await store.list({ prefix: "t_", cursor, limit: 1000 });
      const values = await Promise.all(page.keys.map(({ name }) => store.get(name)));
      values.forEach((value) => {
        if (!value) return;
        try {
          const parsed = JSON.parse(value);
          const campaign = parsed?.campaign || parsed;
          if (campaign?.id) tests.push(campaign);
        } catch {
          // A corrupted record must not hide the rest of the catalog.
        }
      });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    tests.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return jsonResponse({ tests });
  }

  const id = params.get("id");
  if (!id || !ID_PATTERN.test(id)) return jsonResponse({ error: "Invalid test id" }, 400);

  const stored = await store.get(id);
  if (!stored) return jsonResponse({ error: "Test not found" }, 404);

  try {
    return jsonResponse(JSON.parse(stored));
  } catch {
    return jsonResponse({ error: "Stored test data is corrupted" }, 500);
  }
}

export async function onRequestPut(context) {
  const store = getStore(context);
  if (!store) return jsonResponse({ error: "KV namespace TESTOGRAF_TESTS is not configured" }, 500);
  const authentication = await authenticateAdmin(context);
  if (authentication.error) return jsonResponse({ error: authentication.error }, authentication.status);

  const id = new URL(context.request.url).searchParams.get("id");
  if (!id || !ID_PATTERN.test(id)) return jsonResponse({ error: "Invalid test id" }, 400);
  const existingRaw = await store.get(id);
  if (!existingRaw) return jsonResponse({ error: "Test not found" }, 404);

  const rawBody = await context.request.text();
  if (new TextEncoder().encode(rawBody).length > MAX_PAYLOAD_BYTES) return jsonResponse({ error: "Test payload is too large" }, 413);
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
  const campaign = payload?.campaign || payload;
  const validationError = validateCampaign(campaign);
  if (validationError) return jsonResponse({ error: validationError }, 400);

  let existing;
  try { existing = JSON.parse(existingRaw); } catch { return jsonResponse({ error: "Stored test data is corrupted" }, 500); }
  const storedCampaign = { ...campaign, id, shortCode: id };
  await store.put(id, JSON.stringify({
    schemaVersion: 1,
    campaign: storedCampaign,
    firebaseConfig: payload?.firebaseConfig ?? existing.firebaseConfig ?? null,
    createdBy: existing.createdBy || authentication.user.localId,
    updatedAt: new Date().toISOString(),
  }));
  return jsonResponse({ id });
}

export async function onRequestDelete(context) {
  const store = getStore(context);
  if (!store) return jsonResponse({ error: "KV namespace TESTOGRAF_TESTS is not configured" }, 500);
  const authentication = await authenticateAdmin(context);
  if (authentication.error) return jsonResponse({ error: authentication.error }, authentication.status);
  const id = new URL(context.request.url).searchParams.get("id");
  if (!id || !ID_PATTERN.test(id)) return jsonResponse({ error: "Invalid test id" }, 400);
  if (!await store.get(id)) return jsonResponse({ error: "Test not found" }, 404);
  await store.delete(id);
  return new Response(null, { status: 204 });
}

export async function onRequest() {
  return jsonResponse({ error: "Method not allowed" }, 405);
}
