// Where the t3 package's trusted files sit in a commit. The owner has moved the
// package twice: history before the monorepo move has it at the repository root
// (pin.json, lib/overrides.json); after it, under packages/t3/; after the move
// to the current structure, under tooling/t3code/. The cutover crosses all
// three, so each commit is read in its own layout: a commit whose tree has a
// packages/t3 folder is "monorepo", one with a tooling/t3code folder is
// "tooling", and one with neither is "root". A commit with both has no layout:
// where its pin is can't be told, so it's refused (history.ts). The set is
// fixed here; a repository can't name another place for the pin.
// .allowed_signers stays at the root in every layout.
//
// A commit is judged in its first parent's layout (evaluator.ts), so the
// evaluator, which may change only the pin file, can never move it: changing
// anything else is out of its bounds.

export type Layout = "root" | "monorepo" | "tooling";

/** Every layout, oldest first. */
export const LAYOUTS: readonly Layout[] = ["root", "monorepo", "tooling"];

/** The folder whose presence gives a commit each layout but the root one. */
export const PACKAGE_DIRS = { monorepo: "packages/t3", tooling: "tooling/t3code" } as const;

const NAMED = Object.entries(PACKAGE_DIRS) as [Exclude<Layout, "root">, string][];

/** `file` (a path inside the t3 package, such as "lib/overrides.json") as a repository path in `layout`. */
export const packagePath = (layout: Layout, file: string) => (layout === "root" ? file : `${PACKAGE_DIRS[layout]}/${file}`);

/** pin.json's repository path in `layout`. */
export const pinPath = (layout: Layout) => packagePath(layout, "pin.json");

/** The names to ask `git cat-file --batch-check` for, to learn `rev`'s layout. */
export const layoutNames = (rev: string) => NAMED.map(([, dir]) => `${rev}:${dir}`);

/**
 * `rev`'s layout, from `typeOf` (the type `git cat-file --batch-check` gives a
 * name layoutNames lists, or null when it's missing): the layout whose folder is
 * a tree, "root" when none is, and null when more than one is.
 */
export function layoutOf(rev: string, typeOf: (name: string) => string | null): Layout | null {
  const found = NAMED.filter(([, dir]) => typeOf(`${rev}:${dir}`) === "tree");
  if (found.length > 1) return null;
  return found[0]?.[0] ?? "root";
}

/** Why `label` (a commit, as a message names it) has no layout. */
export const ambiguous = (label: string) => `${label} has both ${NAMED.map(([, dir]) => dir).join(" and ")}, so where its pin is can't be told; only one may hold the t3 package`;
