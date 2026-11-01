# marked 15.0.12 (tests only)

A CommonMark and GitHub Flavored Markdown parser, used only by the tests
(`test/alerts-markdown.mjs`). They parse what the alert job writes to GitHub
issues and check that text from outside stays inert. CI has no `npm install`, and
nothing outside `test/` imports this file.

- `marked.esm.js`: `package/lib/marked.esm.js` from
  https://registry.npmjs.org/marked/-/marked-15.0.12.tgz, byte for byte. The
  tarball's integrity is `sha512-8dD6FusOQSrpv9Z1rdNMdlSgQOIP880DHqnohobOmYLElGEqAL/JvxvuxZO16r4HtjTlfPRDC1hbvxC9dPN2nA==`,
  as the registry gives it. The file's SHA-256 is
  `29e25cdf1a06075c90e9885af06ddd23fb22a5424ed23a61dda986c73a8af641`, and
  `test/alerts-issues.test.mjs` checks it. The file has no imports and no
  dependencies.
- `LICENSE.md`: the package's license (MIT).

To check the file: download the tarball into an empty directory, compare its sha512
with the integrity above, then compare `package/lib/marked.esm.js` with this file.
