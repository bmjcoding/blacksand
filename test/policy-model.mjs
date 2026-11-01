// A small model of the tailnet policy features the printed grants use (tags,
// "proto:port" and "proto:from-to" in a grant's ip, tests with an optional
// proto), for the tests of scripts/host-common.sh and the scripts that use it. Not Tailscale's policy engine: the
// admin console still validates the real file, tests included.

/** A policy fragment as the scripts print it: JSON with // line comments. */
export function parsePolicy(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else out += c;
  }
  return JSON.parse(out);
}

const grantsPort = (spec, proto, port) => {
  if (spec === "*") return true;
  const [p, range] = spec.split(":");
  if (p !== proto && p !== "*") return false;
  if (range === "*") return true;
  const [from, to = from] = range.split("-").map(Number);
  return port >= from && port <= to;
};

/** Whether `src` may reach `dst` (a tag) on proto/port under the policy's grants. */
export function allows(policy, src, dst, proto, port) {
  return (policy.grants ?? []).some(
    (grant) =>
      (grant.src.includes(src) || grant.src.includes("*")) &&
      (grant.dst.includes(dst) || grant.dst.includes("*")) &&
      grant.ip.some((spec) => grantsPort(spec, proto, port)),
  );
}

/** The policy's tests that don't hold, as [src, accept|deny, destination, proto] tuples. */
export function evaluatePolicyTests(policy) {
  const failures = [];
  for (const t of policy.tests ?? []) {
    const protos = t.proto ? [t.proto] : ["tcp", "udp"];
    for (const kind of ["accept", "deny"]) {
      for (const destination of t[kind] ?? []) {
        const at = destination.lastIndexOf(":");
        const [dst, port] = [destination.slice(0, at), Number(destination.slice(at + 1))];
        const reached = protos.some((proto) => allows(policy, t.src, dst, proto, port));
        if (reached !== (kind === "accept")) failures.push([t.src, kind, destination, t.proto ?? "any"]);
      }
    }
  }
  return failures;
}
