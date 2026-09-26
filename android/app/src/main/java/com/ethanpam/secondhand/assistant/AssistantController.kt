package com.ethanpam.secondhand.assistant

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.JavaScriptExecutionException
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebViewOutcomeReceiver
import com.ethanpam.secondhand.core.AppStore
import com.ethanpam.secondhand.core.AutofillSession
import com.ethanpam.secondhand.core.IowaApplicationBridge
import java.io.ByteArrayInputStream
import java.net.URI
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

data class AssistantField(val id: String, val label: String, val key: String?)
data class AssistantAction(val id: String, val label: String, val kind: String)
data class AssistantPreview(
    val token: String,
    val documentID: String,
    val pageURL: String,
    val kind: String,
    val title: String,
    val fields: List<AssistantField>,
    val actions: List<AssistantAction>,
)

/** Main-thread, in-memory coordinator. Only native button handlers read the vault.
 * Approval tokens, profile values, page snapshots and cookies are never saved by this class. */
class AssistantController internal constructor(
    private val context: Context,
    private val store: AppStore,
    private val scope: CoroutineScope,
    private val webViewFactory: (Context) -> WebView = { WebView(it) },
) {
    companion object {
        const val PORTAL = "https://hhsservices.iowa.gov/apspssp/ssp.portal"
        const val ORIGIN = "https://hhsservices.iowa.gov"
        const val BRIDGE = "SecondHandBridge"
        const val WORLD = "secondhand.application"
        val savedFields = linkedMapOf(
            "firstName" to "First name", "middleName" to "Middle name", "lastName" to "Last name",
            "email" to "Email", "homePhone" to "Home phone", "mobilePhone" to "Mobile phone",
            "addressLine1" to "Home address line 1", "addressLine2" to "Home address line 2",
            "city" to "Home city", "state" to "Home state", "postalCode" to "Home ZIP code",
            "monthlyIncome" to "Monthly income", "monthlyHousingCost" to "Monthly housing cost",
        )

        fun allowedNavigation(raw: String?): Boolean = runCatching {
            if (raw == null || raw.length > 4_000) return false
            val uri = URI(raw)
            uri.scheme == "https" && uri.host == "hhsservices.iowa.gov" && uri.userInfo == null &&
                (uri.port == -1 || uri.port == 443) && uri.rawPath?.startsWith("/apspssp/") == true &&
                !uri.rawPath.orEmpty().contains('%') && !uri.rawPath.orEmpty().contains('\\') &&
                uri.rawPath.split('/').none { it == "." || it == ".." }
        }.getOrDefault(false)
    }

    var preview by mutableStateOf<AssistantPreview?>(null)
        private set
    var status by mutableStateOf("Navigate to your Iowa application, then start assistance. Sign in and answer preliminary questions yourself.")
        private set
    var busy by mutableStateOf(false)
        private set
    var started by mutableStateOf(false)
        private set
    var paused by mutableStateOf(false)
        private set
    var awaitingConfirmation by mutableStateOf(false)
        private set
    var supported by mutableStateOf(false)
        private set
    var ready by mutableStateOf(false)
        private set
    var filled by mutableStateOf(0)
        private set
    var currentURL by mutableStateOf(PORTAL)
        private set

    private var webView: WebView? = null
    private var proxy: JavaScriptReplyProxy? = null
    private var documentID: String? = null
    private var generation = 0L
    private var grantID: String? = null
    private var job: Job? = null
    private var destroyed = false
    private var autoInspectNext = false
    private data class Pending(val generation: Long, val documentID: String, val promise: CompletableDeferred<JSONObject>)
    private val pending = mutableMapOf<String, Pending>()

    @SuppressLint("SetJavaScriptEnabled")
    fun createWebView(): WebView {
        check(webView == null && !destroyed)
        return webViewFactory(context).also { view ->
            webView = view
            view.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                setSupportZoom(true)
                builtInZoomControls = true
                displayZoomControls = false
                cacheMode = WebSettings.LOAD_NO_CACHE
                safeBrowsingEnabled = true
                mediaPlaybackRequiresUserGesture = true
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
            view.importantForAutofill = android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            view.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (!request.isForMainFrame) return false
                    if (allowedNavigation(request.url.toString())) return false
                    pause("This link needs your browser. Open the official portal externally to continue manually.")
                    return true
                }

                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                    invalidate(cancelEngine = true)
                    proxy = null; documentID = null; ready = false
                    currentURL = if (allowedNavigation(url)) url!! else PORTAL
                    if (!allowedNavigation(url)) {
                        view.stopLoading()
                        autoInspectNext = false
                        status = "Navigation outside Iowa’s portal was stopped. Open the official portal in your browser if needed."
                    } else if (awaitingConfirmation) {
                        status = "Submission was attempted. Read Iowa’s result; a click alone is not confirmation."
                    } else {
                        status = "Loading Iowa’s website…"
                    }
                }

                override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                    handler.cancel()
                    pause("A secure connection could not be established. Nothing further will be filled.")
                }

                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                    destroy()
                    status = "The website closed unexpectedly. Close this assistant and reopen it; no submission will be retried."
                    return true
                }

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    // POST navigation does not always pass through shouldOverrideUrlLoading.
                    if (request.isForMainFrame && !allowedNavigation(request.url.toString())) {
                        return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                    }
                    // Permit HTTPS resources (including manual CAPTCHA), never local files or cleartext content.
                    if (request.url.scheme in setOf("https", "data", "blob", "about")) return null
                    return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                }
            }
            view.webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    callback.onReceiveValue(null)
                    pause("Document uploads need your browser in this prototype. Open Iowa’s portal externally and choose files yourself. Your browser may require a separate sign-in.")
                    return true
                }
            }
            supported = WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD)
            if (supported) {
                val world = WebViewCompat.getExecutionWorld(view, WORLD)
                WebViewCompat.addWebMessageListener(view, BRIDGE, setOf(ORIGIN), world) { source, message, origin, mainFrame, reply ->
                    if (source !== webView || !mainFrame || origin.toString() != ORIGIN || destroyed) return@addWebMessageListener
                    val raw = runCatching { message.data }.getOrNull() ?: return@addWebMessageListener
                    if (raw.length > 128_000) return@addWebMessageListener
                    val data = runCatching { JSONObject(raw) }.getOrNull() ?: return@addWebMessageListener
                    receive(data, reply)
                }
                val source = listOf("iowa-adapter.js", "field-mapper.js", "application-assistant.js", "android-assistant.js")
                    .joinToString("\n") { context.assets.open(it).bufferedReader().use { reader -> reader.readText() } }
                WebViewCompat.addJavaScriptOnEvent(view, source, WebViewCompat.INJECTION_EVENT_DOCUMENT_END, setOf(ORIGIN), world)
            } else {
                status = "This Android System WebView needs an update for protected application assistance. You can use Iowa’s website manually."
            }
            view.loadUrl(PORTAL)
        }
    }

    private fun receive(data: JSONObject, reply: JavaScriptReplyProxy) {
        if (data.optString("type") == "ready") {
            val page = data.optString("pageURL")
            val id = data.optString("documentID")
            if (!allowedNavigation(page) || page != webView?.url || !isUUID(id)) return
            // A new readiness signal always discards prior document capabilities.
            if (documentID != id) {
                invalidate(cancelEngine = false)
                proxy = reply; documentID = id; currentURL = page; ready = true
            }
            status = when {
                awaitingConfirmation -> "Read Iowa’s result, then check this page to record a confirmed submission."
                paused -> "Paused. Resume when you are ready."
                !started -> "Open your application form, then start assistance. Login and verification stay manual."
                else -> "Check this page to continue application assistance."
            }
            if (autoInspectNext && started && !paused && !awaitingConfirmation) {
                autoInspectNext = false
                launch { inspectAndMaybeFill(autoFill = true) }
            }
            return
        }
        if (data.optString("type") != "result" || proxy !== reply) return
        val id = data.optString("id")
        val request = pending[id] ?: return
        if (request.generation != generation || data.optLong("generation", -1) != generation ||
            request.documentID != documentID || data.optString("documentID") != documentID) return
        pending.remove(id)
        if (data.has("error")) request.promise.completeExceptionally(IllegalStateException("page_changed"))
        else request.promise.complete(data.optJSONObject("result") ?: JSONObject())
    }

    private fun isUUID(value: String) = runCatching { UUID.fromString(value).toString() == value.lowercase() }.getOrDefault(false)

    private fun activeGrant(): AutofillSession {
        val grant = store.currentAssistantGrant() ?: error("session_expired")
        check(grant.expiresAt > System.currentTimeMillis() && grant.expiresAt <= System.currentTimeMillis() + 601_000)
        check(grantID == null || grant.id == grantID)
        return grant
    }

    private suspend fun request(operation: String, parameters: JSONObject = JSONObject()): JSONObject {
        val grant = activeGrant()
        val target = proxy ?: error("page_unavailable")
        val doc = documentID ?: error("page_unavailable")
        val url = currentURL
        check(ready && url == webView?.url && IowaApplicationBridge.allowsApplicationPage(url))
        val id = UUID.randomUUID().toString()
        val requestGeneration = generation
        val completion = CompletableDeferred<JSONObject>()
        pending[id] = Pending(generation, doc, completion)
        val payload = parameters.put("id", id).put("generation", generation).put("documentID", doc)
            .put("pageURL", url).put("operation", operation).put("expiresAt", grant.expiresAt)
        try {
            // The script runs only in the document/world that supplied this native proxy.
            target.executeJavaScript("void globalThis.SecondHandAndroid.command($payload);", executionReceiver {
                val active = pending[id]
                if (active?.promise === completion && active.generation == generation && active.documentID == documentID) {
                    completion.completeExceptionally(IllegalStateException("page_unavailable"))
                }
            })
            val result = withTimeout(25_000) { completion.await() }
            check(requestGeneration == generation && documentID == doc && currentURL == url)
            check(activeGrant().id == grant.id)
            return result
        } finally {
            pending.remove(id)
            payload.remove("values")
        }
    }

    private fun executionReceiver(onFailure: () -> Unit = {}) =
        object : WebViewOutcomeReceiver<String, JavaScriptExecutionException> {
            // The async command completes through the isolated message bridge, not this evaluation result.
            // Always provide a receiver: WebView149 crashes when a nullable receiver is omitted.
            override fun onResult(result: String?) = Unit
            override fun onError(error: JavaScriptExecutionException) { onFailure() }
        }

    private fun launch(block: suspend () -> Unit) {
        if (busy || destroyed) return
        busy = true
        job = scope.launch(start = CoroutineStart.LAZY) {
            val owner = currentCoroutineContext()[Job]
            try { block() }
            catch (_: CancellationException) { /* Pause, navigation, Stop, or destruction already updated the UI. */ }
            catch (_: Exception) {
                preview = null
                if (!awaitingConfirmation) paused = true
                status = if (awaitingConfirmation) "Submission may have been attempted. Check Iowa’s result. No automatic retry will occur."
                else "The page changed, needs an answer, or sharing expired. Review Iowa’s form and check the page again."
            } finally { if (job === owner) { busy = false; job = null } }
        }
        job?.start()
    }

    fun start() {
        if (started || !supported || !ready) return
        launch {
            val grant = activeGrant()
            check(IowaApplicationBridge.allowsApplicationPage(currentURL))
            grantID = grant.id; started = true; paused = false
            inspectAndMaybeFill(autoFill = !awaitingConfirmation)
        }
    }

    fun checkPage() {
        if (!started || !ready) return
        launch { inspectAndMaybeFill(autoFill = false) }
    }

    fun resume() {
        if (!started || !ready || awaitingConfirmation) return
        launch { activeGrant(); paused = false; inspectAndMaybeFill(autoFill = true) }
    }

    private suspend fun inspectAndMaybeFill(autoFill: Boolean) {
        val value = parsePreview(request("inspect"))
        preview = value
        status = if (awaitingConfirmation && value.kind != "receipt") {
            "Submission may have been attempted. Check Iowa’s result; another submission will not be attempted in this browser session."
        } else when (value.kind) {
            "known" -> "Review the applicant information and complete remaining questions before continuing."
            "mapping" -> "Match each field to a saved answer yourself. Leave uncertain fields unselected."
            "signature" -> "Review the whole application and sign on Iowa’s website. Submission needs separate approval."
            "receipt" -> "If Iowa confirms submission, record the confirmation number below."
            else -> "Complete verification, consent, documents, or other manual questions on Iowa’s website."
        }
        if (autoFill && !paused && !awaitingConfirmation && value.kind == "known") {
            val assignments = value.fields.mapNotNull { field -> field.key?.let { field.id to it } }.toMap()
            if (assignments.isNotEmpty()) fillPreview(value, assignments)
        }
    }

    private fun parsePreview(value: JSONObject): AssistantPreview {
        val token = value.getString("token")
        val doc = value.getString("documentID")
        val url = value.getString("pageURL")
        val kind = value.getString("kind")
        check(isUUID(token) && isUUID(doc) && url == currentURL && kind in setOf("known", "mapping", "manual", "signature", "receipt"))
        val fields = value.getJSONArray("fields")
        val actions = value.getJSONArray("actions")
        check(fields.length() <= 100 && actions.length() <= 1)
        return AssistantPreview(token, doc, url, kind, value.optString("title").take(160),
            (0 until fields.length()).map { index ->
                val item = fields.getJSONObject(index)
                val key = if (item.isNull("key")) null else item.optString("key").takeIf { it in savedFields }
                AssistantField(item.getString("id").take(80), item.getString("label").take(180), key)
            }, (0 until actions.length()).map { index ->
                val item = actions.getJSONObject(index)
                val actionKind = item.getString("kind")
                check(actionKind in setOf("continue", "submit"))
                AssistantAction(item.getString("id").take(80), item.getString("label").take(100), actionKind)
            })
    }

    fun fillSelected(shown: AssistantPreview, assignments: Map<String, String>) {
        if (paused || awaitingConfirmation || !started) return
        launch { fillPreview(shown, assignments) }
    }

    private suspend fun fillPreview(shown: AssistantPreview, assignments: Map<String, String>) {
        check(preview?.token == shown.token && shown.pageURL == currentURL && shown.kind in setOf("known", "mapping"))
        check(assignments.isNotEmpty() && assignments.size <= 30 && assignments.values.toSet().size == assignments.size)
        for ((id, key) in assignments) check(key in savedFields && shown.fields.any { it.id == id && (it.key == null || it.key == key) })
        val fields = store.applicationFields(shown.pageURL, assignments.values)
        activeGrant()
        val mappings = JSONArray().apply { assignments.forEach { (id, key) -> put(JSONObject().put("id", id).put("key", key)) } }
        preview = null
        val result = request("fill", JSONObject().put("token", shown.token).put("assignments", mappings).put("values", JSONObject(fields)))
        filled += result.optInt("filled", 0).coerceIn(0, 30)
        inspectAndMaybeFill(autoFill = false)
        status = "${result.optInt("filled", 0)} fields filled. Review Iowa’s answers and complete any remaining questions."
    }

    fun act(shown: AssistantPreview, action: AssistantAction, approvedSubmit: Boolean) {
        if (!started || paused || awaitingConfirmation) return
        launch {
            check(preview?.token == shown.token && shown.actions.contains(action))
            check(action.kind != "submit" || (shown.kind == "signature" && approvedSubmit))
            activeGrant()
            preview = null
            autoInspectNext = action.kind == "continue"
            // Persist no approval. Mark attempt BEFORE execution, including interrupted/uncertain calls.
            if (action.kind == "submit") awaitingConfirmation = true
            status = if (awaitingConfirmation) "Submission is being attempted once. Check Iowa’s result afterward." else "Continuing to the next step…"
            val result = request("act", JSONObject().put("token", shown.token).put("actionID", action.id).put("approved", approvedSubmit))
            check(result.optBoolean("attempted"))
            if (awaitingConfirmation) status = "Submission was attempted. Check Iowa’s result, then check this page."
        }
    }

    fun recordReceipt(shown: AssistantPreview, number: String, confirmed: Boolean) {
        if (!started || paused || !confirmed || shown.kind != "receipt") return
        launch {
            check(preview?.token == shown.token && currentURL == shown.pageURL)
            val grant = activeGrant()
            val fresh = parsePreview(request("inspect"))
            check(fresh.kind == "receipt" && fresh.documentID == shown.documentID && fresh.pageURL == shown.pageURL)
            check(activeGrant().id == grant.id)
            store.recordReceipt(number.trim(), shown.pageURL, UUID.randomUUID().toString())
            finishSession(cancelRunningJob = false)
            status = "Confirmation saved to your renewal tracker. This is your reported receipt, not an agency status feed."
        }
    }

    fun enforceGrant() {
        if (started && runCatching { activeGrant() }.isFailure) {
            stop()
            status = "Sharing expired or was revoked. Return to SecondHand to authorize a new session."
        }
    }

    fun pause(text: String = "Paused. Review the website and choose Resume when you are ready.") {
        autoInspectNext = false; paused = true
        invalidate(cancelEngine = true)
        status = text
    }

    fun stop() {
        finishSession(cancelRunningJob = true)
    }

    private fun finishSession(cancelRunningJob: Boolean) {
        invalidate(cancelEngine = true, cancelRunningJob = cancelRunningJob)
        store.revokeAutofill()
        autoInspectNext = false; started = false; paused = false; grantID = null
        // An uncertain submission remains blocked for this browser lifetime.
        status = "Assistance stopped. No saved details will be filled."
    }

    private fun invalidate(cancelEngine: Boolean, cancelRunningJob: Boolean = true) {
        generation++
        if (cancelEngine) runCatching {
            // A destroyed frame can reject cancellation; native capabilities are revoked below regardless.
            proxy?.executeJavaScript("globalThis.SecondHandAndroid?.cancel();", executionReceiver())
        }
        pending.values.forEach { it.promise.cancel() }; pending.clear()
        if (cancelRunningJob) { job?.cancel(); job = null }
        busy = false; preview = null
    }

    fun destroy() {
        if (destroyed) return
        stop(); destroyed = true; proxy = null; documentID = null; ready = false
        webView?.let { view ->
            view.stopLoading()
            view.clearHistory(); view.clearCache(true); view.clearFormData()
            (view.parent as? android.view.ViewGroup)?.removeView(view)
            view.removeAllViews(); view.destroy()
        }
        webView = null
        // SecondHand uses no other WebView. No browser session is retained after closing.
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
    }
}
