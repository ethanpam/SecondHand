import SwiftUI
import UniformTypeIdentifiers
import VisionKit
import AVFoundation
import QuickLook

struct ProfileDocumentImportView: View {
    let currentProfile: PersonalProfile
    let apply: (PersonalProfile) -> Void
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var importing = false
    @State private var scanning = false
    @State private var saving = false
    @State private var selected: SavedDocument?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { importing = true } label: { Label("Upload a document", systemImage: "square.and.arrow.up") }
                        .accessibilityIdentifier("profile.document.upload")
                    Button { startScan() } label: { Label("Scan a document", systemImage: "doc.viewfinder") }
                        .disabled(!VNDocumentCameraViewController.isSupported)
                        .accessibilityIdentifier("profile.document.scan")
                    if !VNDocumentCameraViewController.isSupported {
                        Text("Camera scanning is available on a supported iPhone. You can upload a file here.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("Choose a completed 1040, W-2, 1099-NEC, or SSA-1099 to suggest profile details. You’ll review them before saving.")
                }
                Section("Saved documents") {
                    if store.data.documents.isEmpty {
                        Text("Upload or scan a document to get started.").foregroundStyle(.secondary)
                    }
                    ForEach(store.data.documents) { document in
                        Button { selected = document } label: {
                            Label(document.name, systemImage: "doc.text")
                        }
                    }
                }
                if saving { ProgressView("Saving your document…") }
            }
            .disabled(saving)
            .navigationTitle("Use a document")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .navigationDestination(item: $selected) { document in
                ProfileDocumentReviewView(document: document, currentProfile: currentProfile) { profile in
                    apply(profile)
                    dismiss()
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf, .jpeg, .png, .heic]) { result in
                switch result {
                case .success(let url):
                    saving = true
                    Task {
                        do { selected = try await store.importDocument(from: url) }
                        catch { self.error = error.localizedDescription }
                        saving = false
                    }
                case .failure(let failure): error = failure.localizedDescription
                }
            }
            .sheet(isPresented: $scanning) {
                DocumentScanner { result in
                    scanning = false
                    switch result {
                    case .success(let bytes):
                        guard let bytes else { return }
                        do {
                            selected = try store.saveDocument(bytes: bytes,
                                name: "Scan \(Date().formatted(date: .abbreviated, time: .omitted)).pdf", fileExtension: "pdf")
                        } catch { self.error = error.localizedDescription }
                    case .failure(let failure): error = failure.localizedDescription
                    }
                }.ignoresSafeArea()
            }
            .alert("Couldn’t use the document", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "Please try again.") }
        }
    }

    private func startScan() {
        Task {
            let allowed = await AVCaptureDevice.requestAccess(for: .video)
            guard store.isUnlocked else { return }
            if allowed { scanning = true }
            else { error = "Allow camera access in iPhone Settings, or upload a document from Files." }
        }
    }
}

private struct ProfileDocumentReviewView: View {
    let document: SavedDocument
    let currentProfile: PersonalProfile
    let apply: (PersonalProfile) -> Void
    @EnvironmentObject private var store: AppStore
    @State private var fields: [ProfileDocumentField] = []
    @State private var validationError: String?
    @State private var incomeYear = ""
    @State private var showingSSN = false
    @State private var analysis: ProfileDocumentAnalysis?
    @State private var recognized: RecognizedDocument?
    @State private var confirmed = false
    @State private var loading = true
    @State private var error: String?
    @State private var previewURL: URL?

    var body: some View {
        Form {
            Section {
                Text(document.name).font(.headline)
                Button("View original") {
                    do { previewURL = try store.previewDocument(document) }
                    catch { self.error = error.localizedDescription }
                }
            }
            if loading {
                ProgressView("Reading your document…")
            } else if let error {
                Section { Text(error).foregroundStyle(.secondary) }
            } else if fields.isEmpty {
                Section {
                    Text("No supported profile details found")
                    Text("Use a clear completed 1040, W-2, 1099-NEC, or SSA-1099, or enter your details manually.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            } else {
                Section {
                    ForEach($fields) { $field in
                        VStack(alignment: .leading, spacing: 8) {
                            Toggle(field.label, isOn: $field.selected)
                            if field.profileKey == "ssn" && !showingSSN {
                                SecureField("Social Security number", text: $field.value)
                                    .keyboardType(.numbersAndPunctuation).disabled(!field.selected)
                                    .accessibilityIdentifier("profile.import.ssn")
                            } else {
                                TextField(field.label, text: $field.value)
                                    .keyboardType(field.isAnnualIncome ? .decimalPad : .default)
                                    .disabled(!field.selected)
                                    .accessibilityIdentifier("profile.import.\(field.profileKey ?? field.id)")
                            }
                            if field.profileKey == "ssn" {
                                Button(showingSSN ? "Hide SSN" : "Show SSN") { showingSSN.toggle() }
                            }
                            if field.isAnnualIncome { Text("Annual amount • \(incomeYear.isEmpty ? "Confirm year below" : incomeYear)").font(.caption).foregroundStyle(.secondary) }
                            if let key = field.profileKey, let path = ProfileDocumentField.paths[key], !currentProfile[keyPath: path].isEmpty {
                                Text("Current: \(key == "ssn" ? "•••-••-" + String(currentProfile.ssn.suffix(4)) : currentProfile[keyPath: path])").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: { Text("Review detected details") } footer: {
                    Text("Check every selected value against the original. Selected details replace those fields in your draft.")
                }
                if fields.contains(where: { $0.isAnnualIncome }) {
                    Section("Annual income year") {
                        TextField("Year (confirm from document)", text: $incomeYear).keyboardType(.numberPad)
                        Text("Keep each amount’s type and source. Do not add overlapping lines or convert these historical amounts into current monthly income.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section {
                    Toggle("I checked the selected details against my document", isOn: $confirmed)
                        .accessibilityIdentifier("profile.import.confirm")
                    Button("Use selected details") {
                        guard var result = analysis else { return }
                        result.fields = fields
                        result.taxYear = incomeYear.trimmingCharacters(in: .whitespacesAndNewlines)
                        let draft = result.applying(to: currentProfile, documentID: document.id, documentName: document.name)
                        do { try AppStore.validate(draft); apply(draft) }
                        catch { self.validationError = error.localizedDescription }
                    }
                    .disabled(!confirmed || !fields.contains(where: { $0.selected && !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }))
                    .accessibilityIdentifier("profile.import.apply")
                } footer: {
                    Text("Tax-return amounts may be from a past year or include another person’s income. Enter current monthly income yourself.")
                }
            }
            if let recognized {
                DisclosureGroup("Extracted text") {
                    Text(recognized.text).font(.caption).textSelection(.enabled)
                }
            }
        }
        .navigationTitle("Review document details")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Check your details", isPresented: Binding(get: { validationError != nil }, set: { if !$0 { validationError = nil } })) {
            Button("OK", role: .cancel) { validationError = nil }
        } message: { Text(validationError ?? "") }
        .quickLookPreview($previewURL)
        .onChange(of: previewURL) { old, new in if old != nil && new == nil { store.cleanupPreviews() } }
        .task {
            do {
                let text = try await store.recognizeDocument(document, includeLayout: true)
                try Task.checkCancellation()
                let result = try ProfileDocumentParser.analyze(text)
                recognized = text
                analysis = result
                fields = result.fields
                incomeYear = result.taxYear
            } catch is CancellationError { return }
            catch { self.error = error.localizedDescription }
            loading = false
        }
        .privacySensitive()
    }
}
