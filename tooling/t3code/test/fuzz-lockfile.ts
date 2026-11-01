// Properties of the YAML reader and the pnpm lockfile graph (lib/yaml.mjs,
// lib/lockfile.mjs), on generated inputs. What reads a lockfile decides what
// gets checked: a dependency it skipped is a package nobody checked, so the
// properties are that every reference resolves or the file is refused, the
// graph walk sees exactly what a reference walk sees (cycles included), and a
// workspace link never leads out of the checkout.

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import fc from "fast-check";

import { check, type Tier } from "../../../scripts/fuzz.ts";
import { parseLockfile, reachablePackages, withoutPeers } from "../lib/lockfile.mjs";
import { YamlError, parseYaml } from "../lib/yaml.mjs";

// ------------------------------------------------------------ the YAML --

/** Text made of YAML's structural pieces, so generated documents reach the reader's branches, not just its first error. */
const yamlish = fc
  .array(fc.constantFrom("a", "b:", " ", "  ", "\n", "- ", "'", "''", '"', "\\", "\\u00e9", "#", "{", "}", "[", "]", ",", ":", "? ", "---", "...", "|", ">", "&x", "*x", "!t", "\t", "\r", "1", "-1.5e3", "~", "null", "é", "﻿"), { maxLength: 60 })
  .map((parts) => parts.join(""));

/** A scalar written as pnpm and people do: plain when it's safe, else single- or double-quoted. */
const quote = (text: string, style: "single" | "double") => (style === "double" ? JSON.stringify(text) : `'${text.replace(/'/g, "''")}'`);

type Tree = string | string[] | Array<[string, Tree]>;

const keyText = fc.string({ maxLength: 8, unit: "binary" }).filter((s) => !/[\r\n\u2028\u2029\u0085]/.test(s));
const scalarText = fc.string({ maxLength: 12, unit: "binary" });
const tree: fc.Arbitrary<Tree> = fc.letrec<{ node: Tree }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    scalarText,
    fc.array(scalarText, { minLength: 1, maxLength: 3 }),
    fc.uniqueArray(fc.tuple(keyText, tie("node")), { minLength: 1, maxLength: 4, selector: ([key]) => key }),
  ),
})).node;

/** `tree` as block YAML, every scalar quoted in `style` (single-quoted scalars can't hold a line break, so those go double-quoted). */
function emit(node: Tree, indent: number, style: "single" | "double"): string[] {
  const pad = " ".repeat(indent);
  const q = (s: string) => quote(s, /[\r\n\u2028\u2029\u0085]/.test(s) ? "double" : style);
  if (typeof node === "string") return [`${pad}${q(node)}`];
  if (node.every((item) => typeof item === "string")) return (node as string[]).map((item) => `${pad}- ${q(item)}`);
  return (node as Array<[string, Tree]>).flatMap(([key, value]) => (typeof value === "string" ? [`${pad}${q(key)}: ${q(value)}`] : [`${pad}${q(key)}:`, ...emit(value, indent + 2, style)]));
}

/** What `tree` means as plain values (keys as own properties, `__proto__` included). */
function meaning(node: Tree): unknown {
  if (typeof node === "string") return node;
  if (node.every((item) => typeof item === "string")) return node;
  const out = {};
  for (const [key, value] of node as Array<[string, Tree]>) Object.defineProperty(out, key, { value: meaning(value), enumerable: true, writable: true, configurable: true });
  return out;
}

// -------------------------------------------------------- the lockfile --

const NAMES = ["a", "b", "@s/c", "d-e", "f.g"];
const VERSIONS = ["1.0.0", "2.1.3", "0.0.1-rc.1"];

interface Model {
  /** name@version -> its snapshot keys (with or without a peer suffix) -> { dependency name -> snapshot key }. */
  packages: Map<string, Map<string, Map<string, string>>>;
  /** importer path -> { dependency name -> snapshot key } */
  importers: Map<string, Map<string, string>>;
  links: Array<{ importer: string; name: string; to: string }>;
}

