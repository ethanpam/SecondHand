import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var error: String?
    @State private var deletingData = false
    @State private var isWorking = false
    @State private var editingProfile = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    AppCard {
                        HStack(alignment: .top, spacing: 14) {
                            IconBadge(symbol: "safari")
                            SectionLabel(title: "A little less typing", subtitle: "Bring your saved contact details into supported Iowa application fields in Safari.")
                        }
                        VStack(alignment: .leading, spacing: 14) {
                            setupStep(1, title: "Enable the extension", detail: "In iPhone Settings, open Safari → Extensions → Second Hand and turn it on. On some iOS versions, Safari is under Apps.")
                            setupStep(2, title: "Allow contact autofill below", detail: "Review your profile, then share a temporary copy of your contact and address fields with the extension.")
                            setupStep(3, title: "Open the Iowa portal in Safari", detail: "Sign in yourself. Open Second Hand from Safari’s page menu, allow access to the Iowa site, choose Preview fields, then Fill. Review every answer before you submit.")
                        }
                        Text("Safari only. Chrome on iPhone doesn’t support this extension. Autofill is assisted and may not recognize every field.")
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
                                        Text("Contact access ends in")
                                        Text(expiry, style: .timer).monospacedDigit()
                                    }
                                    .font(.subheadline.weight(.medium)).foregroundStyle(AppTheme.accent)
                                    Button("Revoke contact access now", role: .destructive) {
                                        do { try store.revokeAutofill() }
                                        catch { self.error = error.localizedDescription }
                                    }
                                    .font(.subheadline.weight(.semibold)).frame(minHeight: 32)
                                }
                            } else {
                                Button {
                                    isWorking = true
                                    Task {
                                        do { try await store.authorizeAutofill() }
                                        catch { self.error = error.localizedDescription }
                                        isWorking = false
                                    }
                                } label: {
                                    if isWorking { ProgressView().frame(maxWidth: .infinity) }
                                    else { Label("Allow contact autofill for 10 minutes", systemImage: "checkmark.shield") }
                                }
                                .buttonStyle(PrimaryButtonStyle())
                                .disabled(isWorking || store.data.profile.reviewedAt == nil || store.data.profile.contactFields.isEmpty)
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
                        Text("Only your first and last name and home address are shared. Email, phone, household notes, income, and documents stay in the app. Filled information becomes accessible to the website; revoking access doesn’t clear fields already filled.")
                            .font(.caption).foregroundStyle(.secondary)
                    }

                    AppCard {
                        HStack(alignment: .top, spacing: 14) {
                            IconBadge(symbol: "lock.shield")
                            SectionLabel(title: "Private by design", subtitle: "Your profile and documents are saved locally with encryption. Second Hand has no account or cloud sync.")
                        }
                        Text("The app locks when it goes into the background. Website access and submitting an application require internet. Second Hand never submits an application for you.")
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
