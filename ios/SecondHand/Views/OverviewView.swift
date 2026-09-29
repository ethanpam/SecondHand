import SwiftUI

struct OverviewView: View {
    @EnvironmentObject private var store: AppStore
    @State private var editingRenewal = false
    @State private var editingProfile = false
    @State private var startingRenewal = false
    @State private var error: String?

    private var plan: RenewalPlan { store.data.renewal }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("IOWA SNAP COMPANION", systemImage: "leaf")
                            .font(.caption.weight(.semibold)).tracking(1.6)
                            .foregroundStyle(AppTheme.accent)
                        Text(store.data.profile.displayName)
                            .font(.title.bold()).foregroundStyle(AppTheme.ink)
                        Text("A little preparation. A little peace of mind.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.top, 8)

                    renewalCard

                    SectionLabel(title: "One step at a time", subtitle: "Your personal checklist for what comes next.")
                    AppCard {
                        checklistRow(symbol: "person.text.rectangle", title: "Review your information", detail: store.data.profile.reviewedAt.map { "Last confirmed \($0.formatted(date: .abbreviated, time: .omitted))" } ?? "Save your contact and household details.", complete: store.data.profile.reviewedAt != nil) {
                            editingProfile = true
                        }
                        Divider()
                        checklistRow(symbol: "calendar", title: "Add dates from your notice", detail: "Your notice sets your return-by date.", complete: plan.dueDate != nil) {
                            editingRenewal = true
                        }
                        Divider()
                        checklistRow(symbol: "doc.text", title: "Keep track after you send it", detail: "Record your confirmation and follow-up tasks.", complete: plan.status != .preparing) {
                            editingRenewal = true
                        }
                    }

                    if plan.interviewDate != nil || plan.documentsDueDate != nil {
                        AppCard {
                            SectionLabel(title: "Follow-up dates")
                            if let date = plan.interviewDate {
                                followUpRow(title: "Interview", date: date, complete: plan.interviewCompleted, includesTime: true)
                            }
                            if let date = plan.documentsDueDate {
                                followUpRow(title: "Documents due", date: date, complete: plan.documentsSubmitted, includesTime: false)
                            }
                            Button("Update follow-up tasks") { editingRenewal = true }
                                .font(.subheadline.weight(.semibold))
                                .frame(minHeight: 32)
                        }
                    }

                    AppCard {
                        HStack(alignment: .top, spacing: 14) {
                            IconBadge(symbol: "envelope.open")
                            SectionLabel(title: "Your notice is your guide", subtitle: "Follow the return instructions on your Iowa HHS notice. Renewal timing varies by household.")
                        }
                        Link(destination: IowaResources.snap) {
                            Label("Iowa HHS SNAP information", systemImage: "arrow.up.right")
                                .font(.subheadline.weight(.semibold))
                        }
                        Link(destination: IowaResources.portal) {
                            Label("Open Iowa application portal", systemImage: "safari")
                                .font(.subheadline.weight(.semibold))
                        }
                        Text("The application portal may not support your renewal. Check your notice before using it.")
                            .font(.caption).foregroundStyle(.secondary)
                    }

                    if !store.data.history.isEmpty {
                        AppCard {
                            SectionLabel(title: "Your recent activity")
                            ForEach(Array(store.data.history.prefix(4))) { entry in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(entry.title).font(.subheadline.weight(.medium))
                                    if !entry.detail.isEmpty { Text(entry.detail).font(.caption).foregroundStyle(.secondary) }
                                    Text(entry.date, format: .dateTime.month(.abbreviated).day().year())
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    LocalStorageNote()
                }
                .padding(20)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
            }
            .background(AppTheme.canvas)
            .navigationTitle("Second Hand")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $editingRenewal) { RenewalEditor() }
            .sheet(isPresented: $editingProfile) { ProfileEditor() }
            .confirmationDialog("Start a new renewal?", isPresented: $startingRenewal, titleVisibility: .visible) {
                Button("Start new renewal") {
                    Task {
                        do { try await store.startNewRenewal(); editingRenewal = true }
                        catch { self.error = error.localizedDescription }
                    }
                }
            } message: {
                Text("This clears the current dates, status, and confirmation. Your profile, documents, and activity stay saved.")
            }
            .alert("Couldn’t update your renewal", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "Please try again.") }
        }
    }

    private var renewalCard: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top) {
                Label("YOUR RENEWAL", systemImage: "calendar.badge.clock")
                    .font(.caption.weight(.semibold)).tracking(1)
                Spacer()
                Text(plan.status.title)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(.white.opacity(0.16), in: Capsule())
            }
            VStack(alignment: .leading, spacing: 8) {
                if let date = plan.dueDate {
                    Text("Return by \(date.formatted(.dateTime.month(.abbreviated).day()))")
                        .font(.title.bold())
                    Text(deadlineCaption)
                        .font(.subheadline).opacity(0.9)
                } else {
                    Text("Let’s find your\nnext deadline.")
                        .font(.title.bold()).fixedSize(horizontal: false, vertical: true)
                    Text("Have your renewal notice handy? Add its return-by date to keep it in view.")
                        .font(.subheadline).opacity(0.9).lineSpacing(3)
                }
            }
            if let endDate = plan.benefitsEndDate {
                Label("Benefits end \(endDate.formatted(date: .abbreviated, time: .omitted))", systemImage: "calendar")
                    .font(.caption)
            }
            Button { editingRenewal = true } label: {
                HStack {
                    Text(plan.dueDate == nil ? "Add renewal details" : "Manage renewal")
                    Spacer()
                    Image(systemName: "arrow.right")
                }
                .font(.subheadline.weight(.semibold))
                .padding(15)
                .foregroundStyle(Color(red: 0.13, green: 0.29, blue: 0.24))
                .background(Color(red: 0.91, green: 0.95, blue: 0.88), in: RoundedRectangle(cornerRadius: 14))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("renewal.edit")
            if plan.status == .approved {
                Button("Start another renewal") { startingRenewal = true }
                    .font(.subheadline.weight(.semibold)).underline()
            }
        }
        .padding(24)
        .foregroundStyle(.white)
        .background(LinearGradient(colors: [Color(red: 0.17, green: 0.36, blue: 0.29), Color(red: 0.10, green: 0.26, blue: 0.23)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 27))
    }

    private var deadlineCaption: String {
        guard let days = plan.daysUntilDue() else { return "Use the date on your Iowa HHS notice." }
        if days < 0 { return "The date you entered has passed. Check your notice or contact Iowa HHS." }
        if days == 0 { return "The return-by date you entered is today." }
        return "\(days) \(days == 1 ? "day" : "days") until your saved return-by date."
    }

    private func checklistRow(symbol: String, title: String, detail: String, complete: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: complete ? "checkmark.circle.fill" : symbol)
                    .font(.title3).foregroundStyle(AppTheme.accent).frame(width: 26)
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(AppTheme.ink)
                    Text(detail).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func followUpRow(title: String, date: Date, complete: Bool, includesTime: Bool) -> some View {
        HStack(alignment: .top) {
            Image(systemName: complete ? "checkmark.circle.fill" : "circle").foregroundStyle(AppTheme.accent)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(date.formatted(date: .abbreviated, time: includesTime ? .shortened : .omitted)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if complete { Text("Done").font(.caption).foregroundStyle(AppTheme.accent) }
        }
    }
}

