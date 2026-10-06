import SwiftUI

struct ProfileView: View {
    @EnvironmentObject private var store: AppStore
    @State private var isEditing = false
    @State private var showingSSN = false
    private var profile: PersonalProfile { store.data.profile }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    AppCard {
                        HStack(alignment: .top, spacing: 16) {
                            IconBadge(symbol: "person.text.rectangle")
                            VStack(alignment: .leading, spacing: 6) {
                                Text(profile.firstName.isEmpty && profile.lastName.isEmpty ? "Your information, together" : [profile.firstName, profile.middleName, profile.lastName].filter { !$0.isEmpty }.joined(separator: " "))
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
                        SectionLabel(title: "Contact details", subtitle: "You can share your name, email, home and mobile phone, home address, and your home-address answer during a Safari application session.")
                        DetailRow(label: "Email", value: profile.email)
                        DetailRow(label: "Home phone", value: profile.homePhone)
                        DetailRow(label: "Mobile phone", value: profile.mobilePhone)
                        if !profile.phone.isEmpty { DetailRow(label: "Other phone · reference only", value: profile.phone) }
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
                        DetailRow(label: "Do you have a home address?", value: profile.hasHomeAddress == .unanswered ? "" : profile.hasHomeAddress.title)
                    }

                    AppCard {
                        SectionLabel(title: "Social Security number")
                        if profile.ssn.isEmpty {
                            Text("Not added").foregroundStyle(.secondary)
                        } else {
                            Text(showingSSN ? profile.ssn : "•••-••-" + String(profile.ssn.suffix(4)))
                                .privacySensitive()
                            Button(showingSSN ? "Hide SSN" : "Show SSN") { showingSSN.toggle() }
                        }
                    }
                    if !profile.annualIncome.isEmpty {
                        AppCard {
                            SectionLabel(title: "Annual income")
                            ForEach(profile.annualIncome) { entry in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(entry.category).font(.subheadline.weight(.semibold))
                                    Text("$\(entry.amount) • \(entry.year.isEmpty ? "Year not specified" : entry.year)")
                                    Text(entry.source).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Text("Historical document amounts. Kept separate from monthly income; overlapping amounts are not totaled.")
                                .font(.caption).foregroundStyle(.secondary)
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
                        SectionLabel(title: "Monthly amounts", subtitle: "Included when you allow application sharing. Fill only if the official question matches these monthly amounts; this is not an eligibility calculation.")
                        DetailRow(label: "Income", value: profile.monthlyIncome.isEmpty ? "" : "$\(profile.monthlyIncome)")
                        DetailRow(label: "Housing cost", value: profile.monthlyHousingCost.isEmpty ? "" : "$\(profile.monthlyHousingCost)")
                    }

                    if !profile.notes.isEmpty {
                        AppCard {
                            SectionLabel(title: "Private notes")
                            Text(profile.notes).font(.subheadline).textSelection(.enabled)
                        }
                    }
                }
                .padding(20)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
            }
            .background(AppTheme.canvas)
            .navigationTitle("Your profile")
            .sheet(isPresented: $isEditing) { ProfileEditor() }
            .onDisappear { showingSSN = false }
        }
    }
}

