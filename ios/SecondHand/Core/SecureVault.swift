import Foundation
import CryptoKit
import Security

enum VaultError: LocalizedError {
    case keychain(OSStatus), unavailable, invalidSession, invalidFile, futureVersion
    var errorDescription: String? {
        switch self {
        case .keychain: "Your protected storage could not be opened. Unlock your device and try again."
        case .unavailable: "Shared storage is unavailable. Check the app’s App Groups and signing configuration in Xcode."
        case .invalidSession: "Open Second Hand and authorize a new autofill session."
        case .invalidFile: "This file could not be read. Choose a PDF or image smaller than 20 MB."
        case .futureVersion: "This data was saved by a newer version of Second Hand. Update the app to open it."
        }
    }
}

/// Files are individually authenticated and encrypted. Keys are device-only and unavailable while locked.
final class SecureVault {
    static let appGroup = "group.com.ethanpam.secondhand"
    private static let service = "com.ethanpam.secondhand.vault"
    private static let account = "encryption-key-v1"
    let directory: URL
    private let key: SymmetricKey

    init(directory: URL, key: SymmetricKey) throws {
        self.directory = directory
        self.key = key
        try Self.prepareDirectory(directory)
    }

    static func local() throws -> SecureVault {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("SecondHand", isDirectory: true)
        return try SecureVault(directory: root, key: loadKey())
    }

    private static func shared() throws -> SecureVault {
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { throw VaultError.unavailable }
        return try SecureVault(directory: root.appendingPathComponent("Autofill", isDirectory: true), key: loadKey())
    }

    static func prepareDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete])
        var resourceURL = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try resourceURL.setResourceValues(values)
    }

    private static var keyQuery: [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        if let group = Bundle.main.object(forInfoDictionaryKey: "SharedKeychainGroup") as? String,
           !group.isEmpty, !group.contains("$(") {
            query[kSecAttrAccessGroup as String] = group
        }
        return query
    }

    private static func loadKey() throws -> SymmetricKey {
        var query = keyQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let result = SecItemCopyMatching(query as CFDictionary, &item)
        if result == errSecSuccess, let bytes = item as? Data { return SymmetricKey(data: bytes) }
        guard result == errSecItemNotFound else { throw VaultError.keychain(result) }
        let key = SymmetricKey(size: .bits256)
        var newItem = keyQuery
        newItem[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        newItem[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let added = SecItemAdd(newItem as CFDictionary, nil)
        if added == errSecDuplicateItem { return try loadKey() }
        guard added == errSecSuccess else { throw VaultError.keychain(added) }
        return key
    }

    func write(_ bytes: Data, named name: String) throws {
        let sealed = try AES.GCM.seal(bytes, using: key, authenticating: Data(name.utf8))
        guard let combined = sealed.combined else { throw VaultError.invalidFile }
        let url = directory.appendingPathComponent(name)
        // The enclosing directory is excluded from backup before any file is written.
        // Nothing may throw after this atomic commit: callers depend on failure meaning no new data.
        try combined.write(to: url, options: [.atomic, .completeFileProtection])
    }

    func read(named name: String) throws -> Data? {
        let url = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let box = try AES.GCM.SealedBox(combined: Data(contentsOf: url))
        return try AES.GCM.open(box, using: key, authenticating: Data(name.utf8))
    }

    func remove(named name: String) throws {
        let url = directory.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }

    func save(_ data: AppData) throws { try write(JSONEncoder().encode(data), named: "profile.sealed") }
    func load() throws -> AppData {
        guard let bytes = try read(named: "profile.sealed") else { return AppData() }
        let data = try JSONDecoder().decode(AppData.self, from: bytes)
        guard data.schemaVersion == 1 else { throw VaultError.futureVersion }
        return data
    }

    static func writeAutofillSession(_ session: AutofillSession) throws {
        guard session.isValid() else { throw VaultError.invalidSession }
        try shared().write(JSONEncoder().encode(session), named: "session.sealed")
    }

    static func readAutofillSession() throws -> AutofillSession? {
        let vault = try shared()
        guard let bytes = try vault.read(named: "session.sealed") else { return nil }
        let session = try JSONDecoder().decode(AutofillSession.self, from: bytes)
        guard session.isValid() else { try vault.remove(named: "session.sealed"); return nil }
        return session
    }

    static func revokeAutofillSession() throws {
        // Revocation must not require a readable key or create a new key/session.
        // Without the App Group entitlement this build could not have granted a session.
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return }
        let url = root.appendingPathComponent("Autofill/session.sealed")
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }

    func deleteAll() throws {
        try Self.revokeAutofillSession()
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            try FileManager.default.removeItem(at: url)
        }
        let result = SecItemDelete(Self.keyQuery as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw VaultError.keychain(result) }
    }
}
