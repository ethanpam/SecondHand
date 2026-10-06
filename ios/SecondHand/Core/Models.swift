import Foundation

struct HouseholdMember: Codable, Identifiable, Equatable {
    var id = UUID()
    var name = ""
    var relationship = ""
}

/// The applicant's own answer to Iowa's "Do you have a home address?". Never inferred.
enum HomeAddressAnswer: String, Codable, CaseIterable, Identifiable {
    case unanswered = "", yes, no
    var id: String { rawValue }
    var title: String {
        switch self {
        case .unanswered: "Not answered yet"
        case .yes: "Yes"
        case .no: "No"
        }
    }
}

struct AnnualIncomeEntry: Codable, Identifiable, Equatable {
    var id = UUID()
    var amount = ""
    var year = ""
    var source = ""
    var category = ""
    var documentID: UUID?
    var fieldID = ""
}

struct PersonalProfile: Codable, Equatable {
    var firstName = ""
    var middleName = ""
    var lastName = ""
    var email = ""
    // A legacy/general number has no known phone type and is never shared.
    var phone = ""
    var homePhone = ""
    var mobilePhone = ""
    var addressLine1 = ""
    var addressLine2 = ""
    var city = ""
    var state = "IA"
    var postalCode = ""
    var hasHomeAddress = HomeAddressAnswer.unanswered
    var household: [HouseholdMember] = []
    var ssn = ""
    var annualIncome: [AnnualIncomeEntry] = []
    var monthlyIncome = ""
    var monthlyHousingCost = ""
    var notes = ""
    var reviewedAt: Date?

    init() {}

    private enum CodingKeys: String, CodingKey {
        case firstName, middleName, lastName, email, phone, homePhone, mobilePhone
        case addressLine1, addressLine2, city, state, postalCode, hasHomeAddress, household
        case ssn, annualIncome, monthlyIncome, monthlyHousingCost, notes, reviewedAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        firstName = try values.decodeIfPresent(String.self, forKey: .firstName) ?? ""
        middleName = try values.decodeIfPresent(String.self, forKey: .middleName) ?? ""
        lastName = try values.decodeIfPresent(String.self, forKey: .lastName) ?? ""
        email = try values.decodeIfPresent(String.self, forKey: .email) ?? ""
        phone = try values.decodeIfPresent(String.self, forKey: .phone) ?? ""
        homePhone = try values.decodeIfPresent(String.self, forKey: .homePhone) ?? ""
        mobilePhone = try values.decodeIfPresent(String.self, forKey: .mobilePhone) ?? ""
        addressLine1 = try values.decodeIfPresent(String.self, forKey: .addressLine1) ?? ""
        addressLine2 = try values.decodeIfPresent(String.self, forKey: .addressLine2) ?? ""
        city = try values.decodeIfPresent(String.self, forKey: .city) ?? ""
        state = try values.decodeIfPresent(String.self, forKey: .state) ?? "IA"
        postalCode = try values.decodeIfPresent(String.self, forKey: .postalCode) ?? ""
        hasHomeAddress = try values.decodeIfPresent(HomeAddressAnswer.self, forKey: .hasHomeAddress) ?? .unanswered
        household = try values.decodeIfPresent([HouseholdMember].self, forKey: .household) ?? []
        ssn = try values.decodeIfPresent(String.self, forKey: .ssn) ?? ""
        annualIncome = try values.decodeIfPresent([AnnualIncomeEntry].self, forKey: .annualIncome) ?? []
        monthlyIncome = try values.decodeIfPresent(String.self, forKey: .monthlyIncome) ?? ""
        monthlyHousingCost = try values.decodeIfPresent(String.self, forKey: .monthlyHousingCost) ?? ""
        notes = try values.decodeIfPresent(String.self, forKey: .notes) ?? ""
        reviewedAt = try values.decodeIfPresent(Date.self, forKey: .reviewedAt)
    }

