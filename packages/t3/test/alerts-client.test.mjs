// node --test test/: the alert job's GitHub client (ci/github.mjs):
// every page is read, rate limits are waited out as GitHub asks, and a creation
// whose answer was lost is looked for before it's repeated, never blindly.
import { test } from "node:test";
import assert from "node:assert/strict";

import { githubClient } from "../ci/github.mjs";
import { BOT, markerOf, reconcileAdvisories } from "../ci/reconcile.mjs";

const bot = { login: BOT, type: "Bot" };

/** A fake GitHub REST server: `routes(method, url, body, n)`, n counting each method and path; an Error is a transport failure. */
function fakeFetch(routes) {
  const counts = new Map();
  return async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const answer = await routes(init.method ?? "GET", u, init.body ? JSON.parse(init.body) : null, counts.get(key));
    if (answer instanceof Error) throw answer;
    const { status = 200, body = null, headers = {} } = answer;
    return new Response(body === null ? null : JSON.stringify(body), { status, headers });
  };
}
const client = (fetch, opts = {}) => githubClient({ token: "t", repo: "o/r", fetch, sleep: async () => {}, ...opts });

test("every page is read, so nothing past 300 issues is missed", async () => {
  const issues = Array.from({ length: 301 }, (_, i) => ({ number: i + 1, title: `[security] p${i} (nightly)`, user: bot, state: "open", body: `<!-- blacksand text -->\nx\n\n${markerOf({ kind: "package", channel: "nightly", package: `p${i}` })}` }));
  let created = 0;
  const gh = client(
    fakeFetch((method, url) => {
      if (method === "GET" && url.pathname.endsWith("/issues")) return { body: issues.slice((url.searchParams.get("page") - 1) * 100, url.searchParams.get("page") * 100) };
      if (method === "GET") return { body: [] };
      if (method === "POST" && url.pathname.endsWith("/issues")) created++;
      return { status: 201, body: {} };
    }),
  );
  assert.equal((await gh.openIssues()).length, 301);
  const open = issues.map((_, i) => ({ id: "GHSA-2222-3333-4444", aliases: [], summary: "s", severity: "HIGH", packages: [{ pkg: `p${i}@1.0.0`, fixed: [] }] }));
  await reconcileAdvisories({ channel: "nightly", release: "v1", gaps: [], open }, gh, { log: () => {} });
  assert.equal(created, 0);
});

test("rate limits are waited out as GitHub asks (Retry-After seconds or date, the reset time), within bounds; other errors aren't retried", async () => {
  const waits = [];
  let calls = 0;
  const limited = fakeFetch(() => {
    calls++;
    if (calls === 1) return { status: 429, headers: { "retry-after": "7" }, body: { message: "slow down" } };
    if (calls === 2) return { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000" }, body: { message: "API rate limit exceeded" } };
    return { status: 201, body: { id: 1 } };
  });
  await client(limited, { sleep: async (ms) => waits.push(ms), now: () => 995_000 }).comment(1, "hi");
  assert.deepEqual(waits, [7000, 5000]);
  const now = Date.parse("Fri, 30 Oct 2026 20:00:00 GMT");
  const dated = [];
  let n = 0;
  await client(fakeFetch(() => (++n === 1 ? { status: 429, headers: { "retry-after": "Fri, 30 Oct 2026 20:02:00 GMT" } } : { status: 201, body: {} })), { sleep: async (ms) => dated.push(ms), now: () => now }).comment(1, "x");
  assert.deepEqual(dated, [120_000]);
  await assert.rejects(client(fakeFetch(() => ({ status: 429, headers: { "retry-after": "Fri, 30 Oct 2026 21:00:00 GMT" } })), { now: () => now }).comment(1, "x"), /rate limited for 3600s/);
  await assert.rejects(client(fakeFetch(() => ({ status: 404, body: { message: "Not Found" } })), { sleep: async () => assert.fail("no retry") }).comment(1, "hi"), /answered 404/);
  await client(fakeFetch(() => ({ status: 422, body: { message: "already_exists" } }))).ensureLabel("security", "B60205", "x");
});

test("a comment or issue whose answer was lost is looked for before it's posted again; one with no way to check isn't repeated", async () => {
  for (const failure of [() => new TypeError("fetch failed: socket hang up"), () => ({ status: 502, body: { message: "Bad Gateway" } })]) {
    const comments = [];
    const gh = client(
      fakeFetch((method, url, body, n) => {
        if (method === "GET") return { body: comments };
        comments.push({ user: bot, body: body.body });
        return n === 1 ? failure() : { status: 201, body: {} };
      }),
    );
    const marker = markerOf({ kind: "notify", seen: "" });
    await gh.comment(7, `hello\n\n${marker}`, { landed: async () => (await gh.comments(7)).find((c) => c.body.endsWith(marker)) ?? null });
    assert.equal(comments.length, 1, "posted once");
  }
  const issues = [];
  const gh = client(
    fakeFetch((method, url, body, n) => {
      if (method === "GET" && url.pathname.endsWith("/issues")) return { body: issues };
      if (method === "GET") return { body: [] };
      if (method === "POST" && url.pathname.endsWith("/issues")) {
        issues.push({ number: 10 + issues.length, title: body.title, body: body.body, state: "open", user: bot });
        return n === 1 ? { status: 500, body: { message: "Server Error" } } : { status: 201, body: issues.at(-1) };
      }
      return { status: 201, body: {} };
    }),
  );
  await reconcileAdvisories({ channel: "nightly", release: "v1", gaps: [], open: [{ id: "GHSA-2222-3333-4444", aliases: [], summary: "s", severity: "HIGH", packages: [{ pkg: "a@1.0.0", fixed: [] }] }] }, gh, { log: () => {} });
  assert.equal(issues.length, 1);
  const blind = client(fakeFetch(() => ({ status: 502, body: {} })), { sleep: async () => assert.fail("no retry") });
  await assert.rejects(blind.comment(1, "x"), /not retried, since it may have gone through/);
  await assert.rejects(blind.createIssue({ title: "t", body: "b" }), /not retried/);
  // A rate-limited creation wasn't served: retried without looking. Updates are idempotent: retried.
  let posts = 0;
  await client(fakeFetch((method) => (method === "POST" && ++posts === 1 ? { status: 429, headers: { "retry-after": "1" } } : { status: 201, body: {} }))).comment(1, "x");
  assert.equal(posts, 2);
  let patches = 0;
  await client(fakeFetch((method) => (method === "PATCH" && ++patches === 1 ? { status: 503 } : { status: 200, body: {} }))).updateIssue(1, { state: "closed" });
  assert.equal(patches, 2);
});
