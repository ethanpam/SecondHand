import Foundation

struct HouseholdMember: Codable, Identifiable, Equatable {
    var id = UUID()
    var name = ""
    var relationship = ""
}

struct PersonalProfile: Codable, Equatable {
    var firstName = ""
    var lastName = ""
    var email = ""
    var phone = ""
    var addressLine1 = ""
    var addressLine2 = ""
    var city = ""
    var state = "IA"
    var postalCode = ""
    var household: [HouseholdMember] = []
    var monthlyIncome = ""
    var monthlyHousingCost = ""
    var notes = ""
    var reviewedAt: Date?

    var displayName: String { firstName.isEmpty ? "Your next step starts here" : "Welcome back, \(firstName)" }
    var contactFields: [String: String] {
        ["firstName": firstName, "lastName": lastName,
         "addressLine1": addressLine1, "addressLine2": addressLine2, "city": city,
         "state": state, "postalCode": postalCode].filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
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

struct SavedDocument: Codable, Identifiable, Equatable {
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
}

struct AutofillSession: Codable {
    var expiresAt: Date
    var fields: [String: String]
    func isValid(now: Date = Date()) -> Bool { expiresAt > now && expiresAt.timeIntervalSince(now) <= 601 }
}

enum IowaResources {
    static let portal = URL(string: "https://hhsservices.iowa.gov/apspssp/ssp.portal")!
    static let apply = URL(string: "https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap")!
    static let snap = URL(string: "https://hhs.iowa.gov/assistance-programs/food-assistance/snap")!
}