    var displayName: String { firstName.isEmpty ? "" : "Welcome back, \(firstName)" }
    var contactFields: [String: String] {
        ["firstName": firstName, "lastName": lastName,
         "addressLine1": addressLine1, "addressLine2": addressLine2, "city": city,
         "state": state, "postalCode": postalCode].filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    /// An unanswered home-address question has an empty value, so it isn't shared.
    var applicationFields: [String: String] {
        ["firstName": firstName, "middleName": middleName, "lastName": lastName,
         "email": email, "homePhone": homePhone, "mobilePhone": mobilePhone,
         "addressLine1": addressLine1, "addressLine2": addressLine2,
         "city": city, "state": state, "postalCode": postalCode, "hasHomeAddress": hasHomeAddress.rawValue,
         "monthlyIncome": monthlyIncome, "monthlyHousingCost": monthlyHousingCost]
            .filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
    /// Explicit session choices; never sum tax lines or infer monthly income.
    func applicationFields(sharingSSN: Bool, annualIncomeID: UUID?) -> [String: String] {
        var fields = applicationFields
        if sharingSSN && !ssn.isEmpty { fields["ssn"] = ssn }
        if let annualIncomeID, let entry = annualIncome.first(where: { $0.id == annualIncomeID }) {
            fields["annualIncome"] = entry.amount
            fields["annualIncomeYear"] = entry.year
        }
        return fields.filter { !$0.value.isEmpty }
    }

}

enum RenewalStatus: String, Codable, CaseIterable, Identifiable {
    case preparing, submitted, awaitingDecision, approved
    var id: String { rawValue }
    var title: String {
        switch self {
        case .preparing: "Preparing"
        case .submitted: "Submitted"
        case .awaitingDecision: "Awaiting a decision"
        case .approved: "Approved"
        }
    }
}

struct RenewalPlan: Codable, Equatable {
    var dueDate: Date?
    var benefitsEndDate: Date?
    var interviewDate: Date?
    var documentsDueDate: Date?
    var status: RenewalStatus = .preparing
    var confirmationNumber = ""
    var interviewCompleted = false
    var documentsSubmitted = false
    var remindersEnabled = false
    var notes = ""

    func daysUntilDue(now: Date = Date(), calendar: Calendar = .current) -> Int? {
        guard let dueDate else { return nil }
        return calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: dueDate)).day
    }
}

struct SavedDocument: Codable, Identifiable, Equatable, Hashable {
    var id: UUID
    var name: String
    var importedAt: Date
    var byteCount: Int
    var fileExtension: String
}

struct ActivityEntry: Codable, Identifiable, Equatable {
    var id = UUID()
    var date = Date()
    var title: String
    var detail: String
}

struct AppData: Codable, Equatable {
    var schemaVersion = 1
    var profile = PersonalProfile()
    var renewal = RenewalPlan()
    var documents: [SavedDocument] = []
    var history: [ActivityEntry] = []
    var importedReceiptIDs: [UUID] = []
    var importedReceiptConfirmations: [String] = []
    var renewalStartedAt: Date?

    init() {}

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, profile, renewal, documents, history, importedReceiptIDs, importedReceiptConfirmations, renewalStartedAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        profile = try values.decodeIfPresent(PersonalProfile.self, forKey: .profile) ?? PersonalProfile()
        renewal = try values.decodeIfPresent(RenewalPlan.self, forKey: .renewal) ?? RenewalPlan()
        documents = try values.decodeIfPresent([SavedDocument].self, forKey: .documents) ?? []
        history = try values.decodeIfPresent([ActivityEntry].self, forKey: .history) ?? []
        importedReceiptIDs = try values.decodeIfPresent([UUID].self, forKey: .importedReceiptIDs) ?? []
        importedReceiptConfirmations = try values.decodeIfPresent([String].self, forKey: .importedReceiptConfirmations) ?? []
        renewalStartedAt = try values.decodeIfPresent(Date.self, forKey: .renewalStartedAt)
    }

    /// Persist this entire change before removing the independent Safari receipt file.
    @discardableResult
    mutating func importReceipt(_ receipt: ApplicationReceipt) -> Bool {
        guard !importedReceiptIDs.contains(receipt.id) else { return false }
        importedReceiptIDs.append(receipt.id)
        let currentConfirmation = renewal.confirmationNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        let duplicateConfirmation = importedReceiptConfirmations.contains(receipt.confirmationNumber)
        if !duplicateConfirmation { importedReceiptConfirmations.append(receipt.confirmationNumber) }
        // Popup retries can use a new UUID. Consume them durably without duplicating
        // activity or downgrading the status the user has since recorded.
        if duplicateConfirmation || (currentConfirmation == receipt.confirmationNumber && renewal.status != .preparing) {
            return true
        }
        let predatesCurrentRenewal = renewalStartedAt.map { receipt.recordedAt < $0 } ?? false
        let canAttach = !predatesCurrentRenewal && renewal.status == .preparing
            && (currentConfirmation.isEmpty || currentConfirmation == receipt.confirmationNumber)
        if canAttach {
            renewal.status = .submitted
            renewal.confirmationNumber = receipt.confirmationNumber
        }
        let association = canAttach ? "Your renewal plan was marked submitted." : "Your current renewal plan was left unchanged."
        history.insert(ActivityEntry(date: receipt.recordedAt, title: "Reported from Safari",
            detail: "Confirmation: \(receipt.confirmationNumber). Entered by you in Safari. \(association) This is not an agency status sync."), at: 0)
        history = Array(history.prefix(100))
        return true
    }
}

