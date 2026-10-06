import XCTest
import PDFKit
import UIKit
@testable import SecondHand

final class DocumentOCRTests: XCTestCase {
    func testSynthetic1040ScanRecognizesKeyValues() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "synthetic_1040sr_realistic_scan", withExtension: "pdf"))
        let bytes = try Data(contentsOf: url)
        let pdf = try XCTUnwrap(PDFDocument(data: bytes))
        XCTAssertTrue((pdf.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "Fixture must exercise scanned-image OCR")
        let result = try DocumentOCR.recognize(data: bytes, isPDF: true)
        XCTAssertEqual(result.pages.count, 1)
        let text = result.text.uppercased()
        for expected in ["1040-SR", "2024", "ALEXANDER", "MORGAN", "SAMPLE", "1847 TEST DATA AVE", "DES MOINES", "50309", "68,450", "18,600", "15,810"] {
            XCTAssertTrue(text.contains(expected), "Missing synthetic value: \(expected)")
        }
        let attachment = XCTAttachment(string: result.text)
        attachment.name = "Synthetic 1040 OCR output"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func test1040ProfileImportUsesPrimaryIdentityAndPreservesOtherDetails() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "synthetic_1040sr_realistic_scan", withExtension: "pdf"))
        let result = try DocumentOCR.recognize(data: Data(contentsOf: url), isPDF: true, includeLayout: true)
        var analysis = try ProfileDocumentParser.analyze(result)
        let values = Dictionary(uniqueKeysWithValues: analysis.fields.compactMap { field in field.profileKey.map { ($0, field.value) } })
        XCTAssertEqual(values["firstName"], "ALEXANDER")
        XCTAssertEqual(values["lastName"], "SAMPLE")
        XCTAssertEqual(values["addressLine1"], "1847 TEST DATA AVE")
        XCTAssertEqual(values["city"], "DES MOINES")
        XCTAssertEqual(values["state"], "IA")
        XCTAssertEqual(values["zip"], "50309")
        XCTAssertEqual(values["ssn"], "000-12-3456")
        XCTAssertEqual(analysis.taxYear, "2024")
        XCTAssertTrue(analysis.fields.contains { $0.isAnnualIncome && $0.value == "68450" })
        try checkReviewedIncome(analysis)
        var profile = PersonalProfile()
        profile.email = "saved@example.com"
        profile.monthlyIncome = "1000"
        profile.hasHomeAddress = .unanswered
        profile.lastName = "Existing"
        profile.reviewedAt = Date()
        for index in analysis.fields.indices where analysis.fields[index].profileKey == "lastName" { analysis.fields[index].selected = false }
        let draft = analysis.applying(to: profile)
        XCTAssertEqual(draft.firstName, "ALEXANDER")
        XCTAssertEqual(draft.lastName, "Existing")
        XCTAssertEqual(draft.email, "saved@example.com")
        XCTAssertEqual(draft.monthlyIncome, "1000")
        XCTAssertEqual(draft.hasHomeAddress, .unanswered)
        XCTAssertNil(draft.reviewedAt)
        var duplicate = result
        duplicate.layoutPages += result.layoutPages
        XCTAssertTrue(try ProfileDocumentParser.analyze(duplicate).fields.isEmpty)
        let unknown = RecognizedDocument(pages: ["Hello"], layoutPages: [OCRPage(text: "Hello", words: [])])
        XCTAssertTrue(try ProfileDocumentParser.analyze(unknown).fields.isEmpty)
    }

    @MainActor
    func testAdditionalSyntheticFormsProvideRecipientDetails() throws {
        for (name, type) in [("synthetic_1099nec_copyb_2026", "1099-nec"), ("synthetic_ssa1099_filled", "ssa-1099"), ("synthetic_w2_page3_2025", "w2")] {
            let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "pdf"))
            let result = try DocumentOCR.recognize(data: Data(contentsOf: url), isPDF: true, includeLayout: true)
            let attachment = XCTAttachment(data: try JSONEncoder().encode(result.layoutPages), uniformTypeIdentifier: "public.json")
            attachment.name = name + " OCR layout"
            attachment.lifetime = .keepAlways
            add(attachment)
            let analysis = try ProfileDocumentParser.analyze(result)
            XCTAssertEqual(analysis.type, type, name)
            let values = Dictionary(uniqueKeysWithValues: analysis.fields.compactMap { field in field.profileKey.map { ($0, field.value) } })
            // These samples combine the full name in one cell. The parser
            // does not guess the first/last name boundaries for an applicant.
            XCTAssertNil(values["firstName"], name)
            XCTAssertNil(values["middleName"], name)
            XCTAssertNil(values["lastName"], name)
            XCTAssertEqual(values["addressLine1"], type == "w2" ? "1847 TEST DATA AVE, APT 4B" : "1847 TEST DATA AVE", name)
            XCTAssertEqual(values["addressLine2"], type == "w2" ? nil : "APT 4B", name)
            XCTAssertEqual(values["city"], "DES MOINES", name)
            XCTAssertEqual(values["state"], "IA", name)
            XCTAssertEqual(values["zip"], "50309", name)
            XCTAssertEqual(values["ssn"], type == "w2" ? "000-12-3456" : nil, name)
            // SSA has conflicting printed years; NEC has conflicting OCR years.
            // NEC recipient TIN stays review-only and inconsistent amount labels are omitted.
            if type == "1099-nec" { XCTAssertTrue(["", "2026"].contains(analysis.taxYear), name) }
            else { XCTAssertEqual(analysis.taxYear, type == "w2" ? "2025" : "", name) }
            if type == "1099-nec" {
                for field in analysis.fields where field.isAnnualIncome { XCTAssertEqual(field.value, "68450.00", name) }
            } else if type == "ssa-1099" {
                // The resized scan reads Box 5 as "3ox 5". The shared parser
                // rejects this incomplete grid, so no SSN or amount is proposed.
                // Text review still retains the printed amounts for manual entry.
                XCTAssertTrue(result.text.contains("18,600.00"))
                XCTAssertFalse(analysis.fields.contains { $0.isAnnualIncome })
            } else {
                XCTAssertEqual(analysis.fields.first(where: { $0.isAnnualIncome })?.value, "68450.00", name)
            }
            XCTAssertFalse(analysis.fields.contains { $0.isAnnualIncome && ($0.label.lowercased().contains("withheld") || $0.label.lowercased().contains("repaid")) })
            try checkReviewedIncome(analysis)
        }
    }


    @MainActor
    private func checkReviewedIncome(_ original: ProfileDocumentAnalysis) throws {
        var profile = PersonalProfile()
        profile.ssn = "111-22-3333"
        profile.monthlyIncome = "1000"
        let unselected = original.applying(to: profile)
        XCTAssertEqual(unselected.ssn, profile.ssn)
        XCTAssertTrue(unselected.annualIncome.isEmpty)
        var selected = original
        for index in selected.fields.indices { selected.fields[index].selected = selected.fields[index].isAnnualIncome || selected.fields[index].profileKey == "ssn" }
        let documentID = UUID()
        let draft = selected.applying(to: profile, documentID: documentID, documentName: "Synthetic form")
        XCTAssertEqual(draft.ssn, original.fields.first(where: { $0.profileKey == "ssn" })?.value ?? profile.ssn)
        XCTAssertEqual(draft.monthlyIncome, "1000")
        XCTAssertEqual(draft.annualIncome.count, original.fields.filter { $0.isAnnualIncome }.count)
        XCTAssertTrue(draft.annualIncome.allSatisfy { $0.year == original.taxYear && $0.source == "Synthetic form" })
        XCTAssertEqual(selected.applying(to: draft, documentID: documentID).annualIncome.count, draft.annualIncome.count)
        XCTAssertNoThrow(try AppStore.validate(draft))
    }

    func testImageRecognitionAndNoTextFailure() throws {
        let size = CGSize(width: 1200, height: 500)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let image = renderer.image { context in
            UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size))
            ("NOTICE 12345" as NSString).draw(at: CGPoint(x: 80, y: 100), withAttributes: [.font: UIFont.systemFont(ofSize: 64), .foregroundColor: UIColor.black])
        }
        let result = try DocumentOCR.recognize(data: XCTUnwrap(image.pngData()), isPDF: false)
        XCTAssertTrue(result.text.contains("NOTICE 12345"))
        let blank = renderer.image { context in
            UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size))
        }
        XCTAssertThrowsError(try DocumentOCR.recognize(data: XCTUnwrap(blank.pngData()), isPDF: false))
    }

    func testTextPDFAndPageOrder() throws {
        let bytes = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 600, height: 800)).pdfData { context in
            for title in ["FIRST PAGE", "SECOND PAGE"] {
                context.beginPage()
                (title as NSString).draw(at: CGPoint(x: 50, y: 50), withAttributes: [.font: UIFont.systemFont(ofSize: 24)])
            }
        }
        let result = try DocumentOCR.recognize(data: bytes, isPDF: true)
        XCTAssertEqual(result.pages.count, 2)
        XCTAssertTrue(result.pages[0].contains("FIRST PAGE"))
        XCTAssertTrue(result.pages[1].contains("SECOND PAGE"))
    }

    func testInvalidAndOverlongDocumentsAreRejected() throws {
        XCTAssertThrowsError(try DocumentOCR.recognize(data: Data("not a pdf".utf8), isPDF: true))
        XCTAssertThrowsError(try DocumentOCR.recognize(data: Data(), isPDF: false))
        let bytes = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 60, height: 80)).pdfData { context in
            for _ in 0..<21 { context.beginPage() }
        }
        XCTAssertThrowsError(try DocumentOCR.recognize(data: bytes, isPDF: true)) { error in
            guard case DocumentOCRError.tooManyPages = error else { return XCTFail("Expected page limit") }
        }
    }
}
