import { getStore } from "@netlify/blobs";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  },
});

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" } });
  const store = getStore("testograf-tests");

  if (request.method === "POST") {
    const rawBody = await request.text();
    if (rawBody.length > 2_000_000) return jsonResponse({ error: "Test payload is too large" }, 413);

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }
    const campaign = payload?.campaign || payload;
    if (!campaign?.id || !campaign?.title || !Array.isArray(campaign?.localQuestions)) {
      return jsonResponse({ error: "Invalid test data" }, 400);
    }

    const id = String(campaign.id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    if (id.length < 6) return jsonResponse({ error: "Invalid test id" }, 400);
    await store.setJSON(id, { campaign, firebaseConfig: payload?.firebaseConfig || null });
    return jsonResponse({ id });
  }

  if (request.method === "GET") {
    const id = new URL(request.url).searchParams.get("id");
    if (!id || !/^[a-zA-Z0-9_-]{6,40}$/.test(id)) return jsonResponse({ error: "Invalid test id" }, 400);
    const campaign = await store.get(id, { type: "json" });
    return campaign ? jsonResponse(campaign) : jsonResponse({ error: "Test not found" }, 404);
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/tests" };
