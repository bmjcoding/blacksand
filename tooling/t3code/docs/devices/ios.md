# iOS Simulators and iPhones

> **Applies to:** macOS (host, standby or desktop). iOS tooling doesn't exist on Linux.

## Simulators

Once per Mac, from your admin account, install the latest Xcode into `/Applications`.
Get it from the App Store, signed in with your Apple Account. Then run:

```sh
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
xcodebuild -downloadPlatform iOS
```

The last line downloads the iOS Simulator runtime, which every account shares. Use
`-downloadPlatform watchOS` for watch apps, or `-downloadAllPlatforms`. Then check each
agent account that should run simulators. Boot a simulator from an SSH session, the
way that account's server starts it:

```sh
ssh agent-claude@localhost 'xcrun simctl list devices available'
ssh agent-claude@localhost 'xcrun simctl bootstatus "<a device name from the list>" -b && xcrun simctl shutdown all'
```

Each account has its own simulators. If the list has none, create one in that account
with a device type from `xcrun simctl list devicetypes`:
`xcrun simctl create Phone "<device type>"`.

In a macOS 27.2 VM, a simulator booted this way in an account that nobody had logged
in to at the screen. If the boot fails over SSH on your host, log that agent account in
at the host's screen, then switch back to your own account. Run the check again. If
that fixes it, keep the account logged in there, and log it in again after every
restart of the host. FileVault rules out automatic login.

An agent's taps can fail with a Developer Tools authorization error while the agent
builds its test runner. A standard account can't answer that macOS prompt over SSH. To
fix it, run `sudo DevToolsSecurity -enable` and
`sudo dseditgroup -o edit -a agent-claude -t user _developer` from your admin account
on that Mac. Then try again.

## iPhone

1. Connect the iPhone to the Mac whose environment will use it, and unlock it.
2. Tap **Trust This Computer**. Then turn on **Developer Mode** in **Settings**, under
   **Privacy & Security**. The phone restarts.
3. From your admin account, open Xcode once and choose **Window**, then
   **Devices and Simulators**, to finish pairing.
4. Check what the agent account sees with
   `ssh agent-claude@localhost 'xcrun devicectl list devices'`.

To install your own builds on the iPhone, that account's Xcode also needs your Apple
Account's signing. This hasn't been tried with blacksand-t3 yet.
