package com.ethanpam.secondhand.assistant

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import com.ethanpam.secondhand.MainActivity
import com.ethanpam.secondhand.core.AppStore
import com.ethanpam.secondhand.core.PersonalProfile
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Every request is intercepted before navigation. No live Iowa requests or submissions. */
class AssistantIntegrationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val base = AssistantController.PORTAL + "/applyForBenefits/"

    private fun <T> main(block: () -> T): T {
        var result: Result<T>? = null
        instrumentation.runOnMainSync { result = runCatching(block) }
        return result!!.getOrThrow()
    }

    private fun awaitCondition(reason: String, condition: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + 20_000
        while (SystemClock.elapsedRealtime() < end) {
            if (main(condition)) return
            SystemClock.sleep(50)
        }
        fail(reason)
    }

    private fun evaluate(view: WebView, script: String): String {
        val latch = CountDownLatch(1)
        var answer = ""
        main { view.evaluateJavascript(script) { result -> answer = result; latch.countDown() } }
        assertTrue("Page-world evaluation completed", latch.await(10, TimeUnit.SECONDS))
        return answer
    }

    private class Harness(
        val scenario: ActivityScenario<MainActivity>, val controller: AssistantController,
        val view: WebView, val store: AppStore, val scope: CoroutineScope,
        val directory: File, val submissions: AtomicInteger, val policyClient: WebViewClient,
    )

    private fun harness(): Harness {
        val context = instrumentation.targetContext
        val scenario = ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java))
        val testID = UUID.randomUUID().toString()
        val directory = File(context.noBackupFilesDir, "assistant-test-$testID").apply { mkdirs() }
        val isolatedContext = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getNoBackupFilesDir(): File = directory
            override fun getCacheDir(): File = File(directory, "cache").apply { mkdirs() }
        }
        val store = main { AppStore.forTesting(isolatedContext, testID) }
        runBlocking {
            withContext(Dispatchers.Main) {
                assertTrue(store.unlock())
                assertNull("Reminder framework uses the installed application identity", store.state.value.errorMessage)
                store.saveProfile(PersonalProfile(firstName = "Example", lastName = "Applicant", monthlyIncome = "1234.50",
                    reviewedAt = System.currentTimeMillis()))
                store.authorizeAutofill()
            }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val submissions = AtomicInteger()
        lateinit var view: WebView
        lateinit var controller: AssistantController
        lateinit var policyClient: WebViewClient
        val income = """<h1>Income</h1><form action="income"><label>Monthly earnings<input id="earnings" name="earnings" required></label><button type="button" onclick="location.href='${base}signature'">Continue</button></form>"""
        val signature = """<h1>E-Signature</h1><form action="signature"><p id="terms">I certify these answers are accurate.</p><label>Your signature<input id="signature" name="signature" required></label><label>Check to Sign<input id="signed" type="checkbox" required></label><button type="button" onclick="location.href='${base}confirmation'">Submit Application</button></form>"""
        val receipt = """<h1>Application Confirmation</h1><p>Confirmation number: EXAMPLE-123</p>"""
        scenario.onActivity { activity ->
            controller = AssistantController(activity, store, scope, webViewFactory = { owner ->
                object : WebView(owner) {
                    override fun loadUrl(url: String) { super.loadUrl(if (url == AssistantController.PORTAL) base + "income" else url) }
                    override fun setWebViewClient(client: WebViewClient) {
                        policyClient = client
                        super.setWebViewClient(object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = client.shouldOverrideUrlLoading(view, request)
                            override fun onPageStarted(view: WebView, url: String?, icon: Bitmap?) = client.onPageStarted(view, url, icon)
                            override fun onPageFinished(view: WebView, url: String?) = client.onPageFinished(view, url)
                            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                                val html = when (request.url.toString()) {
                                    base + "income" -> income
                                    base + "signature" -> signature
                                    base + "confirmation" -> { if (request.isForMainFrame) submissions.incrementAndGet(); receipt }
                                    else -> "<p>Fixture resource</p>"
                                }
                                val body = "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><style>body{padding:20px}label,input,button{display:block;margin:12px 0}input,button{min-height:32px}</style><main>$html</main>"
                                return WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream(body.toByteArray()))
                            }
                        })
                    }
                }
            })
            view = controller.createWebView()
            activity.setContentView(FrameLayout(activity).apply { addView(view, FrameLayout.LayoutParams(-1, -1)) })
        }
        return Harness(scenario, controller, view, store, scope, directory, submissions, policyClient)
    }

    private fun postRequest(url: String, mainFrame: Boolean) = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame(): Boolean = mainFrame
        override fun isRedirect(): Boolean = false
        override fun hasGesture(): Boolean = true
        override fun getMethod(): String = "POST"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    private fun close(h: Harness) {
        var failure: Throwable? = null
        fun cleanup(block: () -> Unit) {
            try { block() } catch (error: Throwable) {
                if (failure == null) failure = error else failure!!.addSuppressed(error)
            }
        }
        cleanup { main { h.controller.destroy() } }
        cleanup { main { h.scope.cancel() } }
        cleanup { runBlocking { withContext(Dispatchers.Main) { h.store.deleteAllData() } } }
        cleanup { h.scenario.close() }
        cleanup { check(h.directory.deleteRecursively()) { "Synthetic fixture directory could not be removed" } }
        failure?.let { throw it }
    }

    private fun withHarness(block: (Harness) -> Unit) {
        val harness = harness()
        var outcome: Throwable? = null
        try {
            block(harness)
        } catch (error: Throwable) {
            outcome = error
            throw error
        } finally {
            try { close(harness) } catch (cleanupError: Throwable) {
                // Preserve test failures and unsupported-provider assumptions if cleanup also fails.
                if (outcome == null) throw cleanupError else outcome.addSuppressed(cleanupError)
            }
        }
    }

    @Test fun unsupportedProviderRemainsManualAndStopRevokesSharing() = withHarness { h ->
        // Exercise the real request policy without sending these synthetic POSTs to a network.
        assertNotNull(main { h.policyClient.shouldInterceptRequest(h.view, postRequest("https://outside.example/submit", true)) })
        assertNull(main { h.policyClient.shouldInterceptRequest(h.view, postRequest(base + "income", true)) })
        assertNull(main { h.policyClient.shouldInterceptRequest(h.view, postRequest("https://captcha.example/resource", false)) })
        val supportsWorld = main { WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD) }
        assertEquals(supportsWorld, main { h.controller.supported })
        if (!supportsWorld) {
            main { h.controller.start() }
            assertFalse(main { h.controller.started })
            assertNull(main { h.controller.preview })
            assertEquals("\"undefined\"", evaluate(h.view, "typeof SecondHandBridge"))
        }
        main { h.controller.stop() }
        assertNull(main { h.store.currentAssistantGrant() })
        assertEquals(0, h.submissions.get())
    }

    @Test fun isolatedControllerCompletesSyntheticWorkflowWithOneApprovedSubmission() = withHarness { h ->
        assumeTrue("Installed WebView lacks isolated-world support", main { h.controller.supported })
        awaitCondition("Isolated bridge became ready") { h.controller.ready }
        assertEquals("\"undefined/undefined\"", evaluate(h.view, "typeof SecondHandBridge + '/' + typeof SecondHandAndroid"))
        main { h.controller.start() }
        awaitCondition("Unknown page awaits explicit mapping") { !h.controller.busy && h.controller.preview?.kind == "mapping" }
        val income = main { h.controller.preview!! }
        assertEquals("\"\"", evaluate(h.view, "document.getElementById('earnings').value"))
        main { h.controller.fillSelected(income, mapOf(income.fields.single().id to "monthlyIncome")) }
        awaitCondition("Mapped answer filled") { !h.controller.busy && h.controller.filled == 1 }
        assertEquals("\"1234.50\"", evaluate(h.view, "document.getElementById('earnings').value"))
        val next = main { h.controller.preview!! }
        main { h.controller.act(next, next.actions.single(), false) }
        awaitCondition("Next page was recognized") { !h.controller.busy && h.controller.preview?.kind == "signature" }
        assertEquals(0, h.submissions.get())
        val unsigned = main { h.controller.preview!! }
        main { h.controller.act(unsigned, unsigned.actions.single(), false) }
        awaitCondition("Unapproved submission was rejected") { !h.controller.busy && h.controller.paused }
        assertEquals(0, h.submissions.get())
        main { h.controller.resume() }
        awaitCondition("Signature review restored") { !h.controller.busy && h.controller.preview?.kind == "signature" }
        evaluate(h.view, "document.getElementById('signature').value='Example Applicant';document.getElementById('signed').checked=true;true")
        main { h.controller.checkPage() }
        awaitCondition("Signed review captured") { !h.controller.busy && h.controller.preview != null }
        val stale = main { h.controller.preview!! }
        evaluate(h.view, "document.getElementById('terms').textContent='Updated statement';true")
        main { h.controller.checkPage() }
        awaitCondition("New review captured") { !h.controller.busy && h.controller.preview?.token != stale.token }
        main { h.controller.act(stale, stale.actions.single(), true) }
        awaitCondition("Stale native approval rejected") { !h.controller.busy && h.controller.paused }
        assertEquals(0, h.submissions.get())
        main { h.controller.resume() }
        awaitCondition("Current signature review restored") { !h.controller.busy && h.controller.preview?.kind == "signature" }
        val approved = main { h.controller.preview!! }
        main { h.controller.act(approved, approved.actions.single(), true) }
        awaitCondition("One submission attempted") { h.controller.ready && h.controller.currentURL == base + "confirmation" }
        assertEquals(1, h.submissions.get())
        main { h.controller.act(approved, approved.actions.single(), true); h.controller.checkPage() }
        awaitCondition("Receipt page recognized") { !h.controller.busy && h.controller.preview?.kind == "receipt" }
        assertEquals(1, h.submissions.get())
        val receipt = main { h.controller.preview!! }
        main { h.controller.recordReceipt(receipt, "EXAMPLE-123", true) }
        awaitCondition("User-reported confirmation saved") { !h.controller.busy && !h.controller.started }
        assertEquals("EXAMPLE-123", main { h.store.data.renewal.confirmationNumber })
        assertNull(main { h.store.currentAssistantGrant() })
    }
}
