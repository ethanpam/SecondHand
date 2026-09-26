import SwiftUI
import UniformTypeIdentifiers
import QuickLook

struct DocumentsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var importing = false
    @State private var isImporting = false
    @State private var previewURL: URL?
    @State private var documentToDelete: SavedDocument?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Keep a copy close by.")
                        .font(.title2.weight(.semibold)).foregroundStyle(AppTheme.ink)
                    Text("Save notices, supporting documents, and confirmations so they’re easy to find when you need them.")
                        .font(.subheadline).foregroundStyle(.secondary).lineSpacing(3)

                    if store.data.documents.isEmpty {
                        AppCard {
                            VStack(spacing: 20) {
                                ZStack {
                                    RoundedRectangle(cornerRadius: 23)
                                        .fill(AppTheme.softGreen).frame(width: 110, height: 125).rotationEffect(.degrees(-9))
                                    Image(systemName: "doc.text")
                                        .font(.system(size: 62, weight: .light))
                                        .foregroundStyle(AppTheme.accent)
                                }
                                .padding(.top, 12).accessibilityHidden(true)
                                VStack(spacing: 8) {
                                    Text("A home for your paperwork")
                                        .font(.title3.weight(.semibold)).foregroundStyle(AppTheme.ink)
                                    Text("Add your first document from Files.\nPDFs and images, up to 20 MB each.")
                                        .font(.subheadline).foregroundStyle(.secondary)
                                        .multilineTextAlignment(.center)
                                }
                                Button { importing = true } label: { Label("Add a document", systemImage: "plus") }
                                    .buttonStyle(PrimaryButtonStyle())
                            }
                            .frame(maxWidth: .infinity)
                        }
                    } else {
                        ForEach(store.data.documents) { document in
                            AppCard {
                                HStack(alignment: .center, spacing: 14) {
                                    IconBadge(symbol: document.fileExtension.lowercased() == "pdf" ? "doc.richtext" : "photo")
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(document.name).font(.subheadline.weight(.semibold))
                                            .foregroundStyle(AppTheme.ink).lineLimit(2)
                                        Text("\(ByteCountFormatter.string(fromByteCount: Int64(document.byteCount), countStyle: .file)) • \(document.importedAt.formatted(date: .abbreviated, time: .omitted))")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 0)
                                    Menu {
                                        Button { preview(document) } label: { Label("Preview", systemImage: "eye") }
                                        Button(role: .destructive) { documentToDelete = document } label: { Label("Delete", systemImage: "trash") }
                                    } label: {
                                        Image(systemName: "ellipsis").frame(width: 36, height: 44)
                                    }
                                    .accessibilityLabel("Actions for \(document.name)")
                                }
                                Button { preview(document) } label: {
                                    Label("Preview document", systemImage: "eye")
                                        .font(.subheadline.weight(.medium)).frame(minHeight: 30)
                                }
                            }
                        }
                        Button { importing = true } label: { Label("Add a document", systemImage: "plus") }
                            .buttonStyle(PrimaryButtonStyle()).disabled(isImporting)
                    }

                    if isImporting {
                        ProgressView("Saving a protected copy…").frame(maxWidth: .infinity).padding()
                    }

                    AppCard {
                        Label("A saved copy, ready for you", systemImage: "lock.doc")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(AppTheme.ink)
                        Text("Adding a document doesn’t send it to Iowa HHS. Submit requested documents using the instructions on your notice.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Text("If a file is stored in iCloud or another provider, downloading it first may require internet.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    LocalStorageNote()
                }
                .padding(20)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
            }
            .background(AppTheme.canvas)
            .navigationTitle("Documents")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { importing = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Add document").disabled(isImporting)
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf, .jpeg, .png, .heic]) { result in
                switch result {
                case .success(let url):
                    isImporting = true
                    Task {
                        do { try await store.importDocument(from: url) }
                        catch { self.error = error.localizedDescription }
                        isImporting = false
                    }
                case .failure(let failure): error = failure.localizedDescription
                }
            }
            .quickLookPreview($previewURL)
            .onChange(of: previewURL) { old, new in
                if old != nil && new == nil { store.cleanupPreviews() }
            }
            .confirmationDialog("Delete this saved document?", isPresented: Binding(get: { documentToDelete != nil }, set: { if !$0 { documentToDelete = nil } }), titleVisibility: .visible) {
                Button("Delete document", role: .destructive) {
                    guard let document = documentToDelete else { return }
                    do { try store.deleteDocument(document) }
                    catch { self.error = error.localizedDescription }
                    documentToDelete = nil
                }
            } message: {
                Text("This removes \(documentToDelete?.name ?? "this document") from Second Hand. Its original file remains in Files.")
            }
            .alert("Couldn’t open or save the document", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "Please try again.") }
        }
    }

    private func preview(_ document: SavedDocument) {
        do { previewURL = try store.previewDocument(document) }
        catch { self.error = error.localizedDescription }
    }
}
