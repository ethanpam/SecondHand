// Builds every SecondHand icon from the mascot artwork, so the website,
// desktop app, Chrome extension, iOS, and Android all show the same logo.
// Run from the repository root on a Mac: swift scripts/generate-icons.swift
import CoreGraphics
import Foundation
import ImageIO

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let sourceURL = root.appendingPathComponent("website/public/brand/secondhand-mascot.png")
guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
      let mascot = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fatalError("Run from the repository root; \(sourceURL.path) was not found.")
}
// The artwork's own background, for layers drawn behind it.
let tileColor = CGColor(srgbRed: 208 / 255, green: 227 / 255, blue: 201 / 255, alpha: 1)
// Soft, rounded corners shared by the in-app logo, favicon, and extension icons.
let bubbly: CGFloat = 0.3

/// Draws the mascot tile centered on a square canvas.
/// - tile: the tile's share of the canvas; radius: corner radius as a share of the tile.
func icon(size: Int, tile: CGFloat = 1, radius: CGFloat = 0, opaque: Bool = false, shadow: Bool = false) -> Data {
    let canvas = CGFloat(size)
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.interpolationQuality = .high
    if opaque {
        context.setFillColor(tileColor)
        context.fill(CGRect(x: 0, y: 0, width: canvas, height: canvas))
    }
    let side = (canvas * tile).rounded()
    let rect = CGRect(x: (canvas - side) / 2, y: (canvas - side) / 2, width: side, height: side)
    let shape = CGPath(roundedRect: rect, cornerWidth: side * radius, cornerHeight: side * radius, transform: nil)
    if shadow {
        context.saveGState()
        context.setShadow(offset: CGSize(width: 0, height: -canvas * 0.012), blur: canvas * 0.028, color: CGColor(gray: 0, alpha: 0.3))
        context.addPath(shape)
        context.setFillColor(tileColor)
        context.fillPath()
        context.restoreGState()
    }
    context.addPath(shape)
    context.clip()
    context.draw(mascot, in: rect)
    let png = NSMutableData()
    let destination = CGImageDestinationCreateWithData(png, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
    return png as Data
}

let outputs: [(String, Data)] = [
    // Browser tab icon.
    ("website/public/brand/secondhand-icon.png", icon(size: 256, radius: bubbly)),
    // Logo in the desktop app's sign-in screen and sidebar.
    ("renderer/brand-mark.png", icon(size: 128, radius: bubbly)),
    // Chrome toolbar, extensions page, and the extension's own logo.
    ("extension/icon-16.png", icon(size: 16, radius: bubbly)),
    ("extension/icon-32.png", icon(size: 32, radius: bubbly)),
    ("extension/icon-48.png", icon(size: 48, radius: bubbly)),
    ("extension/icon-128.png", icon(size: 128, radius: bubbly)),
    // Mac and Windows app icon, on Apple's 824 px icon grid with its shadow.
    ("desktop/icon.png", icon(size: 1024, tile: 824 / 1024, radius: 0.225, shadow: true)),
    // Safari extension icons on iPhone (Settings and Safari's extension menu).
    ("ios/SafariExtension/Resources/icon-48.png", icon(size: 48, radius: bubbly)),
    ("ios/SafariExtension/Resources/icon-96.png", icon(size: 96, radius: bubbly)),
    ("ios/SafariExtension/Resources/icon-128.png", icon(size: 128, radius: bubbly)),
    ("ios/SafariExtension/Resources/icon-256.png", icon(size: 256, radius: bubbly)),
    ("ios/SafariExtension/Resources/icon-512.png", icon(size: 512, radius: bubbly)),
    // iOS masks its own corners and requires an opaque, full-bleed image.
    ("ios/SecondHand/Assets.xcassets/AppIcon.appiconset/AppIcon.png", icon(size: 1024, opaque: true)),
    // Android adaptive icon foreground: 108 dp canvas. Launchers show the center
    // 72 dp, so the tile fills exactly that and round masks keep the ears.
    ("android/app/src/main/res/drawable-nodpi/ic_launcher_foreground.png", icon(size: 432, tile: 72 / 108)),
]

for (path, data) in outputs {
    let url = root.appendingPathComponent(path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url)
    print("wrote \(path)")
}
