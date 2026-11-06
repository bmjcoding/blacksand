// Durable run receipts: `k8s run --key K` makes the run's output directory its
// claim, so a caller that retries with the same key never launches it twice.
//
//   <receipts>/<sha256(K)>/   made with one mkdir: the claim. Of any number of
//                             runner processes, exactly one makes it.
//     claim.json              written and synced before the run touches the
//                             cluster: the key, the request's digest, the run's
//                             id and deadline
//     record.json             the run's record, renamed into place last, before
//                             the run reports anything
//
// Its state: completed (a record, whatever the run's status), claimed (no
// record: the outcome is unknown, and the run is never relaunched), unclaimed
// (no directory). A claim without claim.json was taken by a runner that
// stopped before writing it, so before it created anything. Nothing deletes a
// receipt: run teardown and reconcile act only on cluster objects.
//
// The receipts root is provisioned once (provisionReceipts, run by `k8s
// setup`): each directory made and its name synced into its parent, and only
// then its READY marker published. A claim never creates the root and refuses
// one without READY, so no claim can sit under a directory whose own name a
// crash could still lose, even beside a setup still running or one that died.
//
// One runner per cluster is assumed. Receipts live on that runner's disk, so
// a second runner, with receipts of its own, could claim the same key.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { census } from "./lifecycle.ts";
import type { Kubectl } from "./kubectl.ts";
import { sha256 } from "./policy.ts";
import { recordProblems, type RunRecord } from "./record.ts";

export const CLAIM_SCHEMA = "blacksand.claim/1";
/** In the receipts root, published last by provisionReceipts: every directory above it is on disk. */
export const READY = "READY";
export const RECEIPT_SCHEMA = "blacksand.receipt/1";

export interface Claim {
  schema: typeof CLAIM_SCHEMA;
  key: string;
  /** The digest of the whole request (requestDigest): the same key with another request is refused. */
  request_sha256: string;
  run_id: string;
  claimed_at: string;
  /** When everything of the run expires: the proxy (its only way out) stops, and the Sandbox is deleted by its controller. */
  deadline: string;
}

export type ReceiptState = "completed" | "claimed" | "unclaimed";

export class ReceiptError extends Error {
  readonly code: "claimed" | "request-changed";
  constructor(code: "claimed" | "request-changed", message: string) {
    super(message);
    this.code = code;
  }
}

/** The receipts root: BLACKSAND_RECEIPTS, else under the runner's own state directory. */
export const receiptsRoot = (env: NodeJS.ProcessEnv = process.env) => env.BLACKSAND_RECEIPTS || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "blacksand", "k8s-receipts");

/** A key's receipt directory: named by the key's digest, so any key is a safe name. */
export const receiptDir = (root: string, key: string) => path.join(path.resolve(root), sha256(key));

function syncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes a new file (never one that exists), all of it, and syncs it to disk. */
export function writeDurable(file: string, data: string | Buffer): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, typeof data === "string" ? Buffer.from(data) : data); // loops until every byte is written; one write may write fewer
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Puts `file` in place whole or not at all: written beside it, synced, renamed, and the directory synced. */
export function publishDurable(file: string, data: string | Buffer): void {
  const tmp = `${file}.partial`;
  writeDurable(tmp, data);
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}

/**
 * Makes the receipts root, if it isn't there, durably: each missing directory
 * from the top down, and its parent synced so its name survives a crash; then
 * the READY marker, which is what lets a claim use it. Safe to run again (it
 * completes a root an interrupted setup left without READY), or beside another
 * runner making the same directories.
 */
