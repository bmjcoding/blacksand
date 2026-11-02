// The T3 component has lived at the repository root, packages/t3/,
// tooling/t3code/, and now tooling/blacksand-t3/. Each commit is read in its own
// layout; more than one component folder is ambiguous and refused, even if one
// is empty. These fixed paths cannot be supplied by the repository.
// .allowed_signers stays at the root in every layout.
//
// A commit is judged in its first parent's layout (evaluator.ts). Only an
// owner-signed commit can move the component or rename its signer labels.

export type Layout = "root" | "monorepo" | "tooling" | "blacksand";

/** Every layout, oldest first. */
export const LAYOUTS: readonly Layout[] = ["root", "monorepo", "tooling", "blacksand"];

/** The folder whose presence gives a commit each layout but the root one. */
export const PACKAGE_DIRS = { monorepo: "packages/t3", tooling: "tooling/t3code", blacksand: "tooling/blacksand-t3" } as const;

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
export const ambiguous = (label: string) => `${label} has multiple component folders (${NAMED.map(([, dir]) => dir).join(", ")}), so where its pin is can't be told; only one may hold the t3 package`;
