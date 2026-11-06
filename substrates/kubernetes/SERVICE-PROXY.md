# Service proxy

A service principal is separate from an agent run. The operator owns a stable
Kubernetes Service, TLS identity, upstream credentials and audit volume. Clients
hold only a rotating capability to that proxy. There is no Kubernetes API or
credential-management endpoint on its listener. Run cleanup, RunSpec, request
digests, receipts, sandbox networking and agent defaults are unchanged.

`src/service.ts` supervises the **same** `sandbox/proxy.ts` used by runs. It serves
finite epochs over HTTPS. CONNECT is closed in service mode. Models use the existing
`/openai/v1/responses` or `/anthropic/v1/messages` operation/body/model grants.
Intranet routes terminate and re-originate HTTPS: a CONNECT tunnel cannot inject
credentials inside TLS.

## Operator lifecycle

Run these on the trusted operator machine, using a Node version with TypeScript
support and explicit files. No credential is supplied in an argument or environment
variable. The configuration contains public values and file paths only.

```sh
node substrates/kubernetes/src/service.ts prepare /operator/service.json
node substrates/kubernetes/src/service.ts issue /operator/service.json /client/capability.json 600
timeout -s TERM -k 10 930 node substrates/kubernetes/src/service.ts serve /operator/service.json
node substrates/kubernetes/src/service.ts revoke /operator/service.json
node substrates/kubernetes/src/service.ts audit /operator/service.json
```

`prepare` provisions a service-bound audit directory. `issue` publishes a mode-0600
client capability JSON, then atomically publishes its hash/epoch/expiry in the
control file. It generates 256 random bits. An epoch lives at most 900 seconds.
There is one operator writer. Deliver the client file independently; do not mount
upstream credentials or the operator configuration into the client. `issue` and
`revoke` use an increasing epoch; persisted high water refuses older epochs and
changes to an already observed epoch. Revoke publishes a tombstone with no token.

The server checks control every 250 ms. Missing, invalid or rolled-back control
closes admission and the process fails. A changed epoch first seals the old proxy,
closes active and idle sockets, then starts the replacement. There is no overlap;
clients must tolerate a brief unavailable connection and re-read their capability
file on each call. Rotation is not permission to retry an ambiguous effect under
a new idempotency key. Upstream tokens, OIDC client secrets and CA files are read
for each request. Listener certificate/key changes take effect at the next epoch.

`serve_seconds` bounds the supervisor process itself to 1–900 seconds (default
900), including when it is idle or revoked. Packaging also uses an independent
`timeout -s TERM -k 10 930` watchdog (TERM at 930 seconds, KILL ten seconds later),
so a stalled event loop cannot keep the process alive. The pinned Alpine Node
image supplies this utility; a custom pinned image must supply the same interface.
A Kubernetes Deployment restarts it.
A still-valid capability may resume after restart; it never gets an extended
expiry. Budgets are per proxy instance/segment, with a finite segment count and
capability lifetime bounding restart totals. Revocation reaches the server after
its control volume is updated; projected-volume propagation is additional to the
250 ms process bound. The operator must deliver control updates within its own
revocation deadline, or terminate the Pod. There is no instant issuer revocation
claim and no expert-bound delegation.

Every audit line is synchronously written and fsynced before an accepted operation
is forwarded. Each instance has a finite numbered JSONL segment, a service/epoch,
a public-configuration digest and the previous segment's SHA-256. Existing
`readAudit` validates each segment's accept/end pairs and closing count. The sink
keeps no growing in-memory audit log. Sink failure closes admission and
sockets; a crash or failed sink leaves an explicitly incomplete segment. Audit
byte exhaustion seals the instance and reports incomplete evidence. A durable allocation counter detects a missing tail segment; an interrupted
allocation remains incomplete. Atomic publication uses bounded fixed temporary
files rather than accumulating crash leftovers. No stdout
retention, automatic deletion or overwrite substitutes for durable storage.
`max_segments` is a hard disk/admission ceiling (1–1024); restart cannot evade it.
The admin exports/retains a stopped audit directory before provisioning a new one.
Do not delete individual segments or epoch state. The audit command reports gaps,
bad linkage, missing seals and unfinished work; exit 1 means incomplete evidence.
The hashes detect ordering/accidental damage; they do not resist an operator who
can rewrite the volume. One Recreate deployment/process owns an audit directory.

