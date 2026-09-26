package com.ethanpam.secondhand.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ethanpam.secondhand.core.AppState
import com.ethanpam.secondhand.core.AppStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun SettingsScreen(store: AppStore, state: AppState, onReviewProfile: () -> Unit, onOpenAssistant: () -> Unit) {
    var authorizing by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    LaunchedEffect(state.autofillExpiresAt) {
        while (true) { now = System.currentTimeMillis(); delay(1000) }
    }
    val expiry = state.autofillExpiresAt
    val sharing = expiry != null && expiry > now
    val reviewed = state.data.profile.reviewedAt
    val recentlyReviewed = reviewed != null && now - reviewed in 0..86_400_000L
    Column(Modifier.widthIn(max = 720.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        AppCard {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                IconBadge(Icons.Rounded.AutoAwesome)
                Column(Modifier.weight(1f)) { SectionTitle("Your application, with a hand", "Get help filling supported Iowa application pages inside Second Hand.") }
            }
            SetupStep(1, "Review your profile", "Check that your contact details, home address, and monthly amounts are current.")
            SetupStep(2, "Allow temporary sharing", "Approve access for 10 minutes, then open the application assistant below.")
            SetupStep(3, "Work through the application", "Sign in yourself. The assistant fills recognized fields; you choose any other mappings and review each page before continuing.")
            SetupStep(4, "Review and approve submission", "Complete verification, uploads, consent, and signatures yourself. Approve the final submission separately, then save Iowa’s confirmation number.")
            Text("The Android assistant works in the app’s browser. It is not a Chrome extension and cannot fill other apps. Unsupported steps may need Iowa’s site in your regular browser.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        AppCard {
            SectionTitle("You choose when to share")
            Text(reviewed?.let { "Profile reviewed ${displayInstant(it)}" } ?: "Review your profile today before allowing application assistance.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (sharing) {
                val seconds = ((expiry!! - now) / 1000).coerceAtLeast(0)
                Text("Application access · ${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')} remaining",
                    fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
                PrimaryButton("Open application assistant", onOpenAssistant, icon = Icons.Rounded.OpenInBrowser)
                TextButton(onClick = { store.revokeAutofill() }) { Text("Revoke access now", color = MaterialTheme.colorScheme.error) }
            } else {
                PrimaryButton("Allow sharing for 10 minutes", { authorizing = true }, recentlyReviewed && !working, Icons.Rounded.VerifiedUser)
            }
            TextButton(onClick = onReviewProfile) { Text("Review my profile") }
            Text("Sharing requires a profile review within the last 24 hours. Name, email, home and mobile phone, home address, monthly income, and monthly housing cost can be shared. Household notes, written notes, and documents stay in the app.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Iowa’s website can save details as they are filled, before final submission. Revoking access doesn’t erase information already given to the website.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        AppCard {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                IconBadge(Icons.Rounded.PrivacyTip)
                Column(Modifier.weight(1f)) { SectionTitle("Private by design", "Your profile and documents are saved locally with encryption. Second Hand has no account or cloud sync.") }
            }
            Text("The app locks and ends sharing when it moves to the background. Opening Iowa’s website requires internet; your saved profile, documents, and dates work offline.", style = MaterialTheme.typography.bodyMedium)
            Text("There is no automatic backup or recovery. Keep your original documents. Losing this phone or deleting the app can lose your saved information.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = { store.lock() }) { Icon(Icons.Rounded.Lock, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Lock now") }
        }
        AppCard {
            SectionTitle("Official help")
            TextButton(onClick = { uriHandler.openUri("https://hhs.iowa.gov/assistance-programs/food-assistance/snap") }) { Text("Iowa HHS SNAP information"); Spacer(Modifier.width(8.dp)); Icon(Icons.Rounded.OpenInNew, null, Modifier.size(17.dp)) }
            TextButton(onClick = { uriHandler.openUri("https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap") }) { Text("How to apply in Iowa"); Spacer(Modifier.width(8.dp)); Icon(Icons.Rounded.OpenInNew, null, Modifier.size(17.dp)) }
            TextButton(onClick = { uriHandler.openUri("https://hhsservices.iowa.gov/apspssp/ssp.portal") }) { Text("Open Iowa in my browser"); Spacer(Modifier.width(8.dp)); Icon(Icons.Rounded.OpenInNew, null, Modifier.size(17.dp)) }
            Text("Use the renewal instructions on your official notice. This app does not determine eligibility or receive case-status updates from Iowa HHS. The application portal may not support your renewal.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        AppCard {
            SectionTitle("Your data, your choice")
            Text("Delete your saved profile, documents, renewal details, and reminders from this app.", style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = { deleting = true }, enabled = !working) { Text("Delete all app data", color = MaterialTheme.colorScheme.error) }
        }
        Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Second Hand", fontWeight = FontWeight.SemiBold)
            Text("Independent app · Not affiliated with Iowa HHS", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (authorizing) AlertDialog(onDismissRequest = { authorizing = false }, title = { Text("Share application details for 10 minutes?") },
        text = { Text("This includes your name, contact details, home address, monthly income, and monthly housing cost. Iowa may save filled information before submission. You still review answers and approve submission yourself.") },
        confirmButton = { TextButton(onClick = {
            authorizing = false
            try { store.authorizeAutofill() } catch (failure: Exception) { error = failure.message ?: "Review your profile again before sharing." }
        }) { Text("Allow sharing") } },
        dismissButton = { TextButton(onClick = { authorizing = false }) { Text("Cancel") } })
    if (deleting) AlertDialog(onDismissRequest = { deleting = false }, title = { Text("Permanently delete all app data?") },
        text = { Text("This cannot be undone. Your saved information and local reminders will be removed. It does not withdraw an application or delete information already sent to Iowa HHS.") },
        confirmButton = { TextButton(onClick = {
            deleting = false; working = true
            scope.launch {
                try { store.deleteAllData() }
                catch (failure: Exception) { error = failure.message ?: "Your information could not be deleted." }
                finally { working = false }
            }
        }) { Text("Delete all data", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { deleting = false }) { Text("Cancel") } })
    ErrorDialog(error) { error = null }
}

@Composable
private fun SetupStep(number: Int, title: String, detail: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.small) {
            Text(number.toString(), Modifier.padding(horizontal = 10.dp, vertical = 5.dp), fontWeight = FontWeight.Bold,
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
