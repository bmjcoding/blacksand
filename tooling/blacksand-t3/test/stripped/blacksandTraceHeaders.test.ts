// Copied to apps/server/src/ in a stripped upstream checkout and run there
// (rule server/no-trace-headers, with provider/claude-native-updates-minimum-age's lookup).
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { makeProviderMaintenanceCapabilities, resolveLatestProviderVersion } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import { blacksandWithoutTraceHeaders } from "./binCli.ts";

type Sent = { readonly url: string; readonly headers: ReadonlyArray<string> };

/**
 * Runs `effect` inside a parent span with server.ts's shared client (FetchHttpClient.layer)
 * and returns every request it sent, with the names of the headers each carried.
 * `untraced` wraps the whole run in blacksandWithoutTraceHeaders, as runCli does.
 */
const sendAll = <A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient>, untraced: boolean, body = (_url: string) => "{}") =>
  Effect.gen(function* () {
    const sent: Array<Sent> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      sent.push({ url: request.url, headers: [...request.headers.keys()] });
      return new Response(body(request.url), { status: 200 });
    };
    const run = effect.pipe(
      Effect.withSpan("parent"),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    const result = yield* (untraced ? run.pipe(blacksandWithoutTraceHeaders) : run);
    return { result, sent };
  });

const get = (url: string) => Effect.flatMap(HttpClient.HttpClient, (client) => client.get(url));
const TRACE = ["b3", "traceparent", "tracestate"];
const traceHeaders = (sent: ReadonlyArray<Sent>) => sent.flatMap((request) => request.headers.filter((name) => TRACE.includes(name)));

describe("blacksand: no trace headers on outgoing requests", () => {
  it.effect("a request through the server's client carries none, where Effect's default sends b3 and traceparent", () =>
    Effect.gen(function* () {
      const url = "https://registry.npmjs.org/%40openai%2Fcodex";
      const stock = yield* sendAll(get(url), false);
      expect(traceHeaders(stock.sent)).toEqual(expect.arrayContaining(["b3", "traceparent"]));
      const untraced = yield* sendAll(get(url), true);
      expect(untraced.sent.map((request) => request.url)).toEqual([url]);
      expect(traceHeaders(untraced.sent)).toEqual([]);
    }),
  );

  it.effect("so does a client built on its own, one run from a captured context, and one in a detached fiber", () =>
    Effect.gen(function* () {
      const all = Effect.gen(function* () {
        // npmRelease.ts and CodexChatGptHandoff.ts provide their own FetchHttpClient.layer.
        yield* get("https://own.example/").pipe(Effect.provide(FetchHttpClient.layer));
        // Services that capture their context and run effects later (runForkWith, runPromiseWith).
        const runPromise = Effect.runPromiseWith(yield* Effect.context<HttpClient.HttpClient>());
        yield* Effect.promise(() => runPromise(get("https://captured.example/")));
        yield* Fiber.join(yield* Effect.forkDetach(get("https://detached.example/")));
      });
      expect(traceHeaders((yield* sendAll(all, false)).sent)).not.toEqual([]);
      const untraced = yield* sendAll(all, true);
      expect(untraced.sent.map((request) => request.url)).toEqual(["https://own.example/", "https://captured.example/", "https://detached.example/"]);
      expect(traceHeaders(untraced.sent)).toEqual([]);
    }),
  );

  it.effect("the native Claude Code lookup asks its channel, then npm, with no trace, cookie or authorization headers", () =>
    Effect.gen(function* () {
      const now = Date.now();
      const npmDocument = {
        "dist-tags": { latest: "2.1.318" },
        versions: { "2.1.309": {}, "2.1.311": {}, "2.1.316": {}, "2.1.318": {} },
        time: Object.fromEntries(
          [["2.1.309", 12], ["2.1.311", 1], ["2.1.316", 4], ["2.1.318", 1]].map(([v, days]) => [v, new Date(now - Number(days) * 86_400_000).toISOString()]),
        ),
      };
      const lookup = Effect.gen(function* () {
        // ClaudeMaintenance.ts's lookup: the server's client, asked for the channel's version.
        const client = yield* HttpClient.HttpClient;
        const channel = client.get("https://downloads.claude.ai/claude-code-releases/stable").pipe(
          Effect.flatMap((response) => response.text),
          Effect.map((text) => text.trim()),
          Effect.orElseSucceed(() => null),
        );
        const native = makeProviderMaintenanceCapabilities({
          provider: ProviderDriverKind.make("claudeAgent"),
          packageName: "@anthropic-ai/claude-code",
          updateExecutable: "/Users/me/.local/bin/claude",
          updateArgs: ["update"],
          updateLockKey: "claudeAgent-native",
          latestVersion: null,
          lookupLatestVersion: channel,
        });
        return yield* resolveLatestProviderVersion(native).pipe(Effect.provide(ProviderLatestVersions.layer));
      });
      const body = (url: string) => (url.startsWith("https://downloads.claude.ai/") ? "2.1.318\n" : JSON.stringify(npmDocument));
      const { result, sent } = yield* sendAll(lookup, true, body);
      expect(result).toBe("2.1.316");
      expect(sent.map((request) => request.url)).toEqual([
        "https://downloads.claude.ai/claude-code-releases/stable",
        "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code",
      ]);
      for (const request of sent) {
        expect(request.headers.filter((name) => [...TRACE, "cookie", "authorization"].includes(name))).toEqual([]);
      }
    }),
  );
});
