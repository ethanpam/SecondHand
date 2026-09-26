package com.ethanpam.secondhand.core

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

data class PlannedReminder(val id: String, val triggerAt: Long)

object ReminderPlanner {
    fun planned(plan: RenewalPlan, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): List<PlannedReminder> {
        if (!plan.remindersEnabled || plan.status == RenewalStatus.APPROVED) return emptyList()
        val result = mutableListOf<PlannedReminder>()
        fun notice(date: String?, prefix: String, offsets: List<Long>) {
            if (date == null) return
            val localDate = LocalDate.parse(date)
            for (offset in offsets) {
                val at = localDate.minusDays(offset).atTime(9, 0).atZone(zone).toInstant().toEpochMilli()
                if (at > now) result += PlannedReminder("$prefix-$offset", at)
            }
        }
        if (plan.status == RenewalStatus.PREPARING) notice(plan.dueDate, "renewal", listOf(30, 14, 7, 1, 0))
        if (!plan.documentsSubmitted) notice(plan.documentsDueDate, "documents", listOf(7, 1, 0))
        if (!plan.interviewCompleted) plan.interviewDate?.let { date ->
            for (hours in listOf(24, 1)) {
                val at = Instant.ofEpochMilli(date).minusSeconds(hours * 3600L).toEpochMilli()
                if (at > now) result += PlannedReminder("interview-$hours", at)
            }
        }
        return result.sortedBy { it.triggerAt }
    }
}

/** No exact-alarm permission: Android may delay delivery for battery management. */
object ReminderScheduler {
    private const val CHANNEL = "private-deadlines"
    private const val ACTION = "com.ethanpam.secondhand.REMINDER"
    private val allIDs = listOf("renewal-30", "renewal-14", "renewal-7", "renewal-1", "renewal-0",
        "documents-7", "documents-1", "documents-0", "interview-24", "interview-1")

    fun canPostNotifications(context: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()

    @Synchronized fun synchronize(context: Context, plan: RenewalPlan) {
        val schedule = ReminderPlanner.planned(plan)
        val json = JSONArray(schedule.map { item -> JSONObject().put("id", item.id).put("at", item.triggerAt) })
        // This separate schedule contains only IDs/timestamps, allowing reboot restore without opening the vault.
        SecureVault.atomicWrite(scheduleFile(context), json.toString().toByteArray())
        install(context, schedule)
    }

    @Synchronized fun restore(context: Context) {
        install(context, load(context).filter { it.triggerAt > System.currentTimeMillis() })
    }

    @Synchronized fun clear(context: Context) {
        val manager = context.getSystemService(AlarmManager::class.java)
        allIDs.forEach { manager.cancel(pending(context, it)) }
        Files.deleteIfExists(scheduleFile(context).toPath())
        NotificationManagerCompat.from(context).cancelAll()
    }

    @Synchronized fun deliver(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val id = intent.getStringExtra("id") ?: return
        val expected = intent.getLongExtra("at", -1)
        val schedule = load(context)
        val item = schedule.firstOrNull { it.id == id && it.triggerAt == expected } ?: return
        val now = System.currentTimeMillis()
        if (item.triggerAt > now + 60_000) return
        // A stale delayed reminder never exposes information and expires after one day.
        val remaining = schedule.filterNot { it.id == id }
        SecureVault.atomicWrite(scheduleFile(context), JSONArray(remaining.map { JSONObject().put("id", it.id).put("at", it.triggerAt) }).toString().toByteArray())
        if (!canPostNotifications(context) || now - item.triggerAt > 86_400_000) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Private reminders", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Generic reminders for deadlines you saved"
            lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
        })
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        val open = PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_popup_reminder).setContentTitle("Second Hand reminder")
            .setContentText("You have a saved deadline. Open Second Hand to review it.")
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setContentIntent(open).setAutoCancel(true).build()
        try { manager.notify(id.hashCode(), notification) } catch (_: SecurityException) { /* Permission may have been revoked. */ }
    }

    private fun install(context: Context, schedule: List<PlannedReminder>) {
        val manager = context.getSystemService(AlarmManager::class.java)
        allIDs.forEach { manager.cancel(pending(context, it)) }
        schedule.forEach { item -> manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, item.triggerAt, pending(context, item.id, item.triggerAt)) }
    }

    private fun pending(context: Context, id: String, at: Long = -1): PendingIntent = PendingIntent.getBroadcast(context,
        id.hashCode(), Intent(context, ReminderReceiver::class.java).setAction(ACTION).putExtra("id", id).putExtra("at", at),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun scheduleFile(context: Context) = File(context.noBackupFilesDir, "reminder-times-v1.json")
    private fun load(context: Context): List<PlannedReminder> {
        val file = scheduleFile(context)
        if (!file.exists()) return emptyList()
        require(file.length() <= 4096)
        val items = JSONArray(file.readText())
        require(items.length() <= allIDs.size)
        return (0 until items.length()).map { index ->
            val item = items.getJSONObject(index)
            val id = item.getString("id")
            require(id in allIDs)
            PlannedReminder(id, item.getLong("at"))
        }
    }
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try { ReminderScheduler.deliver(context.applicationContext, intent) } catch (_: Exception) { /* Never log private data. */ }
    }
}

class ReminderBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED)) return
        try { ReminderScheduler.restore(context.applicationContext) } catch (_: Exception) { /* The app reconciles again after unlock. */ }
    }
}
