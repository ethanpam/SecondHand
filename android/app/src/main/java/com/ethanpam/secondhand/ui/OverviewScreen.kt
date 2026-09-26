package com.ethanpam.secondhand.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ethanpam.secondhand.core.AppData
import com.ethanpam.secondhand.core.RenewalStatus
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit

internal fun displayDate(value: String?): String = value?.let {
    runCatching { LocalDate.parse(it).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) }.getOrDefault(it)
} ?: "Not added"
internal fun displayInstant(value: Long, time: Boolean = false): String = Instant.ofEpochMilli(value).atZone(ZoneId.systemDefault())
    .format(if (time) DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT) else DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))

@Composable
internal fun OverviewScreen(data: AppData, onEditProfile: () -> Unit, onEditRenewal: () -> Unit, onNewRenewal: () -> Unit) {
    var confirmingNew by remember { mutableStateOf(false) }
    var allHistory by remember { mutableStateOf(false) }
    val uriHandler = LocalUriHandler.current
    val plan = data.renewal
    val days = plan.dueDate?.let { runCatching { ChronoUnit.DAYS.between(LocalDate.now(), LocalDate.parse(it)) }.getOrNull() }
    Column(Modifier.widthIn(max = 720.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("IOWA SNAP COMPANION", style = MaterialTheme.typography.labelMedium, letterSpacing = 1.5.sp,
                color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
            Text(if (data.profile.firstName.isBlank()) "Your next step starts here" else "Welcome back, ${data.profile.firstName}",
                style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text("A little preparation. A little peace of mind.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Surface(color = Color.Transparent, contentColor = Color.White, shape = MaterialTheme.shapes.large) {
            Column(Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(AppPalette.ForestStart, AppPalette.ForestEnd))).padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Icon(Icons.Rounded.EventNote, null, tint = AppPalette.Mint)
                    Text("Your renewal", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.weight(1f))
                    SuggestionChip(onClick = onEditRenewal, label = { Text(plan.status.title) },
                        colors = SuggestionChipDefaults.suggestionChipColors(containerColor = Color.White.copy(alpha = 0.16f), labelColor = Color.White),
                        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.25f)))
                }
                Text(when {
                    plan.status == RenewalStatus.APPROVED -> "Keep your next notice close."
                    plan.status != RenewalStatus.PREPARING -> "One step further along."
                    days == null -> "Let’s add your notice date."
                    days < 0 -> "Your return date has passed."
                    days == 0L -> "Your return date is today."
                    days == 1L -> "1 day until your return date."
                    else -> "$days days until your return date."
                }, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(plan.dueDate?.let { "Return by ${displayDate(it)}" }
                    ?: "Use the return-by date on your Iowa HHS notice. Renewal timing varies by household.", style = MaterialTheme.typography.bodyMedium)
                PrimaryButton(if (plan.dueDate == null) "Add dates from my notice" else "Update my renewal", onEditRenewal,
                    colors = ButtonDefaults.buttonColors(containerColor = AppPalette.Mint, contentColor = AppPalette.ForestInk))
            }
        }
        SectionTitle("One step at a time", "Your personal checklist for what comes next.")
        AppCard {
            ChecklistRow(Icons.Rounded.PersonOutline, "Review your information", data.profile.reviewedAt?.let { "Last confirmed ${displayInstant(it)}" }
                ?: "Save your contact and household details.", data.profile.reviewedAt != null, onEditProfile)
            HorizontalDivider()
            ChecklistRow(Icons.Rounded.CalendarMonth, "Add dates from your notice", "Your notice sets your return-by date.", plan.dueDate != null, onEditRenewal)
            HorizontalDivider()
            ChecklistRow(Icons.Rounded.TaskAlt, "Keep track after you send it", "Record your confirmation and follow-up tasks.", plan.status != RenewalStatus.PREPARING, onEditRenewal)
        }
        if (plan.interviewDate != null || plan.documentsDueDate != null) AppCard {
            SectionTitle("Follow-up dates")
            plan.interviewDate?.let { DetailRow(if (plan.interviewCompleted) "Interview · Done" else "Interview", displayInstant(it, true)) }
            plan.documentsDueDate?.let { DetailRow(if (plan.documentsSubmitted) "Documents · Sent" else "Documents due", displayDate(it)) }
            TextButton(onClick = onEditRenewal) { Text("Update follow-up tasks") }
        }
        AppCard {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                IconBadge(Icons.Rounded.MarkunreadMailbox)
                Column(Modifier.weight(1f)) { SectionTitle("Your notice is your guide", "Follow the return instructions on your Iowa HHS notice.") }
            }
            TextButton(onClick = { uriHandler.openUri("https://hhs.iowa.gov/assistance-programs/food-assistance/snap") }) {
                Text("Iowa HHS SNAP information"); Spacer(Modifier.width(8.dp)); Icon(Icons.Rounded.OpenInNew, null, Modifier.size(17.dp))
            }
            Text("The online application portal may not support your renewal. Check your notice before using it.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (data.history.isNotEmpty()) AppCard {
            SectionTitle("Recent activity", "Your records, saved on this phone.")
            (if (allHistory) data.history else data.history.take(5)).forEach { entry ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(entry.title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
                    Text(entry.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(displayInstant(entry.date), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
            }
            if (data.history.size > 5) TextButton(onClick = { allHistory = !allHistory }) { Text(if (allHistory) "Show less" else "Show all activity") }
        }
        TextButton(onClick = { confirmingNew = true }, modifier = Modifier.fillMaxWidth()) { Text("Start a new renewal plan") }
        StorageNote()
    }
    if (confirmingNew) AlertDialog(onDismissRequest = { confirmingNew = false }, title = { Text("Start a new renewal plan?") },
        text = { Text("This clears your current dates, status, confirmation, and reminders. Your profile, documents, and activity history stay saved.") },
        confirmButton = { TextButton(onClick = { confirmingNew = false; onNewRenewal() }) { Text("Start new plan") } },
        dismissButton = { TextButton(onClick = { confirmingNew = false }) { Text("Cancel") } })
}

@Composable
private fun ChecklistRow(icon: ImageVector, title: String, detail: String, complete: Boolean, onClick: () -> Unit) {
    TextButton(onClick = onClick, contentPadding = PaddingValues(0.dp), modifier = Modifier.fillMaxWidth()) {
        Icon(icon, null, Modifier.size(24.dp), tint = MaterialTheme.colorScheme.primary)
        Column(Modifier.weight(1f).padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(title, color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.SemiBold)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(if (complete) Icons.Rounded.CheckCircle else Icons.Rounded.ChevronRight, if (complete) "Complete" else null,
            Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary)
    }
}
