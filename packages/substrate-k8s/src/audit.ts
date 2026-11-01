// Reading the proxy's audit back: is it all there, and what did it carry?
// The proxy numbers every line from 1, opens with `start`, and closes with a
// `sealed` marker that counts every line. Each accepted tunnel or model
// request has one `end`. Anything else (a gap, a cut-off tail, a missing
// marker, an accept with no end, a full audit) means the evidence is
// incomplete, and so is the run.

export interface ModelCall {
  op: string;
  model: string | null;
  destination: string | null;
  result: string | null;
  status: number | null;
  returned_model: string | null;
}

export interface Audit {
  entries: number;
  sealed: boolean;
  /** Why the audit can't be relied on; empty when it can. */
  problems: string[];
  /** Tunnels and model requests the proxy accepted. */
  allowed: number;
  denied: number;
  /** Denied CONNECT targets, as host:port (validated by the proxy), with how often. */
  denied_hosts: Record<string, number>;
  model_calls: ModelCall[];
}

type Entry = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v : null);

export function readAudit(log: string, run: string): Audit {
  const audit: Audit = { entries: 0, sealed: false, problems: [], allowed: 0, denied: 0, denied_hosts: {}, model_calls: [] };
  const lines = log.split("\n").filter((l) => l.length);
  const open = new Map<number, Entry>();
  const done = new Set<number>();
  let expected = 1;
  lines.forEach((line, i) => {
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      return void audit.problems.push(`line ${i + 1} isn't JSON`);
    }
    if (e.seq !== expected) audit.problems.push(`line ${i + 1} is entry ${String(e.seq)}, expected ${expected}`);
    expected = typeof e.seq === "number" ? e.seq + 1 : expected + 1;
    if (e.run !== run) audit.problems.push(`entry ${String(e.seq)} is for another run`);
    const id = typeof e.id === "number" ? e.id : null;
    if (i === 0 && e.event !== "start") audit.problems.push("the audit doesn't open with start");
    switch (e.event) {
      case "accept":
        if (id === null || open.has(id) || done.has(id)) audit.problems.push(`entry ${String(e.seq)} accepts work ${String(id)} twice`);
        else open.set(id, e);
        audit.allowed++;
        break;
      case "end": {
        const accepted = id === null ? undefined : open.get(id);
        if (!accepted || id === null) {
          audit.problems.push(`entry ${String(e.seq)} ends work ${String(id)} that wasn't accepted`);
          break;
        }
        open.delete(id);
        done.add(id);
        if (e.kind === "model") {
          audit.model_calls.push({ op: String(e.op), model: text(e.model), destination: text(e.destination), result: text(e.result), status: typeof e.status === "number" ? e.status : null, returned_model: text(e.returned_model) });
        }
        break;
      }
      case "deny":
        audit.denied++;
        if (e.kind === "connect" && typeof e.authority === "string") audit.denied_hosts[e.authority] = (audit.denied_hosts[e.authority] ?? 0) + 1;
        break;
      case "audit-full":
        audit.problems.push("the proxy's audit budget ran out");
        break;
      case "sealed":
        if (i !== lines.length - 1) audit.problems.push("entries follow the closing marker");
        else if (e.entries !== e.seq) audit.problems.push("the closing marker's count doesn't match");
        else if (e.unfinished !== 0) audit.problems.push("work was still open when the proxy sealed");
        else audit.sealed = true;
        break;
      case "start":
        if (i !== 0) audit.problems.push("start isn't the first entry");
        break;
      default:
        audit.problems.push(`entry ${String(e.seq)} has an unknown event`);
    }
  });
  audit.entries = lines.length;
  if (!audit.sealed && !audit.problems.some((p) => p.includes("marker") || p.includes("sealed"))) audit.problems.push("the audit has no closing marker: it was cut off, or the proxy never sealed");
  for (const id of open.keys()) audit.problems.push(`work ${id} was accepted and never ended`);
  return audit;
}
