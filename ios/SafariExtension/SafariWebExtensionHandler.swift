import Foundation
import SafariServices

/// Only an extension-owned popup can invoke this handler. There is no webpage
/// message listener. Safari routes native messages to its containing extension.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let allowedKeys: Set<String> = [
        "firstName", "lastName", "addressLine1",
        "addressLine2", "city", "state", "postalCode"
    ]

    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any],
              Set(message.keys) == Set(["action", "pageURL", "keys"]),
              message["action"] as? String == "contactFields",
              let pageURL = message["pageURL"] as? String,
              Self.isAllowedPage(pageURL),
              let keys = message["keys"] as? [String],
              !keys.isEmpty, keys.count <= Self.allowedKeys.count,
              Set(keys).count == keys.count,
              Set(keys).isSubset(of: Self.allowedKeys) else {
            respond(["error": "unsupported_request"], to: context)
            return
        }

        do {
            guard let session = try SecureVault.readAutofillSession(), session.isValid() else {
                respond(["error": "session_unavailable"], to: context)
                return
            }
            let requested = Set(keys)
            let fields = session.fields.filter {
                requested.contains($0.key) && !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && $0.value.count <= 500
            }
            respond(["fields": fields, "expiresAt": session.expiresAt.timeIntervalSince1970 * 1_000], to: context)
        } catch {
            // Never include vault paths, saved values, or underlying errors.
            respond(["error": "session_unavailable"], to: context)
        }
    }

    private static func isAllowedPage(_ string: String) -> Bool {
        guard let url = URLComponents(string: string) else { return false }
        let route = ((url.path + " " + (url.query ?? "") + " " + (url.fragment ?? ""))
            .removingPercentEncoding ?? string).lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        let accountRoutes = ["signup", "register", "registration", "createaccount", "createanaccount",
                             "profile", "login", "logon", "signin", "authentication", "password", "recovery"]
        return url.scheme?.lowercased() == "https"
            && url.host?.lowercased() == "hhsservices.iowa.gov"
            && (url.port == nil || url.port == 443)
            && url.user == nil && url.password == nil
            && url.percentEncodedPath == "/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo"
            && !url.percentEncodedPath.lowercased().contains("%2e")
            && !url.percentEncodedPath.split(separator: "/").contains("..")
            && !accountRoutes.contains(where: route.contains)
    }

    private func respond(_ message: [String: Any], to context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: message]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
