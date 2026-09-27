package com.ethanpam.secondhand.assistant

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.ethanpam.secondhand.MainActivity
import com.ethanpam.secondhand.core.AppStore
import com.ethanpam.secondhand.core.PersonalProfile
import com.ethanpam.secondhand.core.RenewalStatus
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Production vault/controller + the shared reconstructed applicant schema.
 * All requests, including POST, receive local responses; network loads are also
 * disabled on this test-only WebView. No live answers, drafts, or submissions. */
class ApplicantSchemaQATest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val guest = AssistantController.PORTAL + "/applyForBenefits/guestLogin"
    private val applicant = AssistantController.PORTAL + "/applyForBenefits/enterPersonalInfo"

    private fun <T> main(block: () -> T): T {
        var result: Result<T>? = null
        instrumentation.runOnMainSync { result = runCatching(block) }
        return result!!.getOrThrow()
    }

    private fun await(reason: String, predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < deadline) {
            if (main(predicate)) return
            SystemClock.sleep(50)
        }
        fail(reason)
    }

    private fun evaluate(view: WebView, script: String): String {
        val latch = CountDownLatch(1)
        var result = ""
        main { view.evaluateJavascript(script) { result = it; latch.countDown() } }
        assertTrue("Synthetic page script completed", latch.await(10, TimeUnit.SECONDS))
        return result
    }

    private fun expectValue(view: WebView, id: String, value: String) {
        assertEquals(id, JSONObject.quote(value), evaluate(view, "document.getElementById('${id}').value"))
    }

    private fun captureReconstructedFixture(scenario: ActivityScenario<MainActivity>, view: WebView) {
        evaluate(view, "window.scrollTo(0,0);true")
        // Only this fictional, fully intercepted fixture may be captured. Production keeps FLAG_SECURE.
        scenario.onActivity { it.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
        try {
            instrumentation.waitForIdleSync()
            SystemClock.sleep(150)
            val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            val additionalOutput = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.takeIf { it.isNotBlank() }
            val output = (additionalOutput?.let { File(it) }
                ?: File(instrumentation.targetContext.getExternalFilesDir(null), "ui-test-screenshots")).apply { mkdirs() }
            try {
                File(output, "applicant-schema-filled.png").outputStream().use {
                    check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
                }
                File(output, "applicant-schema-filled.txt").writeText(
                    "Reconstructed Iowa applicant schema with fictional QA answers. Local intercepted fixture, not the live Iowa website. No application was saved or submitted.\n")
            } finally { bitmap.recycle() }
        } finally { scenario.onActivity { it.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) } }
    }

    @Test fun fictionalProfileFillsKnownIowaApplicantWithoutSavingOrSubmitting() {
        val context = instrumentation.targetContext
        val testID = UUID.randomUUID().toString()
        val directory = File(context.noBackupFilesDir, "applicant-schema-qa-$testID").apply { mkdirs() }
        val testContext = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getNoBackupFilesDir(): File = directory
            override fun getCacheDir(): File = File(directory, "cache").apply { mkdirs() }
        }
        val store = main { AppStore.forTesting(testContext, testID) }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val scenario = ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java))
        var controller: AssistantController? = null
        var outcome: Throwable? = null
        val posts = AtomicInteger()
        val unexpectedRequests = CopyOnWriteArrayList<String>()
        try {
            val fictional = PersonalProfile(
                firstName = "Avery", middleName = "Jordan", lastName = "Example",
                email = "avery.example@example.invalid", homePhone = "2025550147", mobilePhone = "2025550148",
                addressLine1 = "123 Test Way", addressLine2 = "Unit 4", city = "Demo City", state = "IA",
                postalCode = "50309", monthlyIncome = "0", monthlyHousingCost = "800",
                notes = "Fictional local QA profile; never sent to Iowa.", reviewedAt = System.currentTimeMillis())
            runBlocking { withContext(Dispatchers.Main) {
                assertTrue(store.unlock())
                store.saveProfile(fictional)
                // Exercise encrypted persistence, not a mock field provider.
                store.lock()
                assertTrue(store.unlock())
                assertEquals(fictional, store.data.profile)
                store.authorizeAutofill()
            } }
            val fixture = instrumentation.context.assets.open("iowa-personal-information.html").bufferedReader().use { it.readText() }
            val guestFixture = """<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>Local guest entry fixture</h1><p>No network is allowed.</p><label>CAPTCHA<input id="captchaAnswer"></label>"""
            lateinit var view: WebView
            lateinit var assistant: AssistantController
            scenario.onActivity { activity ->
                assistant = AssistantController(activity, store, scope, webViewFactory = { owner ->
                    object : WebView(owner) {
                        init { settings.blockNetworkLoads = true }
                        override fun loadUrl(url: String) { super.loadUrl(if (url == AssistantController.PORTAL) guest else url) }
                        override fun setWebViewClient(client: WebViewClient) {
                            super.setWebViewClient(object : WebViewClient() {
                                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = client.shouldOverrideUrlLoading(view, request)
                                override fun onPageStarted(view: WebView, url: String?, icon: Bitmap?) = client.onPageStarted(view, url, icon)
                                override fun onPageFinished(view: WebView, url: String?) = client.onPageFinished(view, url)
                                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                                    if (request.method != "GET") posts.incrementAndGet()
                                    // WebView149 requests this default icon even when the synthetic page has none.
                                    // Serve only the observed exact GET locally; never allow a network fallback.
                                    if (!request.isForMainFrame && request.method == "GET" &&
                                        request.url.toString() == AssistantController.ORIGIN + "/favicon.ico") {
                                        return WebResourceResponse("image/x-icon", null, ByteArrayInputStream(ByteArray(0)))
                                    }
                                    val body = when (request.url.toString()) {
                                        guest -> guestFixture
                                        applicant -> fixture
                                        else -> {
                                            // Diagnostics deliberately exclude query, fragment, headers, and body.
                                            unexpectedRequests.add("${request.method} ${request.url.scheme}://${request.url.host}${request.url.path} mainFrame=${request.isForMainFrame}")
                                            "<p>Blocked synthetic resource</p>"
                                        }
                                    }
                                    return WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream(body.toByteArray()))
                                }
                            })
                        }
                    }
                })
                controller = assistant
                view = assistant.createWebView()
                activity.setContentView(FrameLayout(activity).apply { addView(view, FrameLayout.LayoutParams(-1, -1)) })
            }
            assumeTrue("Installed provider lacks isolated-world execution", main { assistant.supported })
            await("Guest entry loaded in the isolated world") { assistant.ready && assistant.currentURL == guest }
            assertEquals("\"undefined/undefined\"", evaluate(view, "typeof SecondHandBridge + '/' + typeof SecondHandAndroid"))
            main { assistant.start() }
            await("Guest login blocks profile disclosure") { !assistant.busy }
            assertFalse(main { assistant.started })
            assertNull(main { assistant.preview })
            assertEquals(0, main { assistant.filled })
            expectValue(view, "captchaAnswer", "")

            // Skip the real site's manual gates only by navigating among intercepted fixtures.
            main { view.loadUrl(applicant) }
            await("Reconstructed applicant page loaded") { assistant.ready && assistant.currentURL == applicant }
            evaluate(view, "document.getElementById('middleName').value='Already entered';true")
            main { assistant.start() }
            await("Known applicant fields automatically filled") { !assistant.busy && assistant.preview?.kind == "known" }
            expectValue(view, "firstName", fictional.firstName)
            expectValue(view, "middleName", "Already entered")
            expectValue(view, "lastName", fictional.lastName)
            expectValue(view, "phoneNumber", "(202)555-0147")
            expectValue(view, "otherPhoneNumber", "(202)555-0148")
            assertEquals(4, main { assistant.filled })
            assertTrue("Manual required choices prevent Continue", main { assistant.preview!!.actions.isEmpty() })
            expectValue(view, "addressLine1", "")
            assertEquals("false", evaluate(view, "document.getElementById('applicant1').checked || document.getElementById('hasHome1').checked || document.getElementById('snap').checked"))

            // Explicit synthetic user choices, never inferred from the saved SNAP tracker.
            evaluate(view, "['hasHome1','sameAddress1','applicant1','snap'].forEach(id=>document.getElementById(id).click());true")
            main { assistant.checkPage() }
            await("Newly visible address is reviewed") { !assistant.busy && assistant.preview != null }
            val addressPreview = main { assistant.preview!! }
            val addressAssignments = addressPreview.fields.mapNotNull { field -> field.key?.let { field.id to it } }.toMap()
            assertEquals(setOf("addressLine1", "addressLine2", "city", "state", "postalCode"), addressAssignments.values.toSet())
            main { assistant.fillSelected(addressPreview, addressAssignments) }
            await("Revealed home address filled") { !assistant.busy && assistant.filled == 9 }
            for ((id, value) in mapOf("addressLine1" to fictional.addressLine1, "addressLine2" to fictional.addressLine2,
                "city" to fictional.city, "state" to "IA", "zipcode" to fictional.postalCode, "middleName" to "Already entered")) expectValue(view, id, value)
            expectValue(view, "mailingAddressLine1", "")
            assertEquals("true/false/false", evaluate(view, "[document.getElementById('snap').checked,document.getElementById('medicaid').checked,document.getElementById('tanf').checked].join('/')").trim('"'))

            val complete = main { assistant.preview!! }
            assertEquals(listOf("continue"), complete.actions.map { it.kind })
            captureReconstructedFixture(scenario, view)
            // A page answer changing after native review invalidates even this explicit Continue request.
            evaluate(view, "document.getElementById('firstName').value='';true")
            main { assistant.act(complete, complete.actions.single(), false) }
            await("Changed/incomplete applicant cannot advance") { !assistant.busy && assistant.paused }
            assertEquals("0", evaluate(view, "window.__qaContinueClicks"))
            assertEquals(applicant, main { assistant.currentURL })
            assertEquals(0, posts.get())
            assertTrue("Unexpected intercepted requests: $unexpectedRequests", unexpectedRequests.isEmpty())
            assertFalse(main { assistant.awaitingConfirmation })
            assertEquals(RenewalStatus.PREPARING, main { store.data.renewal.status })
            main { assistant.stop() }
            assertNull(main { store.currentAssistantGrant() })
        } catch (error: Throwable) {
            outcome = error
            throw error
        } finally {
            fun cleanup(block: () -> Unit) {
                try { block() } catch (error: Throwable) {
                    if (outcome == null) outcome = error else outcome!!.addSuppressed(error)
                }
            }
            val original = outcome
            cleanup { main { controller?.destroy(); scope.cancel() } }
            cleanup { runBlocking { withContext(Dispatchers.Main) {
                if (!store.isUnlocked) assertTrue(store.unlock())
                store.deleteAllData()
            } } }
            cleanup { scenario.close() }
            cleanup { check(directory.deleteRecursively()) }
            if (original == null) outcome?.let { throw it }
        }
    }
}
