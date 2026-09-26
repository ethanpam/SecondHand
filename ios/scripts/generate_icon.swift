import AppKit

// A code-drawn mark: a saved document, a check, and a second supporting sheet.
let size = NSSize(width: 1024, height: 1024)
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8,
    bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
NSColor(srgbRed: 0.08, green: 0.25, blue: 0.21, alpha: 1).setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()
NSColor(srgbRed: 0.37, green: 0.56, blue: 0.43, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 196, y: 188, width: 534, height: 578), xRadius: 76, yRadius: 76).fill()
NSColor(srgbRed: 0.98, green: 0.96, blue: 0.89, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 292, y: 276, width: 534, height: 578), xRadius: 76, yRadius: 76).fill()
NSColor(srgbRed: 0.77, green: 0.81, blue: 0.71, alpha: 1).setFill()
for width in [328.0, 226.0] {
    let y = width == 328 ? 701.0 : 625.0
    NSBezierPath(roundedRect: NSRect(x: 388, y: y, width: width, height: 24), xRadius: 12, yRadius: 12).fill()
}
NSColor(srgbRed: 0.08, green: 0.25, blue: 0.21, alpha: 1).setStroke()
let check = NSBezierPath()
check.move(to: NSPoint(x: 404, y: 467))
check.line(to: NSPoint(x: 502, y: 373))
check.line(to: NSPoint(x: 700, y: 563))
check.lineWidth = 44
check.lineCapStyle = .round
check.lineJoinStyle = .round
check.stroke()
NSGraphicsContext.restoreGraphicsState()
let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
let png = bitmap.representation(using: .png, properties: [:])!
let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "SecondHand/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
try png.write(to: URL(fileURLWithPath: output))