struct ProfileEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft = PersonalProfile()
    @State private var confirmedCurrent = false
    @State private var importingDocument = false
    @State private var loadedDraft = false
    @State private var showingSSN = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button { importingDocument = true } label: {
                        Label("Upload or scan a document", systemImage: "doc.viewfinder")
                    }
                    .accessibilityIdentifier("profile.importDocument")
                } footer: {
                    Text("Use a tax or benefit document to fill in your details, or enter them below.")
                }
                Section {
                    TextField("First name", text: $draft.firstName).textContentType(.givenName)
                        .accessibilityIdentifier("profile.firstName")
                    TextField("Middle name", text: $draft.middleName).textContentType(.middleName)
                    TextField("Last name", text: $draft.lastName).textContentType(.familyName)
                        .accessibilityIdentifier("profile.lastName")
                    TextField("Email", text: $draft.email)
                        .textContentType(.emailAddress).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("profile.email")
                    TextField("Home phone", text: $draft.homePhone)
                        .textContentType(.telephoneNumber).keyboardType(.phonePad)
                    TextField("Mobile phone", text: $draft.mobilePhone)
                        .textContentType(.telephoneNumber).keyboardType(.phonePad)
                    TextField("Other phone (reference only)", text: $draft.phone)
                        .textContentType(.telephoneNumber).keyboardType(.phonePad)
                } header: { Text("Contact") } footer: {
                    Text("Your name, email, and explicitly labeled home and mobile numbers can be shared with Safari. A previously saved general phone number stays reference-only: move it to the correct phone type yourself. Every field is optional.")
                }

                Section {
                    if showingSSN {
                        TextField("Social Security number", text: $draft.ssn).keyboardType(.numbersAndPunctuation)
                            .accessibilityIdentifier("profile.ssn")
                    } else {
                        SecureField("Social Security number", text: $draft.ssn).keyboardType(.numbersAndPunctuation)
                            .accessibilityIdentifier("profile.ssn")
                    }
                    Button(showingSSN ? "Hide SSN" : "Show SSN") { showingSSN.toggle() }
                } header: { Text("Social Security number") } footer: {
                    Text("Saved in your encrypted profile for reference when completing the application. You can include it in a temporary Iowa sharing session in Settings.")
                }

                Section {
                    Picker("Do you have a home address?", selection: $draft.hasHomeAddress) {
                        ForEach(HomeAddressAnswer.allCases) { Text($0.title).tag($0) }
                    }
                    .accessibilityIdentifier("profile.hasHomeAddress")
                    TextField("Street address", text: $draft.addressLine1).textContentType(.streetAddressLine1)
                    TextField("Apartment or unit", text: $draft.addressLine2).textContentType(.streetAddressLine2)
                    TextField("City", text: $draft.city).textContentType(.addressCity)
                    TextField("State", text: $draft.state).textContentType(.addressState)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    TextField("ZIP code", text: $draft.postalCode).textContentType(.postalCode).keyboardType(.numbersAndPunctuation)
                } header: { Text("Home address") } footer: {
                    Text("Your Yes or No answers this question on Iowa’s form. Leave it unanswered to answer it there yourself. Use your home address. Enter a different mailing address directly on the official form.")
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
                    ForEach($draft.annualIncome) { $entry in
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("Income type or document line", text: $entry.category)
                            TextField("Annual amount ($)", text: $entry.amount).keyboardType(.decimalPad)
                            TextField("Tax year", text: $entry.year).keyboardType(.numberPad)
                            TextField("Document or income source", text: $entry.source)
                        }
                    }
                    .onDelete { draft.annualIncome.remove(atOffsets: $0) }
                    Button("Add annual income") { draft.annualIncome.append(AnnualIncomeEntry()) }
                        .accessibilityIdentifier("profile.addAnnualIncome")
                } header: { Text("Annual income") } footer: {
                    Text("Keep the year and source with each amount. These entries do not change monthly income. Choose one in Settings to share with Iowa for a matching annual-income question.")
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
                } header: { Text("Monthly amounts and private notes") } footer: {
                    Text("Monthly income and housing amounts are included in an authorized application session. Written notes stay in the app. Use the official form’s instructions and review the meaning of each amount before filling it.")
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
            .onAppear {
                if !loadedDraft { draft = store.data.profile; loadedDraft = true }
            }
            .sheet(isPresented: $importingDocument) {
                ProfileDocumentImportView(currentProfile: draft) { updated in
                    draft = updated
                    confirmedCurrent = false
                }
            }
            .alert("Couldn’t save your profile", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "Please try again.") }
        }
    }
}
