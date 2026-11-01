// Where the t3 package's trusted files sit in a commit. History before the
// monorepo move has them at the repository root (pin.json, lib/overrides.json);
// after it, under packages/t3/. The cutover crosses both, so each commit is read
// in its own layout: a commit whose tree has a packages/t3 folder is "monorepo",
// any other is "root". .allowed_signers stays at the root in both.
//
// A commit is judged in its first parent's layout (evaluator.ts), so the
// evaluator, which may change only the pin file, can never move it: changing
// anything else is out of its bounds.

export type Layout = "root" | "monorepo";

/** The folder whose presence makes a commit's layout "monorepo". */
export const PACKAGE_DIR = "packages/t3";

/** `file` (a path inside the t3 package, such as "lib/overrides.json") as a repository path in `layout`. */
export const packagePath = (layout: Layout, file: string) => (layout === "monorepo" ? `${PACKAGE_DIR}/${file}` : file);

/** pin.json's repository path in `layout`. */
export const pinPath = (layout: Layout) => packagePath(layout, "pin.json");

/** A layout from the type `git cat-file --batch-check` gives `<commit>:packages/t3` (null when it's missing). */
export const layoutOf = (type: string | null): Layout => (type === "tree" ? "monorepo" : "root");