struct RenewalEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft = RenewalPlan()
    @State private var isSaving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Copy dates from your Iowa HHS notice. The return-by date and the date benefits end can be different.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    OptionalDateField(title: "Return-by date", date: $draft.dueDate)
                    OptionalDateField(title: "Benefits end date", date: $draft.benefitsEndDate)
                } header: { Text("Dates on your notice") }
                Section {
                    Picker("Status", selection: $draft.status) {
                        ForEach(RenewalStatus.allCases) { Text($0.title).tag($0) }
                    }
                    TextField("Confirmation or reference number", text: $draft.confirmationNumber)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("Progress you report") } footer: {
                    Text("Update this yourself after taking each step. Second Hand doesn’t check your status with Iowa HHS. Mark Approved only after receiving a decision.")
                }
                Section("Follow-up tasks") {
                    OptionalDateField(title: "Interview date", date: $draft.interviewDate, includesTime: true)
                    Toggle("Interview completed", isOn: $draft.interviewCompleted)
                    OptionalDateField(title: "Documents due date", date: $draft.documentsDueDate)
                    Toggle("Requested documents submitted", isOn: $draft.documentsSubmitted)
                }
                Section {
                    Toggle("Remind me about saved dates", isOn: $draft.remindersEnabled)
                } header: { Text("Reminders") } footer: {
                    Text("Your iPhone must allow notifications. Always follow your official notice, even if a reminder doesn’t arrive.")
                }
                Section("Private notes") {
                    TextField("Questions, next steps, or mailing details", text: $draft.notes, axis: .vertical)
                        .lineLimit(4...8)
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.canvas)
            .navigationTitle("Renewal details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(isSaving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        isSaving = true
                        Task {
                            do { try await store.saveRenewal(draft); dismiss() }
                            catch { self.error = error.localizedDescription }
                            isSaving = false
                        }
                    }
                    .fontWeight(.semibold).disabled(isSaving)
                    .accessibilityIdentifier("renewal.save")
                }
            }
            .interactiveDismissDisabled(isSaving)
            .onAppear { draft = store.data.renewal }
            .alert("Couldn’t save renewal details", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "Please try again.") }
        }
    }
}
