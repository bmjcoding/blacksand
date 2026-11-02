# Recording or streaming the host's screen

> **Applies to:** a macOS host viewed from a macOS desktop through
> [Screen Sharing](screen-sharing.md).

Record on the desktop, not on the host. A process started over SSH can't get macOS's
Screen Recording permission. On the host, `screencapture` over SSH fails with "could
not create image from display". Giving an agent account Screen Recording would also
let its agents watch the screen.

- **Record.** Open the Screen Sharing window. Then, on the desktop, press ⇧⌘5, choose
  **Record Selected Window**, and pick that window. **QuickTime Player → New Screen
  Recording** works too. You grant Screen Recording once, on the desktop only.
- **Stream.** Use OBS on the desktop (`brew install --cask obs`), with a macOS Screen
  Capture source set to the Screen Sharing window. The stream key stays on the
  desktop, and nothing on the host changes.
- **Simulators.** `xcrun simctl io booted recordVideo out.mov` works over SSH in the
  agent account. It records the simulator, not the screen. The Device panel also
  streams simulators and emulators itself ([devices](../devices/overview.md)).