## Client and upstream contract

The client capability is exactly:

```json
{"schema":"run.blacksand.service-capability/1","service":"eevie","epoch":1,"expires_at":1900000000000,"token":"<operator-delivered proxy-only capability>"}
```

The client checks the schema, configured service and expiry, then sends
`Authorization: Bearer <token>` to the configured HTTPS proxy origin, verifying
its configured CA and hostname. Use the configured Host authority including a
non-default port. The proxy accepts no caller-selected upstream origin, port,
client identity or upstream credential. It does not provide a direct fallback.

* Plugin: `POST https://<proxy>:8443/intranet/plugin/v1/describe` (or another
  exact configured operation), JSON fields from that operation's closed table.
  Keep actor and idempotency key in the declared JSON binding.
* Source: an exact configured JSON operation such as
  `POST /intranet/source/v1/export`. The proxy constrains repository and branch
  values; the receiver independently enforces the credential's repository/branch
  grant. No caller filesystem path or arbitrary repository URL is admitted.
* RP exchange: `POST /intranet/idp/token` with exactly
  `{"code":"<authorization code>","code_verifier":"<43–128 unreserved characters>"}`.
  The upstream token path, client id, HTTPS redirect URI, authorization-code
  grant and `client_secret_basic` authentication come from trusted config. Only
  `{"id_token":"..."}` is returned on success. Access/refresh tokens, upstream
  error descriptions and cookies are never returned by this operation. The RP
  still validates issuer, signature, audience, nonce and signing intent.
* Public discovery/JWKS can be separate exact GET/HEAD operations using
  `auth.kind: "public"`; the proxy hop still needs its capability. Discovery
  content cannot authorize a new destination.
* Models use their existing paths, explicit model ids and local tools only.
  The proxy does not grant provider-host CONNECT as a side effect.

Intranet bodies and JSON responses are bounded and buffered before forwarding or
returning. HEAD accepts a bodyless reply and checks its selected headers. No query
strings, wildcard operations or streaming intranet responses
are admitted. Only content-type and conditional-write headers are forwarded.
Client Cookie, proxy/forwarded identity headers and client credentials are dropped;
the proxy supplies Host and upstream Authorization. Redirects, compressed/non-UTF-8,
malformed JSON, oversized responses, and reflected credential bytes (including
JSON escapes and ordinary form encodings) fail closed. Only selected response
headers survive, after reflection checking. Model streaming keeps its existing
interface with a bounded credential guard that recognizes ordinary JSON escapes
across writes and equivalent hex case in percent encodings. Compressed content or
transfer codings fail closed; literal credential text remains case-sensitive.
Returned-model audit metadata is sampled only from bytes that
passed this guard. An upstream deliberately hiding a
credential through an arbitrary encoding is outside this routine-upstream-error
boundary; the upstream already possesses that credential.

Bearer files contain short-lived single-audience JWTs. The proxy's decoded-claim
checks cover configured issuer, audience, subject, scope, nbf and finite expiry;
**these are routing guards, not JWT authentication**. Plugin/source receivers
must independently verify an approved signature algorithm/key, issuer, audience,
expiry, scopes and service identity before authorizing actor/case/repository/ref.
The current actor boundary is service-asserted: it does not prove that an expert
delegated a token. No RFC 8693 broker, token minting service or browser RP is added.

## Configuration and packaging

The following is public example configuration; paths refer to operator-managed
mounts. URL spellings are canonical HTTPS URLs with a trailing slash for origins.
Explicit `private: true` permits private addresses for that exact entry only.
DNS is resolved once, all answers are checked, and the selected numeric address
is dialed while TLS verifies the configured hostname and CA. An IP literal has
the same public/private check. Redirects are never followed.

