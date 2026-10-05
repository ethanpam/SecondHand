import Foundation
import Vision
import PDFKit
import ImageIO

struct RecognizedDocument: Identifiable, Sendable {
    let id = UUID()
    let pages: [String]
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
    static func recognize(data: Data, isPDF: Bool) throws -> RecognizedDocument {
        guard !data.isEmpty, data.count <= 20 * 1_024 * 1_024 else { throw DocumentOCRError.unreadable }
        var pages: [String] = []
        if isPDF {
            guard let pdf = PDFDocument(data: data), !pdf.isLocked, pdf.pageCount > 0 else { throw DocumentOCRError.unreadable }
            guard pdf.pageCount <= 20 else { throw DocumentOCRError.tooManyPages }
            for index in 0..<pdf.pageCount {
                try Task.checkCancellation()
                let text = try autoreleasepool {
                    guard let page = pdf.page(at: index) else { throw DocumentOCRError.unreadable }
                    // A selectable text layer avoids recognition errors and unnecessary image processing.
                    if let text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { return text }
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
                    guard let image = context.makeImage() else { throw DocumentOCRError.unreadable }
                    return try recognize(image: image)
                }
                pages.append(text)
            }
        } else {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 3000
                  ] as CFDictionary) else { throw DocumentOCRError.unreadable }
            pages = [try recognize(image: image)]
        }
        try Task.checkCancellation()
        guard pages.contains(where: { !$0.isEmpty }) else { throw DocumentOCRError.noText }
        return RecognizedDocument(pages: pages)
    }

    private static func recognize(image: CGImage) throws -> String {
        try Task.checkCancellation()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US", "es-ES"]
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        try Task.checkCancellation()
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
