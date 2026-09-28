#if DEBUG && targetEnvironment(simulator)
import SwiftUI
import WebKit

/// A visible, offline integration harness. It uses the normal encrypted sharing
/// snapshot and the production JavaScript, but does not exercise Safari's bridge.
/// AppRootView exposes it only when the Simulator is launched with --offline-qa.
struct OfflineApplicantQAView: View {
    @EnvironmentObject private var store: AppStore
    @StateObject private var model = OfflineApplicantQAModel()

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Offline Iowa form replica", systemImage: "testtube.2")
                        .font(.headline)
                    Text("Synthetic QA • No network • No submission")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(model.status)
                        .font(.subheadline).accessibilityIdentifier("qa.status")
                    if let expiresAt = model.snapshotExpiresAt {
                        Text("Encrypted sharing snapshot expires \(expiresAt.formatted(date: .omitted, time: .shortened))")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("Allow application sharing in Settings first.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    HStack {
                        Button(model.isFilling ? "Filling…" : "Fill saved details") {
                            Task { await model.fill() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!model.isReady || model.isFilling || !store.isUnlocked)
                        .accessibilityIdentifier("qa.fill")
                        Spacer()
                        Button("Review top") { model.reviewTop() }
                            .font(.subheadline)
                            .disabled(!model.isReady || model.isFilling)
                            .accessibilityIdentifier("qa.reviewTop")
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.regularMaterial)

                OfflineApplicantWebView(model: model)
                    .accessibilityIdentifier("qa.form")
                Text("Other answers remain yours to review. This is a local test, not a live Iowa application.")
                    .font(.caption2).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 8)
            }
            .navigationTitle("iPhone autofill QA")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { model.refreshSnapshot() }
            .onChange(of: store.autofillExpiresAt) { _, _ in model.refreshSnapshot() }
        }
    }
}

