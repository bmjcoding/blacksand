// How the runner reaches the cluster: the `kubectl` program, given argv only
// (never a shell) and manifests on stdin. kubectl reads its own kubeconfig, so
// cluster credentials never pass through blacksand's arguments, output or
// records. The prefix is configurable, for a cluster reached another way:
//   BLACKSAND_KUBECTL='["kubectl","--context","lab"]'
//   BLACKSAND_KUBECTL='["limactl","shell","lab","sudo","k3s","kubectl"]'
// A prefix that goes through SSH joins arguments into a remote shell line, so
// every argument blacksand adds is checked to be a plain word first.

import { spawn } from "node:child_process";
import * as fs from "node:fs";

export interface KubectlResult {
  status: number | null;
  stdout: Buffer;
  stderr: string;
  /** Why blacksand killed it, if it did: it ran past its timeout, or printed more than MAX_OUTPUT. */
  killed?: "timeout" | "output-limit";
}

export interface KubectlOptions {
  stdin?: Buffer | string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Write stdout to this file instead of holding it (stdout comes back empty). */
  stdoutFile?: string;
  /** The stdout limit, in bytes (default 64 MiB). */
  maxOutput?: number;
}

/** Runs kubectl with `args`; resolves when it exits (or is killed by the timeout or signal). */
export type Kubectl = (args: readonly string[], options?: KubectlOptions) => Promise<KubectlResult>;

export class KubectlError extends Error {}

const PLAIN = /^[A-Za-z0-9_./:=,@+-]+$/;
const MAX_OUTPUT = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export function assertPlain(args: readonly string[]): void {
  for (const arg of args) if (!PLAIN.test(arg)) throw new KubectlError(`refusing a kubectl argument that isn't a plain word: ${JSON.stringify(arg)}`);
}

/** The kubectl prefix from BLACKSAND_KUBECTL (a JSON list of strings), else plain `kubectl`. */
export function kubectlPrefix(value: string | undefined): string[] {
  if (!value) return ["kubectl"];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.length || !parsed.every((part) => typeof part === "string" && part)) {
    throw new KubectlError("BLACKSAND_KUBECTL must be a JSON list of strings, e.g. [\"kubectl\",\"--context\",\"lab\"]");
  }
  return parsed as string[];
}

export function processKubectl(prefix: readonly string[]): Kubectl {
  const [program, ...base] = prefix;
  if (!program) throw new KubectlError("empty kubectl prefix");
  return (args, options = {}) => {
    assertPlain(args);
    return new Promise((resolve, reject) => {
      const child = spawn(program, [...base, ...args], { stdio: ["pipe", "pipe", "pipe"], signal: options.signal, killSignal: "SIGKILL" });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let errSize = 0;
      let killed: KubectlResult["killed"];
      const kill = (why: NonNullable<KubectlResult["killed"]>) => {
        killed ??= why;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => kill("timeout"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const limit = options.maxOutput ?? MAX_OUTPUT;
      let file = options.stdoutFile ? fs.openSync(options.stdoutFile, "wx", 0o600) : null;
      const closeFile = () => {
        if (file !== null) fs.closeSync(file);
        file = null;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) kill("output-limit");
        else if (file !== null) fs.writeSync(file, chunk);
        else out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errSize += chunk.length;
        if (errSize > MAX_OUTPUT) kill("output-limit");
        else err.push(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        closeFile();
        reject(error);
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        closeFile();
        resolve({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), ...(killed ? { killed } : {}) });
      });
      child.stdin.on("error", () => {}); // kubectl may exit before reading all of stdin
      child.stdin.end(options.stdin ?? "");
    });
  };
}

/** kubectl that must succeed: its stdout, or a KubectlError with what it said. */
export async function must(kubectl: Kubectl, args: readonly string[], options?: KubectlOptions): Promise<Buffer> {
  const result = await kubectl(args, options);
  if (result.status !== 0) throw new KubectlError(`kubectl ${args.slice(0, 3).join(" ")} failed (${result.status ?? "killed"}): ${result.stderr.trim().slice(0, 500)}`);
  return result.stdout;
}

export async function getJson<T>(kubectl: Kubectl, args: readonly string[], options?: KubectlOptions): Promise<T> {
  return JSON.parse((await must(kubectl, [...args, "-o", "json"], options)).toString("utf8")) as T;
}
