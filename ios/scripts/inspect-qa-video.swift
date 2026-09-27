#!/usr/bin/env swift
// Inspect real QA footage and extract at most eight representative frames.
// Usage: swift ios/scripts/inspect-qa-video.swift INPUT.mp4 OUTPUT_DIRECTORY [INTERVAL_SECONDS]
// The contact sheet scales extracted frames and labels their actual timestamps.
// It does not synthesize frames or alter the source video.

import AppKit
import AVFoundation
import CoreText
import Foundation

struct FrameEvidence: Codable {
    let requestedSeconds: Double
    let actualSeconds: Double
    let path: String
}

struct VideoEvidence: Codable {
    let sourcePath: String
    let fileBytes: Int
    let durationSeconds: Double
    let encodedWidth: Double
    let encodedHeight: Double
    let displayWidth: Double
    let displayHeight: Double
    let nominalFramesPerSecond: Float
    let samplingIntervalSeconds: Double
    let samplingDescription: String
    let frames: [FrameEvidence]
    let contactSheetPath: String
}

enum InspectionError: LocalizedError {
    case invalid(String)

    var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        }
    }
}

func writePNG(_ image: CGImage, to url: URL) throws {
    guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw InspectionError.invalid("Could not encode PNG: \(url.path)")
    }
    try data.write(to: url, options: .atomic)
}

func timestamp(_ seconds: Double) -> String {
    let minutes = Int(seconds / 60)
    return String(format: "%02d:%04.1f", minutes, seconds - Double(minutes * 60))
}

func makeContactSheet(_ images: [(image: CGImage, seconds: Double)], to url: URL) throws {
    let columns = min(4, images.count)
    let rows = (images.count + columns - 1) / columns
    let cellWidth = 300
    let cellHeight = 680
    let padding = 12
    let labelHeight = 28
    let width = columns * cellWidth
    let height = rows * cellHeight
    guard let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw InspectionError.invalid("Could not create contact-sheet image context.")
    }

    context.setFillColor(CGColor(gray: 0.08, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .high
    let font = CTFontCreateWithName("Menlo" as CFString, 14, nil)

    for (index, frame) in images.enumerated() {
        let column = index % columns
        let row = index / columns
        let left = column * cellWidth
        let bottom = height - (row + 1) * cellHeight
        let availableWidth = CGFloat(cellWidth - 2 * padding)
        let availableHeight = CGFloat(cellHeight - 2 * padding - labelHeight)
        let scale = min(availableWidth / CGFloat(frame.image.width), availableHeight / CGFloat(frame.image.height))
        let drawWidth = CGFloat(frame.image.width) * scale
        let drawHeight = CGFloat(frame.image.height) * scale
        let rect = CGRect(
            x: CGFloat(left) + (CGFloat(cellWidth) - drawWidth) / 2,
            y: CGFloat(bottom + padding + labelHeight) + (availableHeight - drawHeight) / 2,
            width: drawWidth, height: drawHeight
        )
        context.draw(frame.image, in: rect)
        let label = NSAttributedString(
            string: "Frame \(index + 1) · \(timestamp(frame.seconds))",
            attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1)
            ]
        )
        context.textPosition = CGPoint(x: left + padding, y: bottom + padding + 6)
        CTLineDraw(CTLineCreateWithAttributedString(label), context)
    }

    guard let sheet = context.makeImage() else {
        throw InspectionError.invalid("Could not finish contact-sheet image.")
    }
    try writePNG(sheet, to: url)
}

do {
    let args = CommandLine.arguments
    guard args.count == 3 || args.count == 4 else {
        throw InspectionError.invalid("Usage: swift inspect-qa-video.swift INPUT.mp4 OUTPUT_DIRECTORY [INTERVAL_SECONDS]")
    }
    let source = URL(fileURLWithPath: args[1]).standardizedFileURL
    let output = URL(fileURLWithPath: args[2], isDirectory: true).standardizedFileURL
    let interval = args.count == 4 ? Double(args[3]) : 10
    guard let interval, interval.isFinite, interval > 0 else {
        throw InspectionError.invalid("INTERVAL_SECONDS must be a finite number greater than zero.")
    }
    guard FileManager.default.fileExists(atPath: source.path) else {
        throw InspectionError.invalid("Source file does not exist: \(source.path)")
    }

    let asset = AVURLAsset(url: source)
    let duration = CMTimeGetSeconds(try await asset.load(.duration))
    guard duration.isFinite, duration > 0 else {
        throw InspectionError.invalid("Source video has no finite positive duration.")
    }
    guard let track = try await asset.loadTracks(withMediaType: .video).first else {
        throw InspectionError.invalid("Source has no video track.")
    }
    let (size, transform, fps) = try await track.load(.naturalSize, .preferredTransform, .nominalFrameRate)
    let displayBounds = CGRect(origin: .zero, size: size).applying(transform).standardized
    let bytes = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

    // Preserve roughly ten-second spacing for short clips. Longer clips use
    // eight evenly spaced samples, always including the opening and ending.
    let lastTime = max(0, duration - min(0.1, duration / 2))
    var requestedTimes: [Double] = []
    if lastTime / interval >= 7 {
        requestedTimes = (0..<8).map { Double($0) * lastTime / 7 }
    } else {
        requestedTimes = Array(stride(from: 0.0, through: lastTime, by: interval))
        if let previous = requestedTimes.last, lastTime - previous > 0.05 {
            requestedTimes.append(lastTime)
        }
    }

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = CMTime(seconds: 0.1, preferredTimescale: 600)
    generator.requestedTimeToleranceAfter = CMTime(seconds: 0.1, preferredTimescale: 600)
    var frames: [FrameEvidence] = []
    var images: [(image: CGImage, seconds: Double)] = []
    for (index, seconds) in requestedTimes.enumerated() {
        let result = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
        let actualSeconds = CMTimeGetSeconds(result.actualTime)
        let path = output.appendingPathComponent(String(format: "frame-%02d.png", index + 1))
        try writePNG(result.image, to: path)
        frames.append(FrameEvidence(requestedSeconds: seconds, actualSeconds: actualSeconds, path: path.path))
        images.append((image: result.image, seconds: actualSeconds))
    }

    let contactSheet = output.appendingPathComponent("contact-sheet.png")
    try makeContactSheet(images, to: contactSheet)
    let evidence = VideoEvidence(
        sourcePath: source.path, fileBytes: bytes, durationSeconds: duration,
        encodedWidth: size.width, encodedHeight: size.height,
        displayWidth: displayBounds.width, displayHeight: displayBounds.height,
        nominalFramesPerSecond: fps, samplingIntervalSeconds: interval,
        samplingDescription: "At most eight real decoded frames; interval sampling plus ending, or evenly spaced for longer videos. Labels show actual decoded timestamps.",
        frames: frames, contactSheetPath: contactSheet.path
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let metadata = try encoder.encode(evidence)
    try metadata.write(to: output.appendingPathComponent("metadata.json"), options: .atomic)
    FileHandle.standardOutput.write(metadata)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("inspect-qa-video: \(error.localizedDescription)\n".utf8))
    exit(1)
}
