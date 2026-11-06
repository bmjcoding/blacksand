// Copied to packages/provider-core/src/server/ in a stripped upstream checkout and run there
// (rules provider/release-age-file, provider/grok-native-updates): for a channel that names
// one version and no date, such as native Grok's, the version offered is the newest one this
// server first saw there at least 3 days ago, no newer than the version it names now. The
// record of when each version was first seen outlasts restarts; anything wrong with it only
// makes the wait longer.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import { firstSeenChannelVersion, settledSinceFirstSeen } from "./blacksandReleaseAge.ts";

const DAY = 86_400_000;
const CHANNEL = "https://x.ai/cli/stable";

/** A fresh record file, and the first-seen check against it with the channel naming `version`. */
const recordIn = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = `${yield* fs.makeTempDirectoryScoped({ prefix: "t3b-first-seen-" })}/first-seen.json`;
  const settled = (version: string) => settledSinceFirstSeen({ file, channel: CHANNEL, version });
  const record = () => fs.readFileString(file).pipe(Effect.map((text) => JSON.parse(text) as Record<string, Record<string, number>>));
  return { fs, file, settled, record };
});

it.layer(NodeServices.layer)("blacksand: versions first seen on a vendor's channel", (it) => {
  it.effect("offers a version once this server has seen it on the channel for 3 days, and not a moment before", () =>
    Effect.gen(function* () {
      const { settled, record } = yield* recordIn;
      yield* TestClock.setTime(100 * DAY);
      expect(yield* settled("1.0.8")).toBeNull();
      expect(yield* record()).toEqual({ [CHANNEL]: { "1.0.8": 100 * DAY } });
      yield* TestClock.adjust(3 * DAY - 1);
      expect(yield* settled("1.0.8")).toBeNull();
      yield* TestClock.adjust(1);
      expect(yield* settled("1.0.8")).toBe("1.0.8");
    }).pipe(Effect.scoped),
  );

  it.effect("a channel that moves on daily still has a version 3 days old to offer: the newest one", () =>
    Effect.gen(function* () {
      const { settled, record } = yield* recordIn;
      yield* TestClock.setTime(100 * DAY);
      for (const version of ["1.0.1", "1.0.2", "1.0.3"]) {
        expect(yield* settled(version)).toBeNull();
        yield* TestClock.adjust(DAY);
      }
      expect(yield* settled("1.0.4")).toBe("1.0.1");
      yield* TestClock.adjust(DAY);
      // 1.0.1 and 1.0.2 were seen 4 and 3 days ago; 1.0.5 has just come out.
      expect(yield* settled("1.0.5")).toBe("1.0.2");
      // What's offered and what may still settle are kept; older settled versions go.
      expect(Object.keys((yield* record())[CHANNEL]!).sort()).toEqual(["1.0.2", "1.0.3", "1.0.4", "1.0.5"]);
      yield* TestClock.adjust(DAY);
      expect(yield* settled("1.0.6")).toBe("1.0.3");
    }).pipe(Effect.scoped),
  );

  it.effect("offers nothing newer than the channel names now: one that moved back has pulled it, and its wait starts over", () =>
    Effect.gen(function* () {
      const { settled } = yield* recordIn;
      yield* TestClock.setTime(100 * DAY);
      expect(yield* settled("1.0.9")).toBeNull();
      yield* TestClock.adjust(4 * DAY);
      expect(yield* settled("1.0.8")).toBeNull();
      // Named again, it waits 3 days from now.
      expect(yield* settled("1.0.9")).toBeNull();
      yield* TestClock.adjust(3 * DAY);
      expect(yield* settled("1.0.9")).toBe("1.0.9");
    }).pipe(Effect.scoped),
  );

  it.effect("a version pulled before it settled is forgotten: named again, it waits 3 days from then", () =>
    Effect.gen(function* () {
      const { settled, record } = yield* recordIn;
      yield* TestClock.setTime(100 * DAY);
      expect(yield* settled("1.0.9")).toBeNull();
      yield* TestClock.adjust(DAY);
      expect(yield* settled("1.0.8")).toBeNull();
      expect(Object.keys((yield* record())[CHANNEL]!)).toEqual(["1.0.8"]);
      yield* TestClock.adjust(2 * DAY);
      expect(yield* settled("1.0.9")).toBeNull();
      yield* TestClock.adjust(3 * DAY);
      expect(yield* settled("1.0.9")).toBe("1.0.9");
    }).pipe(Effect.scoped),
  );

  it.effect("checks that overlap keep both observations, and leave no file of their own behind", () =>
    Effect.gen(function* () {
      const { fs, file, record } = yield* recordIn;
      yield* TestClock.setTime(100 * DAY);
      const channels = Array.from({ length: 8 }, (_, i) => `https://x.ai/cli/c${i}`);
      yield* Effect.forEach(channels, (channel) => settledSinceFirstSeen({ file, channel, version: "1.0.8" }), {
        concurrency: "unbounded",
      });
      expect(Object.keys(yield* record()).sort()).toEqual([...channels].sort());
      const dir = file.slice(0, file.lastIndexOf("/"));
      expect(yield* fs.readDirectory(dir)).toEqual(["first-seen.json"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a record it can't read starts every wait over; an entry dated ahead of the clock, that one's", () =>
    Effect.gen(function* () {
      const { fs, file, settled } = yield* recordIn;
      yield* TestClock.setTime(100 * DAY);
      for (const text of ["{not json", JSON.stringify({ [CHANNEL]: { "1.0.8": "0" } }), JSON.stringify({ [CHANNEL]: [1] })]) {
        yield* fs.writeFileString(file, text);
        expect(yield* settled("1.0.8")).toBeNull();
      }
      yield* fs.writeFileString(file, JSON.stringify({ [CHANNEL]: { "1.0.8": 200 * DAY, "1.0.7": 10 * DAY } }));
      expect(yield* settled("1.0.8")).toBe("1.0.7");
      yield* TestClock.adjust(3 * DAY);
      expect(yield* settled("1.0.8")).toBe("1.0.8");
      // Another channel's record isn't this one's.
      yield* fs.writeFileString(file, JSON.stringify({ "https://x.ai/cli/alpha": { "1.0.9": 0 } }));
      expect(yield* settled("1.0.9")).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("a record it can't write keeps every new version back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped({ prefix: "t3b-first-seen-" })}/missing/first-seen.json`;
      yield* TestClock.setTime(100 * DAY);
      expect(yield* settledSinceFirstSeen({ file, channel: CHANNEL, version: "1.0.8" })).toBeNull();
      yield* TestClock.adjust(30 * DAY);
      expect(yield* settledSinceFirstSeen({ file, channel: CHANNEL, version: "1.0.8" })).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("a channel that names anything but a plain x.y.z version, or can't be read, offers nothing and records nothing", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* recordIn;
      yield* TestClock.setTime(100 * DAY);
      yield* fs.writeFileString(file, JSON.stringify({ [CHANNEL]: { "1.0.8": 0 } }));
      const asked: Array<string> = [];
      const answering = (response: () => Response) =>
        HttpClient.make((request) => Effect.sync(() => (asked.push(request.url), HttpClientResponse.fromWeb(request, response()))));
      const at = (client: HttpClient.HttpClient) =>
        firstSeenChannelVersion(CHANNEL, file).pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(yield* at(answering(() => new Response("1.0.8\n")))).toBe("1.0.8");
      for (const body of ["", "latest", "v1.0.9", "1.0.9-alpha.1", "1.0.9 1.1.0", "1.0", `{"version":"1.0.9"}`]) {
        expect(yield* at(answering(() => new Response(body)))).toBeNull();
      }
      expect(yield* at(answering(() => new Response("1.0.9", { status: 503 })))).toBeNull();
      // A channel that never answers: given up on after 4 seconds.
      const waiting = yield* Effect.forkChild(at(HttpClient.make(() => Effect.never)));
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(waiting)).toBeNull();
      expect(asked.every((url) => url === CHANNEL)).toBe(true);
      expect(JSON.parse(yield* fs.readFileString(file))).toEqual({ [CHANNEL]: { "1.0.8": 0 } });
    }).pipe(Effect.scoped),
  );
});
