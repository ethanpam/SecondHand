import Foundation
import Combine
import LocalAuthentication
import UniformTypeIdentifiers
import UserNotifications

enum AppError: LocalizedError {
    case locked, notificationsDisabled, noContact, reviewRequired, invalidProfile(String), documentLimit, busy
    var errorDescription: String? {
        switch self {
        case .locked: "Unlock Second Hand to access your information."
        case .notificationsDisabled: "Reminders are disabled in iPhone Settings. Allow notifications for Second Hand, or save with reminders switched off."
        case .noContact: "Add your name and contact information to your profile first."
        case .reviewRequired: "Review your profile and confirm it is current before enabling autofill."
        case .invalidProfile(let message): message
        case .documentLimit: "You can keep up to 50 documents. Remove an older file before adding another."
        case .busy: "Your previous change is still being saved. Please try again in a moment."
        }
    }
}

@MainActor
final class AppStore: ObservableObject {
    @Published private(set) var data = AppData()
    @Published private(set) var isUnlocked = false
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published private(set) var autofillExpiresAt: Date?
    private var vault: SecureVault?
    private var authContext: LAContext?
    private var unlockGeneration = 0
    private var renewalSaveInFlight = false
    private var persistedRenewal = RenewalPlan()
    private var reminderRevision = 0
    private let previewDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("SecondHandPreviews", isDirectory: true)

