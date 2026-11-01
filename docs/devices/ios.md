# iOS Simulators and iPhones

> **Applies to:** macOS (host, standby or desktop). iOS tooling doesn't exist on Linux.

## Simulators

Once per Mac, from your admin account, install the latest Xcode (App Store, signed in
with your Apple Account) into `/Applications` first. Then:

```sh
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
xcodebuild -downloadPlatform iOS
```

The last line downloads the iOS Simulator runtime, which every account shares. Use
`-downloadPlatform watchOS` for watch apps, or `-downloadAllPlatforms`. Then, for each
agent account that should run simulators, check that one boots from an SSH session,
the way that account's server starts it:

```sh
ssh agent-claude@localhost 'xcrun simctl list devices available'
ssh agent-claude@localhost 'xcrun simctl bootstatus "<a device name from the list>" -b && xcrun simctl shutdown all'
```

Each account has its own simulators. If the list has none, create one in that
account with a device type from `xcrun simctl list devicetypes`:
`xcrun simctl create Phone "<device type>"`.

In a macOS 27.2 VM, a simulator booted this way in an account nobody was logged in to
at the screen. If the boot fails over SSH on your host, log that agent account in at
the host's screen (then switch back to yours), and run the check again. If that fixes
it, keep the account logged in there, and log it in again after every restart of the
host. FileVault rules out automatic login.

If an agent's taps fail while it builds its test runner, with a Developer Tools
authorization error: a standard account can't answer that macOS prompt over SSH. From
your admin account on that Mac, run `sudo DevToolsSecurity -enable` and `sudo
dseditgroup -o edit -a agent-claude -t user _developer`, then try again.

## iPhone

1. Connect it to the Mac whose environment will use it, and unlock it.
2. Tap **Trust This Computer**, and turn on **Settings → Privacy & Security →
   Developer Mode** (the phone restarts).
3. Open **Xcode → Window → Devices and Simulators** once from your admin account to
   finish pairing.
4. Check what the agent account sees: `ssh agent-claude@localhost 'xcrun devicectl
   list devices'`.

Installing your own builds on it also needs your Apple Account's signing in that
account's Xcode. This hasn't been tried with T3 Blackout yet.