/** A lockfile model: packages, peer-suffixed snapshots, edges between any of them (cycles and self-references included), importers and aliases. */
const model: fc.Arbitrary<Model> = fc
  .record({
    pkgs: fc.uniqueArray(fc.tuple(fc.constantFrom(...NAMES), fc.constantFrom(...VERSIONS)), { minLength: 1, maxLength: 6, selector: ([n, v]) => `${n}@${v}` }),
    peers: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
    edges: fc.array(fc.tuple(fc.nat(11), fc.nat(11), fc.boolean()), { maxLength: 16 }),
    roots: fc.array(fc.tuple(fc.nat(2), fc.nat(11), fc.boolean()), { minLength: 1, maxLength: 6 }),
  })
  .map(({ pkgs, peers, edges, roots }) => {
    const packages = new Map<string, Map<string, Map<string, string>>>();
    const snapshots: Array<{ name: string; key: string }> = [];
    for (const [i, [name, version]] of pkgs.entries()) {
      const keys = new Map<string, Map<string, string>>();
      keys.set(`${name}@${version}`, new Map());
      snapshots.push({ name, key: `${name}@${version}` });
      if (peers[i]) {
        const peered = `${name}@${version}(${pkgs[0]?.[0]}@${pkgs[0]?.[1]})`;
        keys.set(peered, new Map());
        snapshots.push({ name, key: peered });
      }
      packages.set(`${name}@${version}`, keys);
    }
    const snapshot = (i: number) => snapshots[i % snapshots.length] as { name: string; key: string };
    const edgesOf = (key: string) => packages.get(withoutPeers(key))?.get(key) as Map<string, string>;
    for (const [from, to, alias] of edges) {
      const target = snapshot(to);
      edgesOf(snapshot(from).key).set(alias ? `alias-${to}` : target.name, target.key);
    }
    const importers = new Map<string, Map<string, string>>();
    for (const [where, to, alias] of roots) {
      const target = snapshot(to);
      const importer = [".", "packages/x", "apps/y"][where] as string;
      if (!importers.has(importer)) importers.set(importer, new Map());
      importers.get(importer)?.set(alias ? `alias-${to}` : target.name, target.key);
    }
    return { packages, importers, links: [] };
  });

/** A reference as pnpm writes it: the version (and peers) for a same-named dependency, the whole key for an alias. */
const ref = (name: string, key: string) => (key.startsWith(`${name}@`) ? key.slice(name.length + 1) : key);

function lockfileText(m: Model, { drop = null as string | null, unlist = null as string | null } = {}): string {
  const lines = ["lockfileVersion: '9.0'", "importers:"];
  for (const where of new Set([...m.importers.keys(), ...m.links.map((l) => l.importer)])) {
    lines.push(`  '${where}':`, "    dependencies:");
    for (const [name, key] of m.importers.get(where) ?? []) lines.push(`      '${name}':`, `        specifier: '*'`, `        version: '${ref(name, key)}'`);
    for (const { name, to } of m.links.filter((l) => l.importer === where)) lines.push(`      '${name}':`, "        specifier: 'workspace:*'", `        version: ${quote(`link:${to}`, "double")}`);
  }
  lines.push("packages:");
  for (const pkg of m.packages.keys()) if (pkg !== unlist) lines.push(`  '${pkg}':`, `    resolution: {integrity: sha512-${pkg.length}}`);
  lines.push("snapshots:");
  for (const keys of m.packages.values()) {
    for (const [key, deps] of keys) {
      if (key === drop) continue;
      lines.push(`  '${key}':${deps.size ? "" : " {}"}`);
      if (deps.size) lines.push("    dependencies:", ...[...deps].map(([name, target]) => `      '${name}': '${ref(name, target)}'`));
    }
  }
  return `${lines.join("\n")}\n`;
}

/** What a plain graph walk reaches from the importers, not entering a cut package. */
function reference(m: Model, cut: Set<string>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue = [...m.importers.values()].flatMap((deps) => [...deps.values()]);
  while (queue.length) {
    const key = queue.shift() as string;
    if (seen.has(key)) continue;
    seen.add(key);
    const pkg = withoutPeers(key);
    if (cut.has(pkg)) continue;
    out.add(pkg);
    queue.push(...(m.packages.get(pkg)?.get(key)?.values() ?? []));
  }
  return out;
}

const referenced = (m: Model) => [...m.importers.values(), ...[...m.packages.values()].flatMap((keys) => [...keys.values()])].flatMap((deps) => [...deps.values()]);

