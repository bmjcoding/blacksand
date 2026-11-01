// Readers for what the OS tools print. Pure functions of text: each refuses
// (throws ParseError) what it can't account for instead of skipping it, so a
// resource is never reported absent because its line was misread. Nothing here
// interprets a configuration file: sshd's effective settings come from sshd
// itself (`sshd -G`).

export class ParseError extends Error {}

const fail = (what: string, why: string): never => {
  throw new ParseError(`${what}: ${why}`);
};

// ------------------------------------------------------------------ dscl --

/**
 * `dscl . -readall <path> <attributes…>`: one record per `-` line, each
 * attribute `Name: v1 v2` (values without spaces) or `Name:` followed by one
 * value per line, each indented by one space (when a value has a space).
 * Native attributes keep their prefix (`dsAttrTypeNative:IsHidden`).
 */
export function parseDscl(text: string): Array<Map<string, string[]>> {
  const records: Array<Map<string, string[]>> = [];
  let record = new Map<string, string[]>();
  let open: string[] | null = null;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [i, line] of lines.entries()) {
    if (line === "-") {
      records.push(record);
      record = new Map();
      open = null;
    } else if (line.startsWith(" ")) {
      if (!open) fail("dscl", `line ${i + 1} continues no attribute`);
      open!.push(line.slice(1));
    } else {
      // A native attribute's name has a colon in it (dsAttrTypeNative:IsHidden): the name ends at the last colon before a space.
      const match = /^([A-Za-z]\S*):(?: ([^]*))?$/.exec(line);
      if (!match) return fail("dscl", `line ${i + 1} isn't an attribute`);
      const [, name = "", rest = ""] = match;
      if (record.has(name)) fail("dscl", `line ${i + 1} repeats ${name}`);
      const values = rest === "" ? [] : rest.split(" ");
      record.set(name, values);
      open = rest === "" ? values : null;
    }
  }
  if (record.size) records.push(record);
  return records;
}

// --------------------------------------------------------------- launchd --

/**
 * `launchctl print system`: the `services` block (`pid  last-exit  label`; a pid
 * of 0 is loaded but not running) and the `disabled services` block (`"label"
 * => enabled|disabled`, launchd's own on/off switch, which outlives the job).
 */
export function parseLaunchd(text: string): { services: Map<string, { pid: number }>; disabled: Map<string, boolean> } {
  const services = new Map<string, { pid: number }>();
  const disabled = new Map<string, boolean>();
  let block: "services" | "disabled" | null = null;
  let sawServices = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (block === null) {
      if (/^\tservices = \{$/.test(line)) {
        block = "services";
        sawServices = true;
      } else if (/^\tdisabled services = \{$/.test(line)) block = "disabled";
      continue;
    }
    if (trimmed === "") continue;
    if (trimmed === "}") {
      block = null;
      continue;
    }
    if (block === "services") {
      const match = /^(\d+)\s+(?:-|-?\d+|\(\w[\w ]*\))\s+(\S+)$/.exec(trimmed);
      if (!match) return fail("launchctl", `unreadable service line ${JSON.stringify(trimmed)}`);
      services.set(match[2] ?? "", { pid: Number(match[1]) });
    } else {
      const match = /^"([^"]+)" => (enabled|disabled)$/.exec(trimmed);
      if (!match) return fail("launchctl", `unreadable disabled-services line ${JSON.stringify(trimmed)}`);
      disabled.set(match[1] ?? "", match[2] === "disabled");
    }
  }
  if (!sawServices) fail("launchctl", "no services block");
  if (block) fail("launchctl", "a block isn't closed");
  return { services, disabled };
}

// ----------------------------------------------------------- Linux files --

/** `getent passwd` or `getent group`: colon-separated lines of exactly `fields` fields. */
export function parseColons(text: string, fields: number, what: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line, i) => {
      const parts = line.split(":");
      if (parts.length !== fields) fail(what, `line ${i + 1} has ${parts.length} fields, not ${fields}`);
      return parts;
    });
}

/** `systemctl list-unit-files --no-legend --plain`: each installed unit file's name (first column). */
export function parseUnitFiles(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const name = /^\s*(\S+)\s+\S+/.exec(line)?.[1];
      return name ?? fail("systemctl", `unreadable unit file line ${JSON.stringify(line)}`);
    });
}

/** `systemctl show --property=…`: one `Name=value` block per unit, blank lines between, in the order the units were named. */
export function parseShow(text: string): Array<Map<string, string>> {
  return text
    .split(/\n\s*\n/)
    .filter((block) => block.trim())
    .map((block) => {
      const props = new Map<string, string>();
      for (const line of block.split("\n").filter(Boolean)) {
        const at = line.indexOf("=");
        if (at <= 0) fail("systemctl", `unreadable property line ${JSON.stringify(line)}`);
        props.set(line.slice(0, at), line.slice(at + 1));
      }
      return props;
    });
}

// ------------------------------------------------------------------ sshd --

/**
 * `sshd -G`'s dump of the effective configuration: `Keyword value…` lines.
 * Keywords are lowercased (Apple's build prints them capitalized, upstream's
 * in lowercase); a keyword printed on several lines keeps one entry per line,
 * never joined: `DenyUsers root` and `DenyUsers agent` are two patterns,
 * `DenyUsers root agent` (quoted in the config) is one.
 */
export function parseSshdDump(text: string): Map<string, string[]> {
  const settings = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const match = /^(\w+)(?: ([^]*))?$/.exec(line);
    if (!match) fail("sshd -G", `unreadable line ${JSON.stringify(line)}`);
    const keyword = (match?.[1] ?? "").toLowerCase();
    settings.set(keyword, [...(settings.get(keyword) ?? []), match?.[2] ?? ""]);
  }
  if (!settings.size) fail("sshd -G", "printed nothing");
  return settings;
}
