import Foundation
import Security
import CommonCrypto

/// App-only credentials; never shared with the Safari extension or backed up.
struct AppAuthentication: Codable {
    var salt: Data
    var digest: Data
    var pinLength: Int? = 4
    var requiredDigits: Int { pinLength ?? 6 }
    var faceID = false
    var failures = 0
    var retryAfter = Date.distantPast

    static func validPIN(_ pin: String) -> Bool {
        pin.utf8.count == 4 && pin.utf8.allSatisfy { (48...57).contains($0) }
    }

    init(pin: String) throws {
        guard Self.validPIN(pin) else { throw AuthenticationError.invalidPIN }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw AuthenticationError.storage
        }
        salt = Data(bytes)
        digest = try Self.derive(pin, salt: salt)
    }

    mutating func verify(_ pin: String, now: Date = Date()) throws {
        guard now >= retryAfter else { throw AuthenticationError.delayed }
        let candidate = try Self.derive(pin, salt: salt)
        let difference = zip(candidate, digest).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) }
        guard pin.utf8.count == requiredDigits, pin.utf8.allSatisfy({ (48...57).contains($0) }), candidate.count == digest.count, difference == 0 else {
            failures += 1
            if failures >= 5 { retryAfter = now.addingTimeInterval(min(3600, 30 * pow(2, Double(min(failures - 5, 7))))) }
            throw AuthenticationError.incorrectPIN
        }
        failures = 0
        retryAfter = .distantPast
    }

    private static func derive(_ pin: String, salt: Data) throws -> Data {
        var result = [UInt8](repeating: 0, count: 32)
        let status = pin.withCString { password in
            salt.withUnsafeBytes { bytes in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), password, pin.utf8.count,
                    bytes.bindMemory(to: UInt8.self).baseAddress, salt.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 100_000, &result, result.count)
            }
        }
        guard status == kCCSuccess else { throw AuthenticationError.storage }
        return Data(result)
    }

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.ethanpam.secondhand.authentication",
         kSecAttrAccount as String: "app-pin-v1"]
    }

    static func load() throws -> Self? {
        var request = query
        request[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = item as? Data else { throw AuthenticationError.storage }
        return try JSONDecoder().decode(Self.self, from: bytes)
    }

    func save() throws {
        let bytes = try JSONEncoder().encode(self)
        let status = SecItemUpdate(Self.query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
        if status == errSecItemNotFound {
            var item = Self.query
            item[kSecValueData as String] = bytes
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw AuthenticationError.storage }
        } else if status != errSecSuccess { throw AuthenticationError.storage }
    }
}

enum AuthenticationError: LocalizedError {
    case invalidPIN, incorrectPIN, delayed, storage
    var errorDescription: String? {
        switch self {
        case .invalidPIN: "Choose a four-digit PIN."
        case .incorrectPIN: "Incorrect PIN. Please try again."
        case .delayed: "Too many attempts. Wait a while before trying your PIN again."
        case .storage: "Your app authentication could not be saved or read. Please try again."
        }
    }
}