export function define(tier: Tier) {
  test("YAML: any text is read or refused with a YamlError, never another exception", (t) =>
    check(
      t,
      tier,
      fc.property(yamlish, fc.boolean(), (text, blockScalars) => {
        try {
          parseYaml(text, { blockScalars });
        } catch (error) {
          if (!(error instanceof YamlError)) throw error;
        }
      }),
      { fast: 1500, deep: 200_000 },
    ));

  test("YAML: nested mappings and lists of quoted scalars read back as what was written, any characters, odd keys included", (t) =>
    check(
      t,
      tier,
      fc.property(tree, fc.constantFrom("single", "double") as fc.Arbitrary<"single" | "double">, (node, style) => {
        const text = `${emit(typeof node === "string" ? [["k", node]] : node, 0, style).join("\n")}\n`;
        assert.deepEqual(parseYaml(text), [meaning(typeof node === "string" ? [["k", node]] : node)]);
      }),
      { fast: 300, deep: 30_000 },
    ));

  test("lockfile: every edge pnpm wrote resolves, and the graph walk reaches what a reference walk reaches, cycles and cuts included", (t) =>
    check(
      t,
      tier,
      fc.property(model, fc.uniqueArray(fc.nat(5)), (m, cutIndexes) => {
        const lock = parseLockfile(lockfileText(m));
        assert.deepEqual([...lock.packages].sort(), [...m.packages.keys()].sort());
        for (const keys of m.packages.values()) for (const [key, deps] of keys) assert.deepEqual(new Set(lock.deps.get(key)), new Set(deps.values()), key);
        const cut = new Set(cutIndexes.map((i) => [...m.packages.keys()][i]).filter((p): p is string => p !== undefined));
        // lockfile.mjs defaults `cut` to `() => false`, which types it as taking nothing.
        const stop: (pkg: string) => boolean = (pkg) => cut.has(pkg);
        assert.deepEqual(reachablePackages(lock, stop as () => boolean), reference(m, cut));
      }),
      { fast: 300, deep: 30_000 },
    ));

  test("lockfile: a reference to a snapshot or package the file lacks is refused, never skipped", (t) =>
    check(
      t,
      tier,
      fc.property(model, fc.nat(), fc.boolean(), (m, pick, unlist) => {
        const refs = referenced(m);
        const missing = refs[pick % refs.length] as string;
        // A snapshot only it refers to (a self-reference) leaves nothing referring to it once dropped.
        const others = [...m.importers.values(), ...[...m.packages.values()].flatMap((keys) => [...keys].filter(([key]) => key !== missing).map(([, deps]) => deps))];
        fc.pre(unlist || others.some((deps) => [...deps.values()].includes(missing)));
        const text = unlist ? lockfileText(m, { unlist: withoutPeers(missing) }) : lockfileText(m, { drop: missing });
        assert.throws(() => parseLockfile(text), /refers to .*(?:no snapshot of|packages don't list)/);
      }),
      { fast: 300, deep: 30_000 },
    ));

  test("lockfile: a workspace link the reader accepts names a folder inside the checkout, never out of it or into node_modules", (t) =>
    check(
      t,
      tier,
      fc.property(
        fc.constantFrom(".", "packages/x", "apps/y/z"),
        fc.array(fc.constantFrom("..", ".", "a", "node_modules", "b.c", "", "@s", "x\\y"), { minLength: 1, maxLength: 5 }),
        fc.boolean(),
        (importer, parts, absolute) => {
          const to = `${absolute ? "/" : ""}${parts.join("/")}`;
          const m: Model = { packages: new Map([["a@1.0.0", new Map([["a@1.0.0", new Map()]])]]), importers: new Map([[".", new Map([["a", "a@1.0.0"]])]]), links: [{ importer, name: "local", to }] };
          let lock;
          try {
            lock = parseLockfile(lockfileText(m));
          } catch (error) {
            assert.match(String(error), /outside upstream's tree/);
            return;
          }
          const [link] = lock.links;
          const target = path.posix.normalize(path.posix.join(importer, to)).replace(/\/$/, "");
          assert.equal(link?.target, target);
          assert.ok(!path.posix.isAbsolute(target) && target !== ".." && !target.startsWith("../"), target);
          assert.ok(!target.split("/").includes("node_modules") && !to.includes("\\"), target);
        },
      ),
      { fast: 500, deep: 50_000 },
    ));
}
