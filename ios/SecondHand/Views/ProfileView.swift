import SwiftUI

struct ProfileView: View {
    @EnvironmentObject private var store: AppStore
    @State private var isEditing = false
    private var profile: PersonalProfile { store.data.profile }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    AppCard {
                        HStack(alignment: .top, spacing: 16) {
                            IconBadge(symbol: "person.text.rectangle")
                            VStack(alignment: .leading, spacing: 6) {
                                Text(profile.firstName.isEmpty && profile.lastName.isEmpty ? "Your information, together" : "\(profile.firstName) \(profile.lastName)".trimmingCharacters(in: .whitespaces))
                                    .font(.title2.weight(.semibold)).foregroundStyle(AppTheme.ink)
                                Text("A private place for the details you use again.")
                                    .font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                        if let date = profile.reviewedAt {
                            Label("Confirmed current \(date.formatted(date: .abbreviated, time: .omitted))", systemImage: "checkmark.shield")
                                .font(.caption).foregroundStyle(AppTheme.accent)
                        } else {
                            Text("Start with your contact details. You can add household information when you’re ready.")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        Button { isEditing = true } label: {
                            Text(profile.reviewedAt == nil ? "Set up my profile" : "Review & edit information")
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .accessibilityIdentifier("profile.edit")
                    }

                    AppCard {
                        SectionLabel(title: "Contact details", subtitle: "Safari autofill currently supports your name and home address. Email and phone stay here for reference.")
                        DetailRow(label: "Email", value: profile.email)
                        DetailRow(label: "Phone", value: profile.phone)
                        Divider()
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Home address").font(.subheadline).foregroundStyle(.secondary)
                            if profile.addressLine1.isEmpty {
                                Text("Not added").font(.subheadline).foregroundStyle(.secondary)
                            } else {
                                Text([profile.addressLine1, profile.addressLine2, "\(profile.city), \(profile.state) \(profile.postalCode)"].filter { !$0.isEmpty }.joined(separator: "\n"))
                                    .font(.subheadline).foregroundStyle(AppTheme.ink)
                                    .textSelection(.enabled)
                            }
                        }
                    }

                    AppCard {
                        SectionLabel(title: "Household", subtitle: "Saved for your reference. Not shared with Safari autofill.")
                        if profile.household.isEmpty {
                            Label("No household members added", systemImage: "person.2")
                                .font(.subheadline).foregroundStyle(.secondary)
                        } else {
                            ForEach(profile.household) { member in
                                DetailRow(label: member.name.isEmpty ? "Unnamed member" : member.name, value: member.relationship)
                            }
                        }
                    }

                    AppCard {
                        SectionLabel(title: "Monthly amounts", subtitle: "Your notes, not an eligibility calculation.")
                        DetailRow(label: "Income", value: profile.monthlyIncome.isEmpty ? "" : "$\(profile.monthlyIncome)")
                        DetailRow(label: "Housing cost", value: profile.monthlyHousingCost.isEmpty ? "" : "$\(profile.monthlyHousingCost)")
                    }

                    if !profile.notes.isEmpty {
                        AppCard {
                            SectionLabel(title: "Private notes")
                            Text(profile.notes).font(.subheadline).textSelection(.enabled)
                        }
                    }
                    LocalStorageNote()
                }
                .padding(20)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
            }
            .background(AppTheme.canvas)
            .navigationTitle("Your profile")
            .sheet(isPresented: $isEditing) { ProfileEditor() }
        }
    }
}

struct ProfileEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft = PersonalProfile()
    @State private var confirmedCurrent = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("First name", text: $draft.firstName).textContentType(.givenName)
                        .accessibilityIdentifier("profile.firstName")
                    TextField("Last name", text: $draft.lastName).textContentType(.familyName)
                        .accessibilityIdentifier("profile.lastName")
                    TextField("Email", text: $draft.email)
                        .textContentType(.emailAddress).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("profile.email")
                    TextField("Phone", text: $draft.phone)
                        .textContentType(.telephoneNumber).keyboardType(.phonePad)
                } header: { Text("Contact") } footer: {
                    Text("Only your first and last name and home address can be made available to Safari autofill. Every field is optional.")
                }

                Section {
                    TextField("Street address", text: $draft.addressLine1).textContentType(.streetAddressLine1)
                    TextField("Apartment or unit", text: $draft.addressLine2).textContentType(.streetAddressLine2)
                    TextField("City", text: $draft.city).textContentType(.addressCity)
                    TextField("State", text: $draft.state).textContentType(.addressState)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    TextField("ZIP code", text: $draft.postalCode).textContentType(.postalCode).keyboardType(.numbersAndPunctuation)
                } header: { Text("Home address") } footer: {
                    Text("Use your home address. Enter a different mailing address directly on the official form.")
                }

                Section {
                    ForEach($draft.household) { $member in
                        VStack(alignment: .leading, spacing: 12) {
                            TextField("Member name", text: $member.name).textContentType(.name)
                            TextField("Relationship to you", text: $member.relationship)
                        }
                        .padding(.vertical, 5)
                    }
                    .onDelete { draft.household.remove(atOffsets: $0) }
                    Button {
                        draft.household.append(HouseholdMember())
                    } label: { Label("Add household member", systemImage: "plus.circle") }
                } header: { Text("Household notes") } footer: {
                    Text("Add people relevant to your application. Swipe left to remove a member. This list is for your reference and doesn’t determine your SNAP household.")
                }

                Section {
                    LabeledContent("Monthly income ($)") {
                        TextField("Optional", text: $draft.monthlyIncome).keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Monthly housing ($)") {
                        TextField("Optional", text: $draft.monthlyHousingCost).keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    TextField("Notes about income, expenses, or changes", text: $draft.notes, axis: .vertical)
                        .lineLimit(3...8)
                } header: { Text("Private financial notes") } footer: {
                    Text("These notes stay in the app. Use the official form’s instructions to report income and deductions.")
                }

                Section {
                    Toggle("I reviewed these details and they are current", isOn: $confirmedCurrent)
                        .accessibilityIdentifier("profile.confirmed")
                } footer: {
                    Text("Confirm what you entered before saving. Review it again whenever your circumstances change.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.canvas)
            .navigationTitle("Review your profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        do {
                            draft.reviewedAt = Date()
                            try store.saveProfile(draft)
                            dismiss()
                        } catch { self.error = error.localizedDescription }
                    }
                    .fontWeight(.semibold).disabled(!confirmedCurrent)
                    .accessibilityIdentifier("profile.save")
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
                }
            }
            .onAppear { draft = store.data.profile }
            .alert("Couldn’t save your profile", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "Please try again.") }
        }
    }
}
