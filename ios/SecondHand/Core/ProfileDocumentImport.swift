import Foundation
import JavaScriptCore

struct ProfileDocumentField: Decodable, Identifiable {
    let id: String
    let label: String
    var value: String
    let profileKey: String?
    var selected = true
    var isAnnualIncome: Bool {
        // Statement parsers also emit tax withholding and repayments; those
        // are not income. Preserve the original income lines, never total them.
        let statementIncome = ["taxLineW2Box1", "taxLineNecBox1a", "taxLineSsaBox3", "taxLineSsaBox5"]
        return statementIncome.contains(id) || id.range(of: #"^taxLine[1-6][abz]$"#, options: .regularExpression) != nil
    }
    enum CodingKeys: String, CodingKey { case id, label, value, profileKey }

    static let paths: [String: WritableKeyPath<PersonalProfile, String>] = [
        "ssn": \.ssn, "firstName": \.firstName, "middleName": \.middleName, "lastName": \.lastName,
        "addressLine1": \.addressLine1, "addressLine2": \.addressLine2,
        "city": \.city, "state": \.state, "zip": \.postalCode
    ]
}

struct ProfileDocumentAnalysis: Decodable {
    let title: String
    let type: String
    var taxYear: String
    var fields: [ProfileDocumentField]

    func applying(to profile: PersonalProfile, documentID: UUID? = nil, documentName: String? = nil) -> PersonalProfile {
        var draft = profile
        for field in fields where field.selected {
            if field.isAnnualIncome {
                let entry = AnnualIncomeEntry(amount: field.value.trimmingCharacters(in: .whitespacesAndNewlines),
                    year: taxYear, source: documentName ?? title, category: field.label, documentID: documentID, fieldID: field.id)
                if let documentID, let index = draft.annualIncome.firstIndex(where: { $0.documentID == documentID && $0.fieldID == field.id }) {
                    draft.annualIncome[index] = entry
                } else { draft.annualIncome.append(entry) }
                continue
            }
            guard let key = field.profileKey, let path = ProfileDocumentField.paths[key] else { continue }
            draft[keyPath: path] = field.value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        draft.reviewedAt = nil
        return draft
    }
}

enum ProfileDocumentParser {
    /// Uses the same bounded-cell tax parser as desktop. No network or file APIs are exposed to JS.
    static func analyze(_ document: RecognizedDocument) throws -> ProfileDocumentAnalysis {
        guard let context = JSContext() else { throw DocumentOCRError.unreadable }
        context.evaluateScript("var modules = {'node:crypto': {randomUUID: function() { throw new Error('Unavailable'); }}}; function require(name) { if (!(name in modules)) throw new Error('Unknown module'); return modules[name]; }")
        // Load the shared CommonJS dependencies before their consumers. These
        // bundled scripts receive only the fixed in-memory module registry.
        for name in ["snap-information", "household", "custom-fields", "schema", "facts", "document-layout", "document-w2", "document-ssa1099", "document-1099nec", "document-parser"] {
            let scriptExtension = name == "snap-information" ? "js" : "cjs"
            guard let url = Bundle.main.url(forResource: name, withExtension: scriptExtension) else { throw DocumentOCRError.unreadable }
            let script = try String(contentsOf: url, encoding: .utf8)
            context.evaluateScript("modules['./\(name).\(scriptExtension)'] = (function() { var module = {exports:{}}; \(script)\n return module.exports; })();")
            guard context.exception == nil else { throw DocumentOCRError.unreadable }
        }
        let input = try JSONEncoder().encode(document.layoutPages)
        context.setObject(String(decoding: input, as: UTF8.self), forKeyedSubscript: "pageJSON" as NSString)
        guard let json = context.evaluateScript("JSON.stringify(modules['./document-parser.cjs'].analyzeDocument({pages:JSON.parse(pageJSON)}))")?.toString(), context.exception == nil else {
            throw DocumentOCRError.unreadable
        }
        var result = try JSONDecoder().decode(ProfileDocumentAnalysis.self, from: Data(json.utf8))
        // Only explicit identity fields and labeled annual amounts are importable.
        // Annual records never flow into monthly-income answers.
        result.fields.removeAll { field in
            if field.isAnnualIncome { return false }
            guard let key = field.profileKey else { return true }
            return ProfileDocumentField.paths[key] == nil
        }
        for index in result.fields.indices where result.fields[index].isAnnualIncome || result.fields[index].profileKey == "ssn" {
            result.fields[index].selected = false
        }
        return result
    }
}
