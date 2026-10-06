import SwiftUI

enum AppTheme {
    static let ink = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.88, green: 0.94, blue: 0.91, alpha: 1) : UIColor(red: 0.13, green: 0.25, blue: 0.22, alpha: 1) })
    static let accent = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.49, green: 0.79, blue: 0.68, alpha: 1) : UIColor(red: 0.17, green: 0.39, blue: 0.32, alpha: 1) })
    static let canvas = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor.systemGroupedBackground : UIColor(red: 0.97, green: 0.96, blue: 0.93, alpha: 1) })
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
    static let softGreen = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.12, green: 0.23, blue: 0.20, alpha: 1) : UIColor(red: 0.88, green: 0.93, blue: 0.88, alpha: 1) })
}

struct AppCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 16) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 24))
    }
}

struct SectionLabel: View {
    var title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.title3.weight(.semibold)).foregroundStyle(AppTheme.ink)
            if let subtitle { Text(subtitle).font(.subheadline).foregroundStyle(.secondary) }
        }
        .accessibilityElement(children: .combine)
    }
}

struct IconBadge: View {
    var symbol: String
    var body: some View {
        Image(systemName: symbol)
            .font(.title3.weight(.medium))
            .foregroundStyle(AppTheme.accent)
            .frame(width: 46, height: 46)
            .background(AppTheme.softGreen, in: RoundedRectangle(cornerRadius: 15))
            .accessibilityHidden(true)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 24)
            .padding(.vertical, 14)
            .padding(.horizontal, 16)
            .foregroundStyle(Color(uiColor: .systemBackground))
            .background(AppTheme.accent, in: RoundedRectangle(cornerRadius: 16))
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
    }
}

struct DetailRow: View {
    var label: String
    var value: String
    var body: some View {
        LabeledContent(label) {
            Text(value.isEmpty ? "Not added" : value)
                .foregroundStyle(value.isEmpty ? Color.secondary : AppTheme.ink)
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
    }
}

struct OptionalDateField: View {
    var title: String
    @Binding var date: Date?
    var includesTime = false

    var body: some View {
        Toggle(title, isOn: Binding(get: { date != nil }, set: { date = $0 ? (date ?? Date()) : nil }))
        if date != nil {
            DatePicker(title, selection: Binding(get: { date ?? Date() }, set: { date = $0 }), displayedComponents: includesTime ? [.date, .hourAndMinute] : [.date])
                .datePickerStyle(.compact)
        }
    }
}
