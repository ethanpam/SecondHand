package com.ethanpam.secondhand.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import com.ethanpam.secondhand.core.AppStore
import com.ethanpam.secondhand.core.SavedDocument
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.min
import kotlin.math.roundToInt

@Composable
internal fun DocumentsScreen(store: AppStore, documents: List<SavedDocument>, importing: Boolean, onImport: () -> Unit) {
    var preview by remember { mutableStateOf<SavedDocument?>(null) }
    var deleting by remember { mutableStateOf<SavedDocument?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(Modifier.widthIn(max = 720.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        SectionTitle("Keep a copy close by.", "Save notices, supporting documents, and confirmations so they’re easy to find when you need them.")
        if (documents.isEmpty()) AppCard {
            Column(Modifier.fillMaxWidth().padding(vertical = 15.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
                Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.primaryContainer) {
                    Icon(Icons.Rounded.Description, null, Modifier.padding(24.dp).size(64.dp), tint = MaterialTheme.colorScheme.primary)
                }
                Text("A home for your paperwork", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Text("Add your first document from this phone.\nPDFs and images, up to 20 MB each.", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                PrimaryButton("Add a document", onImport, !importing, Icons.Rounded.Add)
            }
        } else {
            documents.forEach { document ->
                key(document.id) {
                    AppCard {
                        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            IconBadge(if (document.mimeType == "application/pdf") Icons.Rounded.Description else Icons.Rounded.Image)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                Text(document.name, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text("${android.text.format.Formatter.formatShortFileSize(LocalContext.current, document.byteCount)} · ${displayInstant(document.importedAt)}",
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            IconButton(onClick = { deleting = document }) { Icon(Icons.Rounded.DeleteOutline, "Delete ${document.name}") }
                        }
                        TextButton(onClick = { preview = document }) { Icon(Icons.Rounded.Visibility, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Preview document") }
                    }
                }
            }
            PrimaryButton("Add a document", onImport, !importing, Icons.Rounded.Add)
        }
        if (importing) Text("Saving a protected copy…", style = MaterialTheme.typography.bodyMedium)
        AppCard {
            SectionTitle("A saved copy, ready for you")
            Text("Adding a document doesn’t send it to Iowa HHS. Submit requested documents using the instructions on your notice.", style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("A file from a cloud provider may need an internet connection before it can be copied here. The app locks while you choose a file; unlock to finish the import.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        StorageNote()
    }
    preview?.let { document -> DocumentPreview(store, document) { preview = null } }
    deleting?.let { document ->
        AlertDialog(onDismissRequest = { deleting = null }, title = { Text("Delete this saved document?") },
            text = { Text("This removes ${document.name} from Second Hand. Its original file stays where you imported it from.") },
            confirmButton = { TextButton(onClick = {
                deleting = null
                scope.launch { try { store.deleteDocument(document) } catch (failure: Exception) { error = failure.message ?: "The document could not be deleted." } }
            }) { Text("Delete document", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } })
    }
    ErrorDialog(error) { error = null }
}

private data class PreviewPage(val bitmap: Bitmap, val pageCount: Int)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DocumentPreview(store: AppStore, document: SavedDocument, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var page by remember { mutableIntStateOf(0) }
    var preview by remember { mutableStateOf<PreviewPage?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(document.id, page) {
        loading = true; error = null
        try {
            val bytes = store.readDocument(document)
            try {
                preview = withContext(Dispatchers.IO) { renderPreview(context, bytes, document.mimeType, page) }
            } finally { bytes.fill(0) }
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { error = "This document could not be previewed. Its encrypted saved copy is still available." }
        finally { loading = false }
    }
    val current = preview
    DisposableEffect(current) { onDispose { current?.bitmap?.recycle() } }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, securePolicy = SecureFlagPolicy.SecureOn)) {
        Scaffold(Modifier.fillMaxSize(), containerColor = MaterialTheme.colorScheme.background,
            topBar = { TopAppBar(title = { Text(document.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { IconButton(onClick = onDismiss) { Icon(Icons.Rounded.Close, "Close document") } }) },
            bottomBar = {
                if ((current?.pageCount ?: 0) > 1) Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { page-- }, enabled = page > 0 && !loading) { Icon(Icons.Rounded.ChevronLeft, "Previous page") }
                    Text("Page ${page + 1} of ${current?.pageCount}", style = MaterialTheme.typography.bodyMedium)
                    IconButton(onClick = { page++ }, enabled = page + 1 < (current?.pageCount ?: 0) && !loading) { Icon(Icons.Rounded.ChevronRight, "Next page") }
                }
            }
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding).padding(12.dp), contentAlignment = Alignment.Center) {
                when {
                    loading -> CircularProgressIndicator()
                    error != null -> Text(error!!, style = MaterialTheme.typography.bodyMedium)
                    current != null -> Image(current.bitmap.asImageBitmap(), "Preview of ${document.name}, page ${page + 1}",
                        Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                }
            }
        }
    }
}

/** The only plaintext PDF file is private, temporary, and unlinked before rendering. */
private fun renderPreview(context: Context, bytes: ByteArray, mimeType: String, pageIndex: Int): PreviewPage {
    if (mimeType != "application/pdf") {
        val source = ImageDecoder.createSource(ByteBuffer.wrap(bytes))
        val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val scale = min(1.0, 2048.0 / maxOf(info.size.width, info.size.height))
            decoder.setTargetSize(maxOf(1, (info.size.width * scale).roundToInt()), maxOf(1, (info.size.height * scale).roundToInt()))
        }
        return PreviewPage(bitmap, 1)
    }
    val directory = File(context.cacheDir, "document-previews").apply { mkdirs() }
    val temporary = File.createTempFile("preview-", ".pdf", directory)
    try {
        temporary.outputStream().use { it.write(bytes) }
        val descriptor = ParcelFileDescriptor.open(temporary, ParcelFileDescriptor.MODE_READ_ONLY)
        val renderer = try { PdfRenderer(descriptor) } catch (failure: Exception) { descriptor.close(); throw failure }
        renderer.use {
            // PdfRenderer holds the open descriptor; no named plaintext copy remains.
            check(temporary.delete()) { "Unable to remove temporary preview" }
            require(pageIndex in 0 until renderer.pageCount)
            renderer.openPage(pageIndex).use { page ->
                val scale = min(1600f / page.width, 2200f / page.height)
                val bitmap = Bitmap.createBitmap(maxOf(1, (page.width * scale).roundToInt()), maxOf(1, (page.height * scale).roundToInt()), Bitmap.Config.ARGB_8888)
                try {
                    bitmap.eraseColor(android.graphics.Color.WHITE)
                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    return PreviewPage(bitmap, renderer.pageCount)
                } catch (failure: Exception) { bitmap.recycle(); throw failure }
            }
        }
    } finally { temporary.delete() }
}


/** Remove only this app's private preview leftovers after a crash or background lock. */
internal fun cleanupDocumentPreviews(context: Context) {
    File(context.cacheDir, "document-previews").listFiles()?.forEach { file ->
        if (file.isFile && file.name.startsWith("preview-") && file.extension == "pdf") file.delete()
    }
}
