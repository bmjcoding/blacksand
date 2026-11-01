// Which kind of signature a commit carries. Only SSH signatures are checked, and
// only against the parent's allowed-signers list; who a signature is from is
// what ssh-keygen finds in that list (history.ts), with no second reading of the
// list here. Git would check OpenPGP and X.509 signatures against whatever
// keyring and program the machine has, which nobody here chose, so those never
// reach git.

export const SIGNERS = ".allowed_signers";

export type SignatureKind = "ssh" | "openpgp" | "x509" | "unknown";

// A Map, not an object literal: a header naming "constructor" must not find Object's.
const ARMOR = new Map<string, SignatureKind>([
  ["-----BEGIN SSH SIGNATURE-----", "ssh"],
  ["-----BEGIN PGP SIGNATURE-----", "openpgp"],
  ["-----BEGIN SIGNED MESSAGE-----", "x509"],
]);

const HEADERS = ["gpgsig ", "gpgsig-sha256 "];

/**
 * The signature on a raw commit object: its kind, "unknown" (several, or another
 * kind), or null when unsigned. Read as git reads a commit: header lines split
 * on LF alone, up to the first empty line, each header named by the literal
 * text that starts its line. CR, U+2028 and U+2029 are bytes inside a line.
 */
export function signatureKind(raw: string): SignatureKind | null {
  const end = raw.indexOf("\n\n");
  const armors: string[] = [];
  for (const line of (end === -1 ? raw : raw.slice(0, end)).split("\n")) {
    const name = HEADERS.find((header) => line.startsWith(header));
    if (name) armors.push(line.slice(name.length));
  }
  const [only, ...more] = armors;
  if (only === undefined) return null;
  if (more.length) return "unknown";
  return ARMOR.get(only) ?? "unknown";
}
