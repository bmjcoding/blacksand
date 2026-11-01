// Git objects and SSH signatures written straight from JavaScript, for the
// generated histories (test/trust-histories.mjs): thousands of signed commits in
// seconds, where git commit and ssh-keygen would spawn two processes for each.
// Signatures are SSHSIG (PROTOCOL.sshsig in OpenSSH), Ed25519, namespace "git",
// exactly what `ssh-keygen -Y sign` makes, so git and ssh-keygen check them as
// they check the owner's.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { deflateSync } from "node:zlib";

/** An SSH wire-format string: its length, then its bytes. */
const sshString = (bytes) => {
  const data = Buffer.from(bytes);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
};

/** PKCS #8 DER for an Ed25519 private key, before its 32-byte seed (RFC 8410). */
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * A throwaway Ed25519 key: `pub` as an allowed-signers line takes it, `sign(payload)`
 * giving the armored signature, and `pem`, the private key. From `seed` (any text)
 * the same key every time, so a seeded history's signatures can be made again.
 */
export function sshKey(seed = null) {
  const privateKey = seed === null ? generateKeyPairSync("ed25519").privateKey : createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, createHash("sha256").update(seed).digest()]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(raw)]);
  const pub = `ssh-ed25519 ${blob.toString("base64")}`;
  const signPayload = (payload) => {
    const digest = createHash("sha512").update(payload).digest();
    const signed = Buffer.concat([Buffer.from("SSHSIG"), sshString("git"), sshString(""), sshString("sha512"), sshString(digest)]);
    const signature = Buffer.concat([sshString("ssh-ed25519"), sshString(sign(null, signed, privateKey))]);
    const whole = Buffer.concat([Buffer.from("SSHSIG"), Buffer.from([0, 0, 0, 1]), sshString(blob), sshString("git"), sshString(""), sshString("sha512"), sshString(signature)]);
    const lines = whole.toString("base64").match(/.{1,70}/g);
    return ["-----BEGIN SSH SIGNATURE-----", ...lines, "-----END SSH SIGNATURE-----"].join("\n");
  };
  return { pub, sign: signPayload, pem: privateKey.export({ format: "pem", type: "pkcs8" }) };
}

/** Loose objects in `gitDir`: write(type, content) -> sha. Nothing is spawned. */
export function objectStore(gitDir) {
  const written = new Set();
  const write = (type, content) => {
    const body = Buffer.from(content);
    const object = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const sha = createHash("sha1").update(object).digest("hex");
    if (!written.has(sha)) {
      const file = path.join(gitDir, "objects", sha.slice(0, 2), sha.slice(2));
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, deflateSync(object, { level: 1 }));
      }
      written.add(sha);
    }
    return sha;
  };

  /** The tree of `files` ({ "dir/name": text }), nested as git nests them. */
  const tree = (files) => {
    const entries = new Map();
    for (const [name, text] of Object.entries(files)) {
      const [first, ...rest] = name.split("/");
      if (rest.length) {
        const sub = entries.get(first)?.files ?? {};
        sub[rest.join("/")] = text;
        entries.set(first, { files: sub });
      } else entries.set(first, { text });
    }
    // Git sorts a folder as if its name ended in "/".
    const sorted = [...entries].sort(([a, x], [b, y]) => Buffer.compare(Buffer.from(x.files ? `${a}/` : a), Buffer.from(y.files ? `${b}/` : b)));
    const body = sorted.map(([name, entry]) => {
      const sha = entry.files ? tree(entry.files) : write("blob", entry.text);
      return Buffer.concat([Buffer.from(`${entry.files ? "40000" : "100644"} ${name}\0`), Buffer.from(sha, "hex")]);
    });
    return write("tree", Buffer.concat(body));
  };

  /**
   * A commit of `tree` on `parents`, signed by `key` (null: unsigned), or carrying
   * `headers` (raw "gpgsig …" lines, for forged signatures) instead.
   */
  const commit = ({ tree: treeSha, parents = [], message, key = null, headers = null, time = 1761800000 }) => {
    const head = [`tree ${treeSha}`, ...parents.map((parent) => `parent ${parent}`), `author t <t@example.com> ${time} +0000`, `committer t <t@example.com> ${time} +0000`];
    const payload = `${head.join("\n")}\n\n${message}\n`;
    const signature = headers ?? (key ? [`gpgsig ${key.sign(payload).replaceAll("\n", "\n ")}`] : []);
    return write("commit", `${[...head, ...signature].join("\n")}\n\n${message}\n`);
  };

  return { write, tree, commit, file: (sha) => path.join(gitDir, "objects", sha.slice(0, 2), sha.slice(2)) };
}
