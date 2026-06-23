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
  const storedCampaign = { ...campaign, id };
  await store.put(id, JSON.stringify({
    schemaVersion: 1,
    campaign: storedCampaign,
    firebaseConfig: payload?.firebaseConfig || null,
    updatedAt: new Date().toISOString(),
    // Future production hardening can add auth, rate limits, TTL, or archival to R2 here.
  }));

  return jsonResponse({ id });
}

export async function onRequestGet(context) {
  const store = getStore(context);
  if (!store) return jsonResponse({ error: "KV namespace TESTOGRAF_TESTS is not configured" }, 500);

  const id = new URL(context.request.url).searchParams.get("id");
  if (!id || !ID_PATTERN.test(id)) return jsonResponse({ error: "Invalid test id" }, 400);

  const stored = await store.get(id);
  if (!stored) return jsonResponse({ error: "Test not found" }, 404);

  try {
    return jsonResponse(JSON.parse(stored));
  } catch {
    return jsonResponse({ error: "Stored test data is corrupted" }, 500);
  }
}

export async function onRequest() {
  return jsonResponse({ error: "Method not allowed" }, 405);
}