export function provisionReceipts(root: string): string {
  const full = path.resolve(root);
  const parts = full.split(path.sep).filter(Boolean);
  let at = path.parse(full).root;
  for (const part of parts) {
    const next = path.join(at, part);
    try {
      fs.mkdirSync(next, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    syncDir(at); // whoever made it, its name is on disk before anything goes inside
    at = next;
  }
  syncDir(full);
  const ready = path.join(full, READY);
  if (!fs.existsSync(ready)) {
    // Only now, every ancestor synced: written whole and synced beside it, renamed in, the root synced.
    const tmp = `${ready}.${process.pid}.partial`;
    writeDurable(tmp, "blacksand receipts root: every directory above this one is on disk\n");
    fs.renameSync(tmp, ready);
    syncDir(full);
  }
  return full;
}

/** Takes the claim: true if this call made it, false if it was already there. Never checks first, so two callers can't both win. The receipts root must be provisioned (READY). */
export function takeClaim(dir: string, claim: Claim): boolean {
  // READY is only ever added, after every directory above it is on disk: without it the root may be one a crash could still lose.
  const root = path.dirname(dir);
  if (!fs.existsSync(path.join(root, READY))) throw new Error(`the receipts root ${root} isn't provisioned (no ${READY} marker): run blacksand k8s setup --receipts ${root} on this runner`);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw error;
  }
  syncDir(path.dirname(dir));
  publishDurable(path.join(dir, "claim.json"), `${JSON.stringify(claim, null, 2)}\n`);
  return true;
}

export interface Receipt {
  state: ReceiptState;
  /** Null when unclaimed, or claimed by a runner that stopped before writing it. */
  claim: Claim | null;
  record: RunRecord | null;
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export function readReceipt(dir: string): Receipt {
  if (!fs.existsSync(dir)) return { state: "unclaimed", claim: null, record: null };
  const claim = readJson<Claim>(path.join(dir, "claim.json"));
  const record = readJson<RunRecord>(path.join(dir, "record.json"));
  return { state: record ? "completed" : "claimed", claim, record };
}

/**
 * What an existing claim means for a new run of `request`: its record, if it
 * completed with the same request; otherwise a refusal saying why.
 */
export function answerFromReceipt(dir: string, key: string, request: string): RunRecord {
  const { claim, record } = readReceipt(dir);
  if (claim && claim.request_sha256 !== request) throw new ReceiptError("request-changed", `key ${JSON.stringify(key)} was claimed for a different request (${claim.request_sha256.slice(0, 12)}…): a changed request needs a new key`);
  if (!record) throw new ReceiptError("claimed", `key ${JSON.stringify(key)} is claimed with no record (${dir}): its outcome is unknown, so it won't be launched again`);
  if (!claim) throw new ReceiptError("claimed", `key ${JSON.stringify(key)} has a record but no claim (${dir}): it can't be matched to this request`);
  return record;
}

/** A recovery read never provisions, claims, generates a run or contacts the cluster. */
export function replayReceipt(dir: string, key: string, request: string): RunRecord {
  try {
    if (!fs.existsSync(path.join(path.dirname(dir), READY))) throw new Error("unprovisioned receipts root");
    const record = answerFromReceipt(dir, key, request);
    const claim = readJson<Claim>(path.join(dir, "claim.json"));
    if (!claim || claim.schema !== CLAIM_SCHEMA || claim.key !== key || claim.run_id !== record.run.id
        || record.run.key !== key || record.run.request_sha256 !== request || recordProblems(record).length) {
      throw new Error("receipt identity or record is inconsistent");
    }
    return record;
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    throw new ReceiptError("claimed", `key ${JSON.stringify(key)} has no readable matching receipt: its outcome is unknown`);
  }
}

export interface ReceiptStatus extends Receipt {
  schema: typeof RECEIPT_SCHEMA;
  key: string;
  receipt: string;
  /**
   * For a claim with no record, facts about it: its deadline and whether this
   * runner's clock has passed it, and the run's objects still in the cluster
   * (null if the cluster couldn't be read). They are not proof the run can no
   * longer act: a runner paused after its claim can still create its objects
   * later, and the cluster's clock isn't this one. So nothing here says "ended".
   */
  authority: { deadline: string; past_deadline: boolean; objects: string[] | null; foreign: string[] | null; error: string | null } | null;
}

export async function receiptStatus(root: string, key: string, kubectl: Kubectl, nowMs: number): Promise<ReceiptStatus> {
  const dir = receiptDir(root, key);
  const receipt = readReceipt(dir);
  let authority: ReceiptStatus["authority"] = null;
  if (receipt.state === "claimed" && receipt.claim) {
    const past = Date.parse(receipt.claim.deadline) <= nowMs;
    try {
      const found = await census(kubectl, receipt.claim.run_id);
      const objects = (found.runs.get(receipt.claim.run_id) ?? []).map((o) => `${o.namespace}/${o.kind}/${o.name}`);
      authority = { deadline: receipt.claim.deadline, past_deadline: past, objects, foreign: found.foreign, error: null };
    } catch (error) {
      authority = { deadline: receipt.claim.deadline, past_deadline: past, objects: null, foreign: null, error: (error as Error).message.slice(0, 300) };
    }
  }
  return { schema: RECEIPT_SCHEMA, key, receipt: dir, ...receipt, authority };
}