enum IowaApplicationBridge {
    static let allowedFieldKeys: Set<String> = [
        "firstName", "middleName", "lastName", "email", "homePhone", "mobilePhone",
        "addressLine1", "addressLine2", "city", "state", "postalCode", "hasHomeAddress", "monthlyIncome", "monthlyHousingCost", "ssn", "annualIncome", "annualIncomeYear"
    ]

    static func allowsApplicationPage(_ string: String) -> Bool {
        guard string.count <= 1_000, let url = URLComponents(string: string),
              url.scheme?.lowercased() == "https", url.host?.lowercased() == "hhsservices.iowa.gov",
              url.port == nil || url.port == 443, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { return false }
        let prefix = "/apspssp/ssp.portal/applyForBenefits/"
        guard url.percentEncodedPath.hasPrefix(prefix) else { return false }
        let route = String(url.percentEncodedPath.dropFirst(prefix.count))
        guard !route.isEmpty, route.count <= 200,
              route.range(of: #"^[A-Za-z][A-Za-z0-9_-]*(/[A-Za-z][A-Za-z0-9_-]*)*$"#, options: .regularExpression) != nil else { return false }
        let compact = route.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        let blocked = ["signup", "register", "registration", "createaccount", "createanaccount", "account",
                       "profile", "login", "logon", "signin", "authentication", "password", "recovery", "logout"]
        return !blocked.contains(where: compact.contains)
    }
}

struct ApplicationReceipt: Codable, Equatable, Identifiable {
    var id: UUID
    var confirmationNumber: String
    var pageURL: String
    var recordedAt: Date

    init?(receiptID: String, confirmationNumber: String, pageURL: String, now: Date = Date()) {
        let trimmed = confirmationNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let id = UUID(uuidString: receiptID), IowaApplicationBridge.allowsApplicationPage(pageURL),
              trimmed.range(of: #"^[A-Za-z0-9][A-Za-z0-9 -]{1,78}[A-Za-z0-9]$"#, options: .regularExpression) != nil else { return nil }
        self.id = id
        self.confirmationNumber = trimmed
        self.pageURL = pageURL
        recordedAt = now
    }

    var isValid: Bool {
        guard let validated = ApplicationReceipt(receiptID: id.uuidString, confirmationNumber: confirmationNumber,
                                                 pageURL: pageURL, now: recordedAt) else { return false }
        return validated == self
    }
}

struct AutofillSession: Codable {
    var expiresAt: Date
    var fields: [String: String]
    func isValid(now: Date = Date()) -> Bool {
        guard expiresAt > now && expiresAt.timeIntervalSince(now) <= 601 else { return false }
        guard let hasHomeAddress = fields["hasHomeAddress"] else { return true }
        return hasHomeAddress == HomeAddressAnswer.yes.rawValue || hasHomeAddress == HomeAddressAnswer.no.rawValue
    }
}

enum IowaResources {
    static let portal = URL(string: "https://hhsservices.iowa.gov/apspssp/ssp.portal")!
    static let apply = URL(string: "https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap")!
    static let snap = URL(string: "https://hhs.iowa.gov/assistance-programs/food-assistance/snap")!
}