```json
{
  "schema": "run.blacksand.service-proxy/1",
  "service": "eevie",
  "listen": {
    "host": "::", "port": 8443, "authority": "eevie-proxy.blacksand-services.svc.cluster.local:8443",
    "cert_file": "/credentials/tls/cert", "key_file": "/credentials/tls/key"
  },
  "control_file": "/control/epoch.json",
  "audit_dir": "/audit", "max_segments": 128, "serve_seconds": 900,
  "limits": { "request_seconds": 120, "request_bytes": 1048576, "response_bytes": 1048576, "audit_bytes": 1048576 },
  "models": [],
  "endpoints": [
    {
      "name": "plugin", "url": "https://plugin.example.internal:8444/", "private": true,
      "ca_file": "/credentials/upstream/ca.pem",
      "auth": { "kind": "bearer", "token_file": "/credentials/upstream/plugin-token", "audience": "urn:example:plugin", "issuer": "https://identity.example.internal/", "subject": "eevie", "scopes": ["plugin.call"] },
      "operations": [{ "id": "describe", "method": "POST", "path": "/v1/describe", "body": { "fields": ["actor"], "required": ["actor"], "values": {}, "prefixes": {} } }]
    },
    {
      "name": "source", "url": "https://source.example.internal:8444/", "private": true,
      "ca_file": "/credentials/upstream/ca.pem",
      "auth": { "kind": "bearer", "token_file": "/credentials/upstream/source-token", "audience": "urn:example:source", "issuer": "https://identity.example.internal/", "subject": "eevie", "scopes": ["source.write"] },
      "operations": [{ "id": "export", "method": "POST", "path": "/v1/export", "body": { "fields": ["repository", "branch", "tree", "key"], "required": ["repository", "branch", "tree", "key"], "values": { "repository": ["configured/repository"] }, "prefixes": { "branch": "eitl/" } } }]
    },
    {
      "name": "idp", "url": "https://identity.example.internal/", "private": true,
      "ca_file": "/credentials/upstream/ca.pem",
      "auth": { "kind": "oidc", "client_id": "eevie", "client_secret_file": "/credentials/upstream/rp-client-secret", "redirect_uri": "https://eevie.example.internal/callback" },
      "operations": [{ "id": "authorization-code", "method": "POST", "path": "/token" }]
    }
  ]
}
```

A configured model entry is
`{"name":"openai","url":"https://model.example.internal/","private":true,"ca_file":"/credentials/upstream/ca.pem","secret_file":"/credentials/upstream/model-key","models":["<explicit model id>"]}`;
`anthropic` uses the same entry shape. No model entry grants anything by default.
Secret files are bounded printable ASCII, with an optional trailing newline.

`serviceObjects` in `src/service-manifests.ts` renders a separate restricted
namespace, unprivileged ServiceAccount (no RBAC or token automount), single-replica
Recreate Deployment, stable Service, code/config ConfigMap and NetworkPolicy.
It initializes the service-bound audit marker on an existing PVC; the PVC, control
ConfigMap and Secrets are admin provisioned. Code is the five named proxy/service
modules from this source tree. The sole client ingress peer contains **both** its
configured namespace selector and Pod labels. Egress is exact /32 or /128 resolved
upstream addresses/ports plus a combined namespace/Pod resolver peer. There is no
sandbox floor RuntimeClass, run label, run deadline or cleanup selector. No key,
Secret value, cloud-specific storage class, certificate or RBAC grant is generated.

For Kubernetes publishing, the operator keeps an authoritative local copy of
control and uses a config copy whose `control_file`/`audit_dir` refer to its local
state. The proxy config uses its mounted `/control`/`/audit` paths. Only public
paths differ; the operator publishes the issued epoch/capability bytes unchanged.
The proxy init container prepares the actual PVC; no client gets PVC/admin access.

Admin delivery maps the issued epoch JSON to the proxy's control ConfigMap and the
client capability to a client-only volume. The client receives the proxy CA/public
connection values, Temporal credentials and its own platform configuration through
its later deployment; it receives no plugin/source/provider/RP client secret or
Kubernetes authority. Verify the installed CNI's Service NAT/startup/address-family
behavior for the concrete topology; these manifests do not assert universal node
or metadata isolation. Full client application packaging and that broader native
lockdown gate are separate from the reusable proxy boundary.

Client-auth encoding follows [RFC 6749 §2.3.1](https://www.rfc-editor.org/rfc/rfc6749#section-2.3.1)
and PKCE input bounds follow [RFC 7636 §4.1](https://www.rfc-editor.org/rfc/rfc7636#section-4.1).
The intranet path/operation and credential guards adapt signed feature `97722cd`;
no whole older run/receipt/policy files replace the newer substrate.
