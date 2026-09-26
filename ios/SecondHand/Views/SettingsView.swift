import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var error: String?
    @State private var deletingData = false
    @State private var isWorking = false
    @State private var editingProfile = false
    @State private var authorizingApplication = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    AppCard {
                        HStack(alignment: .top, spacing: 14) {
                            IconBadge(symbol: "safari")
                            SectionLabel(title: "Your application, with a hand", subtitle: "Start a guided application in Safari using the information you choose to share.")
                        }
                        VStack(alignment: .leading, spacing: 14) {
                            setupStep(1, title: "Enable the extension", detail: "In iPhone Settings, open Safari → Extensions → Second Hand and turn it on. On some iOS versions, Safari is under Apps.")
                            setupStep(2, title: "Allow application sharing below", detail: "Review your profile, then approve a temporary copy of your contact details, home address, monthly income, and monthly housing amount.")
                            setupStep(3, title: "Start in Safari", detail: "Open the Iowa portal and sign in yourself. Open Second Hand from Safari’s page menu, allow access to the Iowa site, and start the guided application. It fills recognized empty fields and pauses when it needs you.")
                            setupStep(4, title: "Review and approve submission", detail: "Answer unsupported questions and handle verification, uploads, signatures, and consent yourself. Review the application, then explicitly approve its final submission in the extension. Enter the confirmation number from Iowa’s receipt to save it in Second Hand.")
                        }
                        Text("Safari only. This is an assisted application, with support for recognized pages. It doesn’t guarantee a completed application or automatic yearly renewal. Chrome on iPhone doesn’t support this extension.")
                            .font(.caption).foregroundStyle(.secondary)
                    }

                    AppCard {
                        SectionLabel(title: "You choose when to share")
                        if let reviewed = store.data.profile.reviewedAt {
                            Label("Profile reviewed \(reviewed.formatted(date: .abbreviated, time: .omitted))", systemImage: "checkmark.shield")
                                .font(.caption).foregroundStyle(AppTheme.accent)
                        } else {
                            Text("Review your profile today before allowing autofill.")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            if let expiry = store.autofillExpiresAt, expiry > context.date {
                                VStack(alignment: .leading, spacing: 12) {
                                    HStack {
                                        Image(systemName: "clock")
                                        Text("Application access ends in")
                                        Text(expiry, style: .timer).monospacedDigit()
                                    }
                                    .font(.subheadline.weight(.medium)).foregroundStyle(AppTheme.accent)
                                    Button("Revoke application access now", role: .destructive) {
                                        do { try store.revokeAutofill() }
                                        catch { self.error = error.localizedDescription }
                                    }
                                    .font(.subheadline.weight(.semibold)).frame(minHeight: 32)
                                }
                            } else {
                                Button {
                                    authorizingApplication = true
                                } label: {
                                    if isWorking { ProgressView().frame(maxWidth: .infinity) }
                                    else { Label("Allow application sharing for 10 minutes", systemImage: "checkmark.shield") }
                                }
                                .buttonStyle(PrimaryButtonStyle())
                                .accessibilityIdentifier("application.authorize")
                                .disabled(isWorking || store.data.profile.reviewedAt == nil || store.data.profile.applicationFields.isEmpty)
                            }
                        }
                        Button("Review my profile") { editingProfile = true }
                            .font(.subheadline.weight(.semibold)).frame(minHeight: 32)
                        Text("For your privacy, autofill requires a profile review within the last 24 hours.")
                            .font(.caption).foregroundStyle(.secondary)
                        Link(destination: IowaResources.portal) {
                            Label("Open Iowa application portal", systemImage: "arrow.up.right")
                                .font(.subheadline.weight(.semibold))
                        }
                        Text("The link opens your default browser. If that isn’t Safari, open this address in Safari to use the extension.")
                            .font(.caption).foregroundStyle(.secondary)
                        Text("Shared for 10 minutes: first, middle, and last name; email; home and mobile phone; home address; monthly income; monthly housing cost. General phone, household notes, written notes, and documents stay in the app. The website can save information as it is filled, before final submission. Revoking access doesn’t clear fields or withdraw information already sent.")
                            .font(.caption).foregroundStyle(.secondary)
                    }

                    AppCard {
                        HStack(alignment: .top, spacing: 14) {
                            IconBadge(symbol: "lock.shield")
                            SectionLabel(title: "Private by design", subtitle: "Your profile and documents are saved locally with encryption. Second Hand has no account or cloud sync.")
                        }
                        Text("The app locks when it goes into the background. Website access and submitting an application require internet. The extension needs your explicit approval before a final submission; it never supplies your electronic signature or consent.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Text("A saved confirmation is reported from Safari, not a status update from Iowa HHS. Check the official website and notices for your case’s status.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Text("There is no automatic backup or recovery. Keep your original documents. Losing this iPhone or deleting the app can lose your saved information.")
                            .font(.caption).foregroundStyle(.secondary)
                        Button { store.lock() } label: { Label("Lock now", systemImage: "lock") }
                            .font(.subheadline.weight(.semibold)).frame(minHeight: 32)
                    }

                    AppCard {
                        SectionLabel(title: "Official help")
                        Link(destination: IowaResources.snap) { Label("Iowa HHS SNAP information", systemImage: "arrow.up.right") }
                        Link(destination: IowaResources.apply) { Label("How to apply in Iowa", systemImage: "arrow.up.right") }
                        Link(destination: URL(string: "tel:8773475678")!) { Label("Call Iowa HHS · 877-347-5678", systemImage: "phone") }
                        Text("Use the renewal instructions and dates on your official notice. This app doesn’t determine eligibility, verify status, or replace communication from Iowa HHS.")
                            .font(.caption).foregroundStyle(.secondary)
                    }

                    AppCard {
                        SectionLabel(title: "Your data, your choice")
                        Text("Delete your saved profile, documents, renewal details, and local reminders from this app.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Button("Delete all app data", role: .destructive) { deletingData = true }
                            .font(.subheadline.weight(.semibold)).frame(minHeight: 32).disabled(isWorking)
                    }
                    VStack(spacing: 5) {
                        Text("Second Hand").font(.subheadline.weight(.semibold))
                        Text("Independent app · Not affiliated with Iowa HHS")
                            .font(.caption).multilineTextAlignment(.center)
                    }
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 10)
                }
                .padding(20)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
            }
            .background(AppTheme.canvas)
            .navigationTitle("Settings")
            .sheet(isPresented: $editingProfile) { ProfileEditor() }
            .confirmationDialog("Share application details for 10 minutes?", isPresented: $authorizingApplication, titleVisibility: .visible) {
                Button("Allow application sharing") {
                    isWorking = true
                    Task {
                        do { try await store.authorizeAutofill() }
                        catch { self.error = error.localizedDescription }
                        isWorking = false
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This includes name, email, home and mobile phone, home address, monthly income, and monthly housing cost. Iowa’s website can save filled information before submission. You still review answers and approve final submission.")
            }
            .confirmationDialog("Permanently delete all app data?", isPresented: $deletingData, titleVisibility: .visible) {
                Button("Delete all app data", role: .destructive) {
                    isWorking = true
                    Task {
                        do { try await store.deleteAllData() }
                        catch { self.error = error.localizedDescription }
                        isWorking = false
                    }
                }
            } message: {
                Text("This cannot be undone. It removes the data stored by Second Hand and revokes autofill access. It doesn’t withdraw an application or delete information already sent to Iowa HHS.")
            }
            .alert("Couldn’t complete that action", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "Please try again.") }
        }
    }

    private func setupStep(_ number: Int, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)").font(.caption.weight(.bold))
                .foregroundStyle(AppTheme.accent)
                .frame(width: 25, height: 25).background(AppTheme.softGreen, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(AppTheme.ink)
                Text(detail).font(.caption).foregroundStyle(.secondary).lineSpacing(2)
            }
        }
    }
}
