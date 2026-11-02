# Documentation

Each component keeps its guides beside its code. Start with the component's README,
which links to the rest.

## Security

- The [threat model](security/threat-model.md) says what Blacksand protects, from whom,
  and what it doesn't protect against.

## Tools

- [blacksand-t3](../tooling/blacksand-t3/README.md) builds T3 Code from upstream source, with
  its telemetry and other calls home removed. Its guides are in
  [`tooling/blacksand-t3/docs/`](../tooling/blacksand-t3/docs/README.md).

## Environments

- [Kubernetes](../substrates/kubernetes/README.md) runs a coding agent on one task in a
  new sandbox, then tears the sandbox down.

## The repository

- [SECURITY.md](../SECURITY.md) says how to report a vulnerability.
- [CONTRIBUTING.md](../CONTRIBUTING.md) says how to propose a change.
