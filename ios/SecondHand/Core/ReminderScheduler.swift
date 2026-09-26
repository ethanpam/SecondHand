import Foundation
import UserNotifications

struct Reminder: Equatable {
    let id: String
    let date: Date
}

enum ReminderScheduler {
    static func planned(for plan: RenewalPlan, now: Date = Date(), calendar: Calendar = .current) -> [Reminder] {
        guard plan.remindersEnabled else { return [] }
        var reminders: [Reminder] = []
        func append(_ date: Date?, prefix: String, days: [Int]) {
            guard let date else { return }
            for offset in days {
                guard let day = calendar.date(byAdding: .day, value: -offset, to: date),
                      let atNine = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day), atNine > now else { continue }
                reminders.append(Reminder(id: "secondhand.\(prefix).\(offset)", date: atNine))
            }
        }
        if plan.status == .preparing { append(plan.dueDate, prefix: "renewal", days: [30, 14, 7, 1, 0]) }
        if !plan.documentsSubmitted { append(plan.documentsDueDate, prefix: "documents", days: [7, 1, 0]) }
        if !plan.interviewCompleted, let date = plan.interviewDate {
            for hours in [24, 1] {
                if let at = calendar.date(byAdding: .hour, value: -hours, to: date), at > now {
                    reminders.append(Reminder(id: "secondhand.interview.\(hours)", date: at))
                }
            }
        }
        if plan.status == .approved { return [] }
        return reminders.sorted { $0.date < $1.date }
    }

    @MainActor
    static func synchronize(_ plan: RenewalPlan, isCurrent: @escaping @MainActor () -> Bool = { true }) async throws {
        let center = UNUserNotificationCenter.current()
        guard isCurrent() else { throw CancellationError() }
        if plan.remindersEnabled {
            let granted = try await center.requestAuthorization(options: [.alert, .sound])
            guard granted else { throw AppError.notificationsDisabled }
        }
        guard isCurrent() else { throw CancellationError() }
        // This app only schedules Second Hand reminders; replacing prevents duplicate/stale deadlines.
        center.removeAllPendingNotificationRequests()
        for reminder in planned(for: plan) {
            guard isCurrent() else { throw CancellationError() }
            let content = UNMutableNotificationContent()
            content.title = "A reminder from Second Hand"
            content.body = "Open the app to review your next step."
            content.sound = .default
            let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: reminder.date)
            let trigger = UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)
            try await center.add(UNNotificationRequest(identifier: reminder.id, content: content, trigger: trigger))
            guard isCurrent() else { throw CancellationError() }
        }
    }
}
