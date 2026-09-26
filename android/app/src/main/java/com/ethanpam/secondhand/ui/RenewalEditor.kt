package com.ethanpam.secondhand.ui

import android.Manifest
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CalendarMonth
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.ethanpam.secondhand.core.RenewalPlan
import com.ethanpam.secondhand.core.RenewalStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

@Composable
internal fun RenewalEditor(initial: RenewalPlan, onDismiss: () -> Unit, onSave: suspend (RenewalPlan) -> Unit) {
    var draft by remember { mutableStateOf(initial) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notificationNote by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        draft = draft.copy(remindersEnabled = granted)
        if (!granted) notificationNote = "Notifications are off. Your dates will still be saved; you can enable notifications in Android Settings."
    }
    EditorDialog("Your renewal plan", saving, onDismiss, onSave = {
        saving = true
        scope.launch {
            try { onSave(draft) }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = failure.message ?: "Your renewal plan could not be saved." }
            finally { saving = false }
        }
    }) {
        AppCard {
            SectionTitle("Dates from your notice", "Use Iowa HHS’s actual instructions. The return date and benefits-end date can be different.")
            DateField("Return-by date", draft.dueDate) { draft = draft.copy(dueDate = it) }
            DateField("Benefits-end date", draft.benefitsEndDate) { draft = draft.copy(benefitsEndDate = it) }
        }
        AppCard {
            SectionTitle("Your recorded status", "This is your own record. It is not synced with Iowa HHS.")
            RenewalStatus.entries.forEach { status ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = draft.status == status, onClick = { draft = draft.copy(status = status) })
                    TextButton(onClick = { draft = draft.copy(status = status) }, modifier = Modifier.weight(1f)) {
                        Text(status.title, Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
            InputField("Confirmation number", draft.confirmationNumber) { draft = draft.copy(confirmationNumber = it) }
        }
        AppCard {
            SectionTitle("Follow-up tasks", "Submitting an application can still be followed by an interview or document request.")
            InterviewField(draft.interviewDate) { draft = draft.copy(interviewDate = it) }
            if (draft.interviewDate != null) ToggleRow("Interview completed", draft.interviewCompleted) { draft = draft.copy(interviewCompleted = it) }
            DateField("Documents due", draft.documentsDueDate) { draft = draft.copy(documentsDueDate = it) }
            if (draft.documentsDueDate != null) ToggleRow("Requested documents sent", draft.documentsSubmitted) { draft = draft.copy(documentsSubmitted = it) }
        }
        AppCard {
            SectionTitle("A gentle reminder")
            ToggleRow("Remind me about these dates", draft.remindersEnabled) { enabled ->
                if (enabled && Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else draft = draft.copy(remindersEnabled = enabled)
            }
            Text("Notifications use a general message without your case details. Android may delay reminders; keep your notice as your source for deadlines.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            notificationNote?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
        AppCard {
            SectionTitle("Notes for yourself")
            OutlinedTextField(value = draft.notes, onValueChange = { draft = draft.copy(notes = it) }, modifier = Modifier.fillMaxWidth(),
                minLines = 4, label = { Text("Renewal notes") }, shape = MaterialTheme.shapes.small)
        }
    }
    ErrorDialog(error) { error = null }
}

@Composable
internal fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun DateField(label: String, value: String?, onChange: (String?) -> Unit) {
    val context = LocalContext.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = {
            val date = value?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: LocalDate.now()
            DatePickerDialog(context, { _, year, month, day -> onChange(LocalDate.of(year, month + 1, day).toString()) }, date.year, date.monthValue - 1, date.dayOfMonth).showProtected()
        }, modifier = Modifier.weight(1f), shape = MaterialTheme.shapes.small, contentPadding = PaddingValues(14.dp)) {
            Icon(Icons.Rounded.CalendarMonth, null, Modifier.size(21.dp)); Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(label, fontWeight = FontWeight.SemiBold)
                Text(value?.let { displayDate(it) } ?: "Add date", style = MaterialTheme.typography.bodySmall)
            }
        }
        if (value != null) IconButton(onClick = { onChange(null) }) { Icon(Icons.Rounded.Close, "Clear $label") }
    }
}

@Composable
private fun InterviewField(value: Long?, onChange: (Long?) -> Unit) {
    val context = LocalContext.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = {
            val time = value?.let { Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault()).toLocalDateTime() } ?: LocalDateTime.now()
            DatePickerDialog(context, { _, year, month, day ->
                TimePickerDialog(context, { _, hour, minute ->
                    onChange(LocalDateTime.of(LocalDate.of(year, month + 1, day), LocalTime.of(hour, minute)).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli())
                }, time.hour, time.minute, android.text.format.DateFormat.is24HourFormat(context)).showProtected()
            }, time.year, time.monthValue - 1, time.dayOfMonth).showProtected()
        }, modifier = Modifier.weight(1f), shape = MaterialTheme.shapes.small, contentPadding = PaddingValues(14.dp)) {
            Icon(Icons.Rounded.CalendarMonth, null, Modifier.size(21.dp)); Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) { Text("Interview", fontWeight = FontWeight.SemiBold); Text(value?.let { displayInstant(it, true) } ?: "Add date and time", style = MaterialTheme.typography.bodySmall) }
        }
        if (value != null) IconButton(onClick = { onChange(null) }) { Icon(Icons.Rounded.Close, "Clear interview date") }
    }
}


private fun android.app.Dialog.showProtected() {
    window?.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
    show()
}