@MainActor
private final class OfflineApplicantQAModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    @Published private(set) var isReady = false
    @Published private(set) var isFilling = false
    @Published private(set) var status = "Loading the bundled applicant fixture…"
    @Published private(set) var snapshotExpiresAt: Date?

    // This is only the synthetic document's base URL, supplied to loadHTMLString.
    // It is never loaded from the network. Production URL checks are unchanged.
    private static let fixtureURL = URL(string: "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo")!
    private(set) var webView: WKWebView?
    private var loadingFixture = false

    func refreshSnapshot() {
        snapshotExpiresAt = (try? SecureVault.readAutofillSession())?.expiresAt
    }

    func makeWebView() -> WKWebView {
        if let webView { return webView }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let controller = configuration.userContentController
        do {
            // These resources are copied from production without modification.
            for name in ["field-mapper", "address-policy", "iowa-adapter", "application-assistant"] {
                let script = try resource(name, extension: "js")
                controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd,
                                                      forMainFrameOnly: true))
            }
        } catch {
            status = error.localizedDescription
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        webView = view
        do {
            let html = try resource("iowa-personal-information", extension: "html")
            guard html.contains("connect-src 'none'"), html.contains("form-action 'none'") else {
                throw HarnessError.message("The fixture must block network requests and form submission.")
            }
            loadingFixture = true
            view.loadHTMLString(html, baseURL: Self.fixtureURL)
        } catch {
            status = error.localizedDescription
        }
        return view
    }

    private func resource(_ name: String, extension ext: String) throws -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: ext) else {
            throw HarnessError.message("Missing offline QA resource: \(name).\(ext)")
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        // Permit only WKWebView's initial in-memory HTML load. Even a fixture
        // link or scripted navigation cannot leave this document.
        let initialURL = navigationAction.request.url
        let initial = loadingFixture && navigationAction.navigationType == .other
            && (initialURL == Self.fixtureURL || initialURL?.absoluteString == "about:blank")
        decisionHandler(initial ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadingFixture = false
        Task {
            do {
                let result = try await webView.callAsyncJavaScript("""
                    if (location.href !== expectedURL) throw new Error('Offline document URL mismatch: ' + location.href);
                    if (!globalThis.SecondHandApplication || !globalThis.SecondHandAutofill || !globalThis.SecondHandIowa)
                        throw new Error('Production autofill modules did not load.');
                    const form = document.querySelector('form#personalInformation');
                    if (!form) throw new Error('Applicant fixture missing.');
                    for (const button of form.querySelectorAll('button')) {
                        button.disabled = true;
                        button.setAttribute('aria-disabled', 'true');
                    }
                    form.addEventListener('submit', event => event.preventDefault());
                    const plan = SecondHandApplication.inspect(document, location.href);
                    if (plan.error || plan.kind !== 'known') throw new Error(plan.error || 'Unrecognized applicant fixture');
                    return { count: plan.fields.filter(field => field.key).length, url: location.href };
                    """, arguments: ["expectedURL": Self.fixtureURL.absoluteString], in: nil, contentWorld: .page)
                guard let details = result as? [String: Any], let count = details["count"] as? Int else {
                    throw HarnessError.message("Could not verify the applicant fixture.")
                }
                isReady = true
                status = "Blank replica ready • \(count) recognized fields"
                refreshSnapshot()
                print("OFFLINE_IPHONE_QA ready url=\(details["url"] ?? "") recognized=\(count)")
            } catch {
                isReady = false
                status = error.localizedDescription
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadingFixture = false
        status = error.localizedDescription
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadingFixture = false
        status = error.localizedDescription
    }

    func fill() async {
        guard let webView, isReady, !isFilling else { return }
        isFilling = true
        defer { isFilling = false }
        do {
            // Read the same encrypted, expiring App Group snapshot as Safari's
            // native handler. Never inject hardcoded profile values into the DOM.
            guard let session = try SecureVault.readAutofillSession(), session.isValid() else {
                snapshotExpiresAt = nil
                throw HarnessError.message("Sharing expired. Allow application sharing in Settings, then try again.")
            }
            snapshotExpiresAt = session.expiresAt
            let fields = session.fields.filter { IowaApplicationBridge.allowedFieldKeys.contains($0.key) }
            let result = try await webView.callAsyncJavaScript("""
                if (location.href !== expectedURL) throw new Error('Offline document URL mismatch.');
                const plan = SecondHandApplication.inspect(document, location.href);
                if (plan.error || plan.kind !== 'known') throw new Error(plan.error || 'Unrecognized applicant fixture');
                const assignments = plan.fields.filter(field => field.key && Object.hasOwn(savedFields, field.key))
                    .map(field => ({id: field.id, key: field.key}));
                if (!assignments.length) return { filled: 0, skipped: 0, total: plan.populated, noCandidates: true };
                const selected = Object.fromEntries(assignments.map(field => [field.key, savedFields[field.key]]));
                const result = await SecondHandApplication.fill(document, location.href, plan.token,
                    assignments, selected, expiresAt);
                if (result.error) throw new Error(result.error);
                const recognized = SecondHandAutofill.candidates(document, true);
                const total = Array.from(recognized.values()).filter(matches => matches.length === 1 && matches[0].value.trim()).length;
                const untouched = ['suffix','maidenName','sameAddress1','sameAddress2','applicant1','applicant2','snap','medicaid','tanf']
                    .every(id => { const field = document.getElementById(id); return field &&
                        (['radio','checkbox'].includes(field.type) ? !field.checked : !field.value); });
                return { filled: result.filled, skipped: result.skipped, total, unsupportedUntouched: untouched };
                """, arguments: ["expectedURL": Self.fixtureURL.absoluteString,
                                  "savedFields": fields,
                                  "expiresAt": session.expiresAt.timeIntervalSince1970 * 1_000],
                in: nil, contentWorld: .page)
            guard let details = result as? [String: Any], let filled = details["filled"] as? Int,
                  let skipped = details["skipped"] as? Int, let total = details["total"] as? Int else {
                throw HarnessError.message("Autofill did not return a verifiable result.")
            }
            if details["noCandidates"] as? Bool == true {
                status = "No empty saved fields • \(total) fields already present"
            } else {
                status = "\(filled) filled • \(skipped) skipped • \(total) saved fields present"
            }
            print("OFFLINE_IPHONE_QA result=\(details)")
        } catch {
            status = error.localizedDescription
        }
    }

    func reviewTop() {
        webView?.evaluateJavaScript("window.scrollTo({top: 0, behavior: 'smooth'})")
    }

    private enum HarnessError: LocalizedError {
        case message(String)
        var errorDescription: String? {
            switch self { case .message(let message): return message }
        }
    }
}

private struct OfflineApplicantWebView: UIViewRepresentable {
    let model: OfflineApplicantQAModel
    func makeUIView(context: Context) -> WKWebView { model.makeWebView() }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#endif
