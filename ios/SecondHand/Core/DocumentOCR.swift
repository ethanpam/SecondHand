import Foundation
import Vision
import PDFKit
import ImageIO

struct OCRWord: Codable, Sendable {
    struct Bounds: Codable, Sendable { let x0: Double; let y0: Double; let x1: Double; let y1: Double }
    let text: String
    let confidence: Double
    let bbox: Bounds
}

struct OCRAlternative: Codable, Sendable { let text: String; let words: [OCRWord] }

struct OCRPage: Codable, Sendable {
    var pageNumber = 1
    let width = 1000
    let height = 1000
    let text: String
    let words: [OCRWord]
    var alternative: OCRAlternative?
}

struct RecognizedDocument: Identifiable, Sendable {
    let id = UUID()
    let pages: [String]
    var layoutPages: [OCRPage] = []
    var text: String {
        pages.enumerated().map { "Page \($0.offset + 1)\n\($0.element.isEmpty ? "No readable text found on this page." : $0.element)" }.joined(separator: "\n\n")
    }
}

enum DocumentOCRError: LocalizedError {
    case unreadable, tooManyPages, noText
    var errorDescription: String? {
        switch self {
        case .unreadable: "This document couldn’t be read. Try a clear PDF, JPEG, PNG, or HEIC image."
        case .tooManyPages: "Read text from up to 20 pages at a time. Split this document into smaller files."
        case .noText: "No readable text was found. Try a clearer scan with the entire page visible."
        }
    }
}

/// No network requests or unencrypted intermediate files. Each PDF page is released after recognition.
enum DocumentOCR {
    static func recognize(data: Data, isPDF: Bool, includeLayout: Bool = false) throws -> RecognizedDocument {
        guard !data.isEmpty, data.count <= 20 * 1_024 * 1_024 else { throw DocumentOCRError.unreadable }
        var pages: [String] = []
        var layouts: [OCRPage] = []
        if isPDF {
            guard let pdf = PDFDocument(data: data), !pdf.isLocked, pdf.pageCount > 0 else { throw DocumentOCRError.unreadable }
            guard pdf.pageCount <= 20 else { throw DocumentOCRError.tooManyPages }
            for index in 0..<pdf.pageCount {
                try Task.checkCancellation()
                let text = try autoreleasepool {
                    guard let page = pdf.page(at: index) else { throw DocumentOCRError.unreadable }
                    // A selectable text layer avoids recognition errors and unnecessary image processing.
                    if !includeLayout, page.annotations.isEmpty,
                       let text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
                       !text.unicodeScalars.contains(where: { $0.value < 32 && !CharacterSet.whitespacesAndNewlines.contains($0) }) {
                        return OCRPage(text: text, words: [])
                    }
                    guard let source = page.pageRef else { throw DocumentOCRError.unreadable }
                    let bounds = source.getBoxRect(.cropBox)
                    guard bounds.width > 0, bounds.height > 0 else { throw DocumentOCRError.unreadable }
                    let rotated = abs(source.rotationAngle) % 180 == 90
                    let width = rotated ? bounds.height : bounds.width
                    let height = rotated ? bounds.width : bounds.height
                    let scale = 3000 / max(width, height)
                    let target = CGRect(x: 0, y: 0, width: ceil(width * scale), height: ceil(height * scale))
                    guard let context = CGContext(data: nil, width: Int(target.width), height: Int(target.height),
                        bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw DocumentOCRError.unreadable }
                    context.setFillColor(CGColor(gray: 1, alpha: 1))
                    context.fill(target)
                    // CGPDFPage's drawing transform does not upscale small pages. Scale the
                    // bitmap explicitly so dense scanned forms retain readable text sizes.
                    context.scaleBy(x: scale, y: scale)
                    context.concatenate(source.getDrawingTransform(.cropBox,
                        rect: CGRect(x: 0, y: 0, width: width, height: height), rotate: 0, preserveAspectRatio: true))
                    context.drawPDFPage(source)
                    // Filled AcroForm values may exist only in annotation appearance streams.
                    // Render them just as the PDF viewer does instead of recognizing an empty form.
                    for annotation in page.annotations where annotation.shouldDisplay {
                        annotation.draw(with: .cropBox, in: context)
                    }
                    guard let image = context.makeImage() else { throw DocumentOCRError.unreadable }
                    return try recognize(image: image, includeLayout: includeLayout)
                }
                pages.append(text.text)
                var layout = text
                layout.pageNumber = index + 1
                layouts.append(layout)
            }
        } else {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 3000
                  ] as CFDictionary) else { throw DocumentOCRError.unreadable }
            let page = try recognize(image: image, includeLayout: includeLayout)
            pages = [page.text]
            layouts = [page]
        }
        try Task.checkCancellation()
        guard pages.contains(where: { !$0.isEmpty }) else { throw DocumentOCRError.noText }
        return RecognizedDocument(pages: pages, layoutPages: layouts)
    }

    private static func recognize(image: CGImage, includeLayout: Bool, verifyNumbers: Bool = true) throws -> OCRPage {
        try Task.checkCancellation()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US", "es-ES"]
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        try Task.checkCancellation()
        let candidates = (request.results ?? []).compactMap { $0.topCandidates(1).first }
        var words: [OCRWord] = []
        if includeLayout {
            for candidate in candidates {
                let text = candidate.string
                let expression = try NSRegularExpression(pattern: #"\S+"#)
                for match in expression.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                    guard let range = Range(match.range, in: text),
                          let observation = try? candidate.boundingBox(for: range) else { continue }
                    let box = observation.boundingBox
                    words.append(OCRWord(text: String(text[range]), confidence: Double(candidate.confidence) * 100,
                        bbox: .init(x0: max(0, box.minX * 1000), y0: max(0, (1 - box.maxY) * 1000),
                                    x1: min(1000, box.maxX * 1000), y1: min(1000, (1 - box.minY) * 1000))))
                }
            }
        }
        var result = OCRPage(text: candidates.map(\.string).joined(separator: "\n"), words: words)
        if includeLayout && verifyNumbers {
            let width = Int(Double(image.width) * 0.8), height = Int(Double(image.height) * 0.8)
            if let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) {
                context.interpolationQuality = .high
                context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
                if let secondImage = context.makeImage() {
                    let second = try recognize(image: secondImage, includeLayout: true, verifyNumbers: false)
                    result.alternative = OCRAlternative(text: second.text, words: second.words)
                }
            }
        }
        return result
    }
}
