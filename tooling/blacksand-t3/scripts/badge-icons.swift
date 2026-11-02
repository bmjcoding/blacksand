// Draws the blacksand badge on upstream's PNG app icons, making the three
// lib/files/badge-*.png the build installs (rules desktop/app-icon-*). Rerun it
// when upstream changes those icons. macOS only (AppKit draws the SVG).
//
//   node -e 'import("./lib/rules.mjs").then((m) => process.stdout.write(m.BLACKSAND_BADGE_SVG))' > /tmp/badge.svg
//   swift scripts/badge-icons.swift <upstream checkout at the pin> /tmp/badge.svg lib/files
//
// The badge is 42% of the icon's width, in its bottom-right corner, as in the
// Icon Composer layer (BADGE_LAYER in lib/rules.mjs): centred 250/1024 of the
// icon right of and below its centre. The macOS icon's body is inset 100 of
// 1024 pixels on each side, for its shadow; the others fill the image.

import AppKit

let args = CommandLine.arguments
guard args.count == 4, let badge = NSImage(contentsOfFile: args[2]) else {
  fatalError("usage: swift badge-icons.swift <upstream checkout> <badge.svg> <out dir>")
}
let icons: [(from: String, to: String, inset: Double)] = [
  ("assets/prod/black-macos-1024.png", "badge-macos-1024.png", 100.0 / 1024),
  ("assets/prod/black-universal-1024.png", "badge-universal-1024.png", 0),
  ("assets/prod/t3-black-web-apple-touch-180.png", "badge-180.png", 0),
]
for icon in icons {
  guard let base = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: "\(args[1])/\(icon.from)"))) else {
    fatalError("can't read \(icon.from)")
  }
  let size = Double(base.pixelsWide)
  let body = size * (1 - 2 * icon.inset)
  let diameter = body * 0.42
  let centre = size / 2 + body * 250 / 1024
  let out = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: base.pixelsWide, pixelsHigh: base.pixelsHigh, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
  NSGraphicsContext.current!.imageInterpolation = .high
  base.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
  // AppKit's y runs up; the badge sits as far below the centre as right of it.
  badge.draw(in: NSRect(x: centre - diameter / 2, y: size - centre - diameter / 2, width: diameter, height: diameter))
  NSGraphicsContext.restoreGraphicsState()
  try out.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(args[3])/\(icon.to)"))
}
