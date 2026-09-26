package com.ethanpam.secondhand.assistant

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.ethanpam.secondhand.core.AppStore
import kotlinx.coroutines.delay

/** Native controls are outside the website; the site cannot check our approval box. */
@Composable
fun AssistantScreen(store: AppStore, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val controller = remember(store) { AssistantController(context, store, scope) }
    AssistantContent(store, controller, onClose)
}

@Composable
internal fun AssistantContent(store: AppStore, controller: AssistantController, onClose: () -> Unit) {
    val context = LocalContext.current
    val appState by store.state.collectAsState()
    var submission by remember { mutableStateOf<Pair<AssistantPreview, AssistantAction>?>(null) }
    var approved by remember { mutableStateOf(false) }
    val shown = controller.preview
    val assignments = remember(shown?.token) { mutableStateMapOf<String, String>().apply {
        shown?.fields?.forEach { field -> field.key?.let { put(field.id, it) } }
    } }
    var confirmation by remember(shown?.token) { mutableStateOf("") }
    var receiptConfirmed by remember(shown?.token) { mutableStateOf(false) }

    DisposableEffect(controller) { onDispose { controller.destroy() } }
    LaunchedEffect(controller) { while (true) { controller.enforceGrant(); delay(1_000) } }
    LaunchedEffect(appState.isUnlocked, appState.autofillExpiresAt) {
        controller.enforceGrant()
        if (!appState.isUnlocked) { controller.destroy(); onClose() }
    }
    LaunchedEffect(shown?.token, controller.paused, controller.started) {
        if (submission?.first?.token != shown?.token || controller.paused || !controller.started) {
            submission = null; approved = false
        }
    }

    fun openExternal() {
        controller.pause("Continue manually in your browser. It may need a separate sign-in; this app cannot fill another browser.")
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(AssistantController.PORTAL))) }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background,
        contentColor = MaterialTheme.colorScheme.onBackground) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
            Surface(tonalElevation = 2.dp) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        TextButton(onClick = { controller.destroy(); onClose() }) { Text("Close") }
                        TextButton(onClick = ::openExternal) { Text("Open in browser") }
                    }
                    Text("Iowa application assistant", style = MaterialTheme.typography.titleMedium)
                    Text("hhsservices.iowa.gov", style = MaterialTheme.typography.labelSmall)
                }
            }
            Column(Modifier.fillMaxWidth().heightIn(max = 280.dp).verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(controller.status, style = MaterialTheme.typography.bodySmall)
                if (!controller.supported) {
                    Text("Protected autofill requires a newer Android System WebView. The website below can still be completed manually.",
                        style = MaterialTheme.typography.bodySmall)
                }
                if (!controller.started) {
                    Button(onClick = controller::start,
                        enabled = controller.supported && controller.ready && !controller.busy && store.currentAssistantGrant() != null) {
                        Text("Start assistance")
                    }
                } else {
                    Text("${controller.filled} fields filled · sharing ends after 10 minutes", style = MaterialTheme.typography.labelSmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = controller::checkPage, enabled = controller.ready && !controller.busy) { Text("Check page") }
                        if (controller.paused && !controller.awaitingConfirmation) {
                            OutlinedButton(onClick = controller::resume, enabled = controller.ready && !controller.busy) { Text("Resume") }
                        } else if (!controller.awaitingConfirmation) {
                            OutlinedButton(onClick = { controller.pause() }) { Text("Pause") }
                        }
                        TextButton(onClick = controller::stop) { Text("Stop") }
                    }
                }
                if (shown != null && controller.started) {
                    Text(shown.title, style = MaterialTheme.typography.titleSmall)
                    if (!controller.paused && !controller.awaitingConfirmation && shown.kind in setOf("known", "mapping")) {
                        shown.fields.forEach { field ->
                            var expanded by remember(shown.token, field.id) { mutableStateOf(false) }
                            Column {
                                Text(field.label, style = MaterialTheme.typography.bodySmall)
                                OutlinedButton(onClick = { expanded = true }, enabled = !controller.busy) {
                                    Text(AssistantController.savedFields[assignments[field.id]] ?: "Leave for me")
                                }
                                DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                                    DropdownMenuItem(text = { Text("Leave for me") }, onClick = { assignments.remove(field.id); expanded = false })
                                    AssistantController.savedFields.forEach { (key, title) ->
                                        if (field.key == null || field.key == key) {
                                            DropdownMenuItem(text = { Text(title) }, onClick = { assignments[field.id] = key; expanded = false })
                                        }
                                    }
                                }
                            }
                        }
                        if (shown.fields.isNotEmpty()) {
                            Button(onClick = { controller.fillSelected(shown, assignments.toMap()) }, enabled = !controller.busy && assignments.isNotEmpty()) {
                                Text("Fill selected details")
                            }
                        }
                    }
                    if (!controller.paused && !controller.awaitingConfirmation) {
                        shown.actions.forEach { action ->
                            if (action.kind == "continue") {
                                Button(onClick = { controller.act(shown, action, false) }, enabled = !controller.busy) { Text("Continue to next step") }
                            } else if (action.kind == "submit" && shown.kind == "signature") {
                                Button(onClick = { submission = shown to action; approved = false }, enabled = !controller.busy) { Text("Review submission approval") }
                            }
                        }
                    }
                    if (shown.kind == "receipt" && !controller.paused) {
                        OutlinedTextField(value = confirmation, onValueChange = { if (it.length <= 100) confirmation = it },
                            label = { Text("Iowa confirmation number") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        Row {
                            Checkbox(checked = receiptConfirmed, onCheckedChange = { receiptConfirmed = it })
                            Text("Iowa’s website confirms my application was submitted.", style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(top = 10.dp))
                        }
                        Button(onClick = { controller.recordReceipt(shown, confirmation, receiptConfirmed) },
                            enabled = !controller.busy && receiptConfirmed && confirmation.isNotBlank()) { Text("Save confirmation") }
                    }
                }
            }
            HorizontalDivider()
            AndroidView(factory = { controller.createWebView() }, modifier = Modifier.fillMaxWidth().weight(1f))
        }
    }

    submission?.let { (review, action) ->
        AlertDialog(onDismissRequest = { submission = null; approved = false },
            title = { Text("Approve this submission?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Read every answer and Iowa’s signature statement on the website. Complete its electronic signature yourself before approving.")
                    Row {
                        Checkbox(checked = approved, onCheckedChange = { approved = it })
                        Text("I reviewed the application, completed its signature, and authorize this submission.")
                    }
                    Text("The normal website button will be clicked once. Check the resulting page for confirmation.")
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    if (approved && controller.preview?.token == review.token) controller.act(review, action, true)
                    submission = null; approved = false
                }, enabled = approved && !controller.busy && controller.preview?.token == review.token) { Text("Approve and submit") }
            },
            dismissButton = { TextButton(onClick = { submission = null; approved = false }) { Text("Keep reviewing") } })
    }
}
