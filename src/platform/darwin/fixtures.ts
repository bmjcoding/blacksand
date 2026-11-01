// A Mac as discovery sees it through a fake Host, for tests.

import type { FakeMachine } from "../fake-host.ts";

// What Apple's tools print, in the shapes seen on macOS 27 (names made up).
export const USERS = `NFSHomeDirectory: /var/empty
PrimaryGroupID: -2
RecordName: nobody
UniqueID: -2
UserShell: /usr/bin/false
-
NFSHomeDirectory: /Users/owner
PrimaryGroupID: 20
RecordName: owner
UniqueID: 501
UserShell: /bin/zsh
-
dsAttrTypeNative:IsHidden: 1
NFSHomeDirectory: /private/var/t3blackout-build
PrimaryGroupID: 20
RecordName: _t3blackout
UniqueID: 299
UserShell: /usr/bin/false
-
NFSHomeDirectory: /var/root /private/var/root
PrimaryGroupID: 0
RecordName:
 root
 BUILTIN\\Local System
UniqueID: 0
UserShell: /bin/sh
`;

const GROUPS = `GroupMembership: root owner
PrimaryGroupID: 80
RecordName: admin BUILTIN\\Administrators
-
PrimaryGroupID: 399
RecordName: com.apple.access_ssh
GroupMembership: owner
`;

const LAUNCHD = `system = {
\ttype = system
\tservice stats = {
\t\tcom.apple.launchd.service-stats-default (4096 records)
\t}
\tservices = {
\t\t       0      - \tcom.openssh.sshd
\t\t     812      - \tdev.blacksand.updater
\t\t       0      1 \tdev.t3blackout.update
\t\t   66516      - \tcom.apple.AppleVirtualPlatform.SystemService
\t\t       0  (jt) \tcom.apple.example
\t}
\tdisabled services = {
\t\t"com.apple.ftpd" => disabled
\t\t"com.openssh.sshd" => enabled
\t}
}
`;

/** What sshd -G prints (Apple's build capitalizes keywords), with `changes` replacing or adding keywords; a list prints one line per value. */
export function sshdDump(changes: { [keyword: string]: string | string[] } = {}): string {
  const base: { [keyword: string]: string | string[] } = {
    Port: "22",
    UsePAM: "yes",
    PermitRootLogin: "prohibit-password",
    MaxAuthTries: "6",
    PubkeyAuthentication: "yes",
    PasswordAuthentication: "no",
    KbdInteractiveAuthentication: "no",
    AuthenticationMethods: "any",
    X11Forwarding: "no",
    Banner: "none",
    ...changes,
  };
  return Object.entries(base).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((value) => `${k} ${value}`)).join("\n") + "\n";
}

const ADDRS = ["127.0.0.1", "100.64.0.1", "192.168.1.2", "203.0.113.1"];

/** The sshd -G -T -C answers for `users` from every probe address, each `dumpFor(user, addr)`. */
export function sshdConnections(users: readonly string[], dumpFor: (user: string, addr: string) => string = () => sshdDump()): { [command: string]: string } {
  return Object.fromEntries(users.flatMap((user) => ADDRS.map((addr) => [`/usr/sbin/sshd -G -T -f /etc/ssh/sshd_config -C user=${user},host=${addr},addr=${addr}`, dumpFor(user, addr)])));
}

export const MAC: FakeMachine = {
  programs: {
    "/usr/bin/dscl . -readall /Users RecordName UniqueID PrimaryGroupID UserShell NFSHomeDirectory IsHidden": USERS,
    "/usr/bin/dscl . -readall /Groups RecordName PrimaryGroupID GroupMembership": GROUPS,
    "/bin/launchctl print system": LAUNCHD,
    "/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate": "Firewall is enabled. (State = 1)\n",
    "/usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode": "Firewall stealth mode is on\n",
    "/usr/libexec/ApplicationFirewall/socketfilterfw --getblockall": "Firewall has block all state set to disabled.\n",
    "/usr/bin/fdesetup status": "FileVault is On.\n",
    "/usr/bin/xcode-select -p": "/Library/Developer/CommandLineTools\n",
    "/opt/homebrew/bin/git --version": "git version 2.56.0\n",
    "/Library/Developer/CommandLineTools/usr/bin/git --version": "git version 2.54.0 (Apple Git-157)\n",
    "/opt/homebrew/bin/tailscale version": "1.104.4\n  tailscale commit: 0\n",
    "/usr/sbin/sshd -G -f /etc/ssh/sshd_config": sshdDump(),
    // With -ddd sshd also says, on stderr, which Match blocks it read: none here.
    "/usr/sbin/sshd -G -ddd -f /etc/ssh/sshd_config": { stdout: sshdDump(), stderr: "debug2: load_server_config: filename /etc/ssh/sshd_config\n" },
    // The accounts that can log in (owner's zsh, root's sh), and any a plan names, are evaluated per connection.
    ...sshdConnections(["owner", "root"]),
  },
  files: {
    "/opt/homebrew/bin/git": "",
    "/Library/Developer/CommandLineTools/usr/bin/git": "",
    "/opt/homebrew/bin/tailscale": "",
  },
};