    func unlock() async {
        guard !isUnlocked, !isLoading else { return }
        isLoading = true
        let generation = unlockGeneration
        defer { isLoading = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            let isUITesting = ProcessInfo.processInfo.arguments.contains("--ui-testing")
            #else
            let isUITesting = false
            #endif
            if !isUITesting {
                let context = LAContext()
                authContext = context
                var error: NSError?
                guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
                    throw error ?? AppError.locked as NSError
                }
                let accepted = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock your saved profile and documents.")
                guard accepted else { throw AppError.locked }
            }
            guard generation == unlockGeneration else { return }
            let storage = try SecureVault.local()
            let restored = try storage.load()
            cleanupPreviews()
            vault = storage
            data = restored
            persistedRenewal = restored.renewal
            reminderRevision += 1
            isUnlocked = true
            errorMessage = nil
            // The vault still works if a development build has not configured the extension capability.
            autofillExpiresAt = try? SecureVault.readAutofillSession()?.expiresAt
        } catch {
            errorMessage = error.localizedDescription
        }
        authContext = nil
    }

    func lock() {
        unlockGeneration += 1
        authContext?.invalidate()
        authContext = nil
        cleanupPreviews()
        data = AppData()
        vault = nil
        isUnlocked = false
        // A user-authorized contact session intentionally survives switching to Safari until its expiry.
    }

    private func storage() throws -> SecureVault {
        guard isUnlocked, let vault else { throw AppError.locked }
        return vault
    }

    private func commit(_ next: AppData) throws {
        try storage().save(next)
        data = next
        persistedRenewal = next.renewal
        reminderRevision += 1
    }

    private func addingActivity(_ title: String, detail: String, to next: inout AppData) {
        next.history.insert(ActivityEntry(title: title, detail: detail), at: 0)
        next.history = Array(next.history.prefix(100))
    }

    static func validate(_ profile: PersonalProfile) throws {
        let strings = [profile.firstName, profile.lastName, profile.email, profile.phone, profile.addressLine1,
                       profile.addressLine2, profile.city, profile.postalCode]
        guard strings.allSatisfy({ $0.count <= 250 }), profile.notes.count <= 10_000,
              profile.household.count <= 30, profile.household.allSatisfy({ $0.name.count <= 250 && $0.relationship.count <= 250 }) else {
            throw AppError.invalidProfile("One of your entries is too long. Shorten it and try again.")
        }
        if !profile.email.isEmpty && (!profile.email.contains("@") || profile.email.contains(" ")) {
            throw AppError.invalidProfile("Enter a valid email address, or leave it blank.")
        }
        if !profile.postalCode.isEmpty && profile.postalCode.range(of: #"^\d{5}(-\d{4})?$"#, options: .regularExpression) == nil {
            throw AppError.invalidProfile("Enter a five-digit ZIP code, optionally followed by four more digits.")
        }
        for value in [profile.monthlyIncome, profile.monthlyHousingCost] where !value.isEmpty {
            guard value.range(of: #"^\d{1,9}(\.\d{1,2})?$"#, options: .regularExpression) != nil else {
                throw AppError.invalidProfile("Enter monthly amounts as numbers, such as 1250 or 1250.50, without a dollar sign or commas.")
            }
        }
    }

    func saveProfile(_ profile: PersonalProfile) throws {
        try Self.validate(profile)
        var next = data
        next.profile = profile
        addingActivity("Profile updated", detail: profile.reviewedAt == nil ? "Saved on this device." : "You confirmed your information is current.", to: &next)
        // A profile change invalidates any previously shared contact snapshot.
        if autofillExpiresAt != nil { try revokeAutofill() }
        try commit(next)
    }

    func saveRenewal(_ plan: RenewalPlan) async throws {
        _ = try storage()
        guard !renewalSaveInFlight else { throw AppError.busy }
        renewalSaveInFlight = true
        defer { renewalSaveInFlight = false }
        let generation = unlockGeneration
        let previous = data.renewal
        do {
            try await ReminderScheduler.synchronize(plan, isCurrent: { self.isUnlocked && generation == self.unlockGeneration })
            guard isUnlocked, generation == unlockGeneration else { throw AppError.locked }
            var next = data
            next.renewal = plan
            addingActivity(previous.status == plan.status ? "Renewal plan updated" : plan.status.title,
                           detail: "Recorded by you. Check your Iowa HHS notice for official case information.", to: &next)
            try commit(next)
        } catch {
            await restoreReminders()
            throw error
        }
    }

    private func restoreReminders() async {
        var revision: Int
        repeat {
            revision = reminderRevision
            let expected = revision
            try? await ReminderScheduler.synchronize(persistedRenewal, isCurrent: { self.reminderRevision == expected })
        } while revision != reminderRevision
    }

    func authorizeAutofill() async throws {
        _ = try storage()
        guard !data.profile.firstName.isEmpty || !data.profile.lastName.isEmpty else { throw AppError.noContact }
        guard let reviewed = data.profile.reviewedAt, reviewed <= Date(), Date().timeIntervalSince(reviewed) < 24 * 60 * 60 else {
            throw AppError.reviewRequired
        }
        let expiry = Date().addingTimeInterval(10 * 60)
        try SecureVault.writeAutofillSession(AutofillSession(expiresAt: expiry, fields: data.profile.contactFields))
        autofillExpiresAt = expiry
    }

    func revokeAutofill() throws {
        try SecureVault.revokeAutofillSession()
        autofillExpiresAt = nil
    }

    func importDocument(from url: URL) async throws {
        let vault = try storage()
        guard data.documents.count < 50 else { throw AppError.documentLimit }
        let allowed = url.startAccessingSecurityScopedResource()
        defer { if allowed { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey, .isRegularFileKey])
        guard values.isRegularFile == true, let size = values.fileSize, size > 0, size <= 20 * 1_024 * 1_024,
              let type = values.contentType, type.conforms(to: .pdf) || type.conforms(to: .image) else { throw VaultError.invalidFile }
        let bytes = try Data(contentsOf: url)
        guard bytes.count <= 20 * 1_024 * 1_024 else { throw VaultError.invalidFile }
        let document = SavedDocument(id: UUID(), name: String(url.lastPathComponent.prefix(250)), importedAt: Date(),
                                     byteCount: bytes.count, fileExtension: type.preferredFilenameExtension ?? "dat")
        let filename = "\(document.id.uuidString).sealed"
        try vault.write(bytes, named: filename)
        do {
            var next = data
            next.documents.insert(document, at: 0)
            addingActivity("Document saved", detail: "Stored on this device. It has not been sent to Iowa HHS.", to: &next)
            try commit(next)
        } catch {
            try? vault.remove(named: filename)
            throw error
        }
    }

    func deleteDocument(_ document: SavedDocument) throws {
        let vault = try storage()
        let previous = data
        var next = data
        next.documents.removeAll { $0.id == document.id }
        try commit(next)
        do {
            try vault.remove(named: "\(document.id.uuidString).sealed")
            cleanupPreviews()
        } catch {
            try? commit(previous)
            throw error
        }
    }

    func previewDocument(_ document: SavedDocument) throws -> URL {
        let vault = try storage()
        guard data.documents.contains(where: { $0.id == document.id }),
              let bytes = try vault.read(named: "\(document.id.uuidString).sealed") else { throw VaultError.invalidFile }
        cleanupPreviews()
        try SecureVault.prepareDirectory(previewDirectory)
        let url = previewDirectory.appendingPathComponent(document.id.uuidString).appendingPathExtension(document.fileExtension)
        try bytes.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    func cleanupPreviews() {
        if FileManager.default.fileExists(atPath: previewDirectory.path) { try? FileManager.default.removeItem(at: previewDirectory) }
    }

    func startNewRenewal() async throws {
        _ = try storage()
        guard !renewalSaveInFlight else { throw AppError.busy }
        renewalSaveInFlight = true
        defer { renewalSaveInFlight = false }
        let generation = unlockGeneration
        do {
            try await ReminderScheduler.synchronize(RenewalPlan(), isCurrent: { self.isUnlocked && generation == self.unlockGeneration })
            guard isUnlocked, generation == unlockGeneration else { throw AppError.locked }
            var next = data
            let previous = next.renewal
            let date = previous.dueDate?.formatted(date: .abbreviated, time: .omitted) ?? "No return-by date"
            addingActivity("Previous renewal archived", detail: "\(date) · \(previous.status.title)" + (previous.confirmationNumber.isEmpty ? "" : " · Confirmation: \(previous.confirmationNumber)"), to: &next)
            next.renewal = RenewalPlan()
            try commit(next)
        } catch {
            await restoreReminders()
            throw error
        }
    }

    func deleteAllData() async throws {
        let storage = try storage()
        // Never retain a key or stale in-memory records after destructive work, even on partial failure.
        defer { lock() }
        do {
            try storage.deleteAll()
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            persistedRenewal = RenewalPlan()
            reminderRevision += 1
            autofillExpiresAt = nil
        } catch {
            errorMessage = "Some data could not be removed. Unlock the app and try deleting it again."
            throw error
        }
    }
}
