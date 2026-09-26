package com.ethanpam.secondhand.ui

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ethanpam.secondhand.assistant.AssistantScreen
import com.ethanpam.secondhand.core.AppStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch

private enum class Destination(val title: String) { OVERVIEW("Overview"), PROFILE("Profile"), DOCUMENTS("Documents"), SETTINGS("Settings") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SecondHandRoot(
    store: AppStore,
    authenticating: Boolean,
    authenticationError: String?,
    onAuthenticate: () -> Unit,
    onPickDocument: () -> Unit,
    pendingDocument: Uri?,
    onDocumentConsumed: () -> Unit
) {
    val state by store.state.collectAsState()
    val context = LocalContext.current
    var destination by remember { mutableStateOf(Destination.OVERVIEW) }
    var editingProfile by remember { mutableStateOf(false) }
    var editingRenewal by remember { mutableStateOf(false) }
    var showingAssistant by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var importing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(state.isUnlocked) {
        if (!state.isUnlocked) {
            editingProfile = false; editingRenewal = false; showingAssistant = false; error = null
            withContext(Dispatchers.IO) { cleanupDocumentPreviews(context) }
        }
    }
    LaunchedEffect(state.isUnlocked, pendingDocument) {
        if (state.isUnlocked && pendingDocument != null) {
            importing = true
            try { store.importDocument(pendingDocument); onDocumentConsumed() }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = failure.message ?: "The document could not be saved. Please try again."; onDocumentConsumed() }
            finally { importing = false }
        }
    }

    if (!state.isUnlocked) {
        LockedScreen(authenticating || state.isLoading, authenticationError ?: state.errorMessage,
            pendingDocument != null, onAuthenticate)
        return
    }
    if (showingAssistant) {
        AssistantScreen(store = store, onClose = { showingAssistant = false })
        return
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(title = { Text(destination.title, fontWeight = FontWeight.Bold) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                actions = {
                    IconButton(onClick = { store.lock() }) { Icon(Icons.Rounded.Lock, "Lock Second Hand") }
                })
        },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                Destination.entries.forEach { item ->
                    val icon = when (item) {
                        Destination.OVERVIEW -> Icons.Rounded.Home
                        Destination.PROFILE -> Icons.Rounded.PersonOutline
                        Destination.DOCUMENTS -> Icons.Rounded.FolderOpen
                        Destination.SETTINGS -> Icons.Rounded.Settings
                    }
                    NavigationBarItem(selected = destination == item, onClick = { destination = item },
                        icon = { Icon(icon, null) }, label = { Text(item.title) })
                }
            }
        }
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
            when (destination) {
                Destination.OVERVIEW -> OverviewScreen(state.data, onEditProfile = { editingProfile = true },
                    onEditRenewal = { editingRenewal = true }, onNewRenewal = {
                        scope.launch { try { store.startNewRenewal() } catch (failure: Exception) { error = failure.message } }
                    })
                Destination.PROFILE -> ProfileScreen(state.data.profile, onEdit = { editingProfile = true })
                Destination.DOCUMENTS -> DocumentsScreen(store, state.data.documents, importing, onPickDocument)
                Destination.SETTINGS -> SettingsScreen(store, state, onReviewProfile = { editingProfile = true },
                    onOpenAssistant = { showingAssistant = true })
            }
            if (importing || state.isLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
    }
    if (editingProfile) ProfileEditor(state.data.profile, onDismiss = { editingProfile = false }, onSave = { store.saveProfile(it); editingProfile = false })
    if (editingRenewal) RenewalEditor(state.data.renewal, onDismiss = { editingRenewal = false }, onSave = { store.saveRenewal(it); editingRenewal = false })
    ErrorDialog(error ?: state.errorMessage) { error = null; store.clearError() }
}

@Composable
private fun LockedScreen(busy: Boolean, error: String?, pendingDocument: Boolean, onUnlock: () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(28.dp).widthIn(max = 560.dp),
            verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.height(52.dp))
            Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.size(104.dp)) {
                Box(contentAlignment = Alignment.Center) { Icon(Icons.Rounded.Spa, null, Modifier.size(52.dp), tint = MaterialTheme.colorScheme.primary) }
            }
            Spacer(Modifier.height(28.dp))
            Text("Second Hand", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(10.dp))
            Text("A little preparation.\nA little peace of mind.", style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            Spacer(Modifier.height(36.dp))
            AppCard {
                SectionTitle("Your information stays with you", "Keep your Iowa SNAP details, documents, and notice dates together on this phone.")
                Text("Use your phone’s screen lock or strong biometrics to open your private information. No app account is needed.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (pendingDocument) Text("Your selected document is ready to import after you unlock.", style = MaterialTheme.typography.bodyMedium)
                PrimaryButton(if (busy) "Unlocking…" else "Unlock Second Hand", onUnlock, !busy, Icons.Rounded.LockOpen)
                if (busy) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally).size(24.dp), strokeWidth = 2.dp)
                if (error != null) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            Spacer(Modifier.height(26.dp))
            Text("IOWA SNAP COMPANION", fontSize = 11.sp, letterSpacing = 1.6.sp, fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(8.dp))
            Text("Independent app · Not affiliated with Iowa HHS", style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(32.dp))
        }
    }
}
