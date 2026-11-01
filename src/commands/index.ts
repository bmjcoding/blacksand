// Every command, in the order help lists them. Imported statically: nothing is loaded by name.

import { k8s } from "../../substrates/kubernetes/src/command.ts";
import type { Command } from "../core/command.ts";
import { plan } from "./plan.ts";
import { status } from "./status.ts";
import { t3 } from "./t3.ts";
import { verify } from "./verify.ts";

export const COMMANDS: readonly Command[] = [status, plan, verify, t3, k8s];
