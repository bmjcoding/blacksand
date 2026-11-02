# Historical trust oracle

`selfupdate.mjs` is the original verifier from commit
`fdc2f01d25a724b449579b87ceb83c849fc7239a`, copied without changing its bytes.
It recognizes only the root layout and the historical evaluator label. It is
test evidence, not an updater to install.

The [differential tests](../../tooling/blacksand-t3/test/trust-port.deep.test.mjs)
retain the historical signer lists and layouts. Their
[loader](../../tooling/blacksand-t3/test/trust-oracle.mjs) checks the snapshot's
SHA-256 and relocates only its dependency imports in memory. New label and layout
behavior is asserted separately against both active verifiers where applicable.
