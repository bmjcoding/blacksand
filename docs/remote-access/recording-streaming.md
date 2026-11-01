# Recording or streaming the host's screen

> **Applies to:** a macOS host viewed from a macOS desktop through
> [Screen Sharing](screen-sharing.md).

Record on the desktop, not on the host. A process started over SSH can't get macOS's
Screen Recording permission: on the host, `screencapture` over SSH says "could not
create image from display". And giving an agent account Screen Recording would let
its agents watch the screen.

- **Record:** open the Screen Sharing window, then on the desktop use ⇧⌘5 → **Record
  Selected Window** (or **QuickTime Player → New Screen Recording**) and pick it. You
  grant Screen Recording once, on the desktop only.
- **Stream:** use OBS on the desktop (`brew install --cask obs`), with a macOS Screen
  Capture source set to the Screen Sharing window. The stream key stays on the
  desktop, and nothing on the host changes.
- **Simulators:** `xcrun simctl io booted recordVideo out.mov` works over SSH in the
  agent account; it records the simulator, not the screen. The Device panel also
  streams simulators and emulators itself ([devices](../devices/overview.md)).
