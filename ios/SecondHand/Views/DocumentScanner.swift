import SwiftUI
import VisionKit
import PDFKit

struct DocumentScanner: UIViewControllerRepresentable {
    let completion: (Result<Data?, Error>) -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let completion: (Result<Data?, Error>) -> Void
        init(completion: @escaping (Result<Data?, Error>) -> Void) { self.completion = completion }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { completion(.success(nil)) }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
            completion(.failure(error))
        }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            guard scan.pageCount > 0, scan.pageCount <= 20 else { completion(.failure(DocumentOCRError.tooManyPages)); return }
            let pdf = PDFDocument()
            for index in 0..<scan.pageCount {
                let image = scan.imageOfPage(at: index)
                let scale = min(1, 2400 / max(image.size.width, image.size.height))
                let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1
                format.opaque = true
                let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
                guard let compressed = resized.jpegData(compressionQuality: 0.8), let normalized = UIImage(data: compressed),
                      let page = PDFPage(image: normalized) else { completion(.failure(DocumentOCRError.unreadable)); return }
                pdf.insert(page, at: index)
            }
            guard let bytes = pdf.dataRepresentation(), bytes.count <= 20 * 1_024 * 1_024 else {
                completion(.failure(VaultError.invalidFile)); return
            }
            completion(.success(bytes))
        }
    }
}

struct DocumentTextView: View {
    let document: SavedDocument
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var result: RecognizedDocument?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let result {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            Text("Check this text against the original before using it. Columns, checkboxes, and numbers can be misread.")
                                .font(.subheadline).foregroundStyle(.secondary)
                            ForEach(Array(result.pages.enumerated()), id: \.offset) { index, text in
                                Text("Page \(index + 1)").font(.headline)
                                Text(text.isEmpty ? "No readable text found on this page." : text)
                                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                    .accessibilityIdentifier("ocr.page.\(index + 1)")
                            }
                        }.padding(20)
                    }
                } else if let error {
                    ContentUnavailableView("Couldn’t read text", systemImage: "doc.text.magnifyingglass", description: Text(error))
                } else {
                    VStack(spacing: 16) {
                        ProgressView("Reading text on this iPhone…")
                        Text("Large documents may take a moment.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Document text")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                do { result = try await store.recognizeDocument(document) }
                catch is CancellationError { }
                catch { self.error = error.localizedDescription }
            }
            .onDisappear { result = nil }
        }
        .privacySensitive()
    }
}
