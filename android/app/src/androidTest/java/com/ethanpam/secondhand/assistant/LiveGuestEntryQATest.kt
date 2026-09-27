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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Opt-in, GET-only live entry check. Never fills a live field, solves a CAPTCHA, or saves an application. */
class LiveGuestEntryQATest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val guestURL = AssistantController.PORTAL + "/applyForBenefits/guestLogin"

    private fun <T> main(block: () -> T): T {
        var result: Result<T>? = null
        instrumentation.runOnMainSync { result = runCatching(block) }
        return result!!.getOrThrow()
    }

    private fun evaluate(view: WebView, script: String): String {
        val latch = CountDownLatch(1)
        var answer = ""
        main { view.evaluateJavascript(script) { answer = it; latch.countDown() } }
        assertTrue("Read-only DOM inspection completed", latch.await(10, TimeUnit.SECONDS))
        return answer
    }

    private fun awaitCondition(message: String, condition: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + 45_000
        while (SystemClock.elapsedRealtime() < until) {
            if (main(condition)) return
            SystemClock.sleep(100)
        }
        fail(message)
    }

    @Test fun guestEntryLoadsButNeverReceivesTheFictionalVaultProfile() {
        assumeTrue("Explicit liveIowaEntry=true is required for this GET-only network check",
            InstrumentationRegistry.getArguments().getString("liveIowaEntry") == "true")
        val context = instrumentation.targetContext
        val id = UUID.randomUUID().toString()
        val directory = File(context.noBackupFilesDir, "live-entry-qa-$id").apply { mkdirs() }
        val testContext = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getNoBackupFilesDir(): File = directory
        }
        val store = main { AppStore.forTesting(testContext, id) }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val scenario = ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java))
        val blockedWrites = AtomicInteger()
        val getRequests = AtomicInteger()
        var controller: AssistantController? = null
        var failure: Throwable? = null
        try {
            runBlocking { withContext(Dispatchers.Main) {
                assertTrue(store.unlock())
                val fake = PersonalProfile(firstName = "SecondHandQA", lastName = "DoNotFile",
                    email = "secondhand-qa@example.invalid", reviewedAt = System.currentTimeMillis())
                store.saveProfile(fake)
                store.lock()
                assertTrue(store.unlock())
                assertEquals(fake, store.data.profile)
                store.authorizeAutofill()
            } }
            lateinit var view: WebView
            scenario.onActivity { activity ->
                controller = AssistantController(activity, store, scope, webViewFactory = { owner ->
                    object : WebView(owner) {
                        override fun loadUrl(url: String) { super.loadUrl(if (url == AssistantController.PORTAL) guestURL else url) }
                        override fun setWebViewClient(client: WebViewClient) {
                            super.setWebViewClient(object : WebViewClient() {
                                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = client.shouldOverrideUrlLoading(view, request)
                                override fun onPageStarted(view: WebView, url: String?, icon: Bitmap?) = client.onPageStarted(view, url, icon)
                                override fun onPageFinished(view: WebView, url: String?) = client.onPageFinished(view, url)
                                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                                    // Fail closed before the network layer; no POST, telemetry beacon, or form-save request is sent.
                                    if (request.method != "GET") {
                                        blockedWrites.incrementAndGet()
                                        return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                                    }
                                    val denied = client.shouldInterceptRequest(view, request)
                                    if (denied == null) getRequests.incrementAndGet()
                                    return denied
                                }
                            })
                        }
                    }
                })
                view = controller!!.createWebView()
                activity.setContentView(FrameLayout(activity).apply { addView(view, FrameLayout.LayoutParams(-1, -1)) })
            }
            val assistant = controller!!
            assertTrue("QA emulator must support isolated worlds", main { assistant.supported })
            awaitCondition("Live Iowa entry became ready; network/portal failure is not a passing QA result") { assistant.ready }
            assertEquals(guestURL, main { view.url })
            assertEquals("true", evaluate(view, "document.body.innerText.includes('Household Application Information')"))
            assertEquals("true", evaluate(view, "!!document.getElementById('householdApplicationForm')"))
            assertEquals("true", evaluate(view, "!!document.querySelector('[name=captchaAnswer],.g-recaptcha,iframe[src*=recaptcha]')"))
            main { assistant.start() }
            awaitCondition("Guest/login route must refuse assistance") { !assistant.busy }
            assertFalse(main { assistant.started })
            assertNull(main { assistant.preview })
            assertEquals(0, main { assistant.filled })
            assertEquals("false", evaluate(view, "Array.from(document.querySelectorAll('input,textarea')).some(e=>/SecondHandQA|DoNotFile|secondhand-qa@example.invalid/.test(e.value))"))
            assertEquals("\"undefined/undefined\"", evaluate(view, "typeof SecondHandBridge+'/'+typeof SecondHandAndroid"))
            assertTrue("Actual live GETs occurred", getRequests.get() > 0)
            val output = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
                ?: File(context.getExternalFilesDir(null), "ui-test-screenshots")
            output.mkdirs()
            File(output, "live-guest-entry-qa.txt").writeText(
                "GET-only live URL: $guestURL\nHousehold form and security check observed.\n" +
                    "Fictional vault profile persisted and reloaded; zero live fields filled.\n" +
                    "Guest/login assistance rejected; page-world bridge absent.\n" +
                    "GET requests observed: ${getRequests.get()}; non-GET requests blocked: ${blockedWrites.get()}.\n" +
                    "No Continue, signature, CAPTCHA answer, or submission was performed.\n")
            scenario.onActivity { it.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
            try {
                instrumentation.waitForIdleSync(); SystemClock.sleep(150)
                val screenshot = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
                File(output, "live-guest-entry.png").outputStream().use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
                screenshot.recycle()
            } finally { scenario.onActivity { it.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) } }
        } catch (error: Throwable) {
            failure = error
            throw error
        } finally {
            fun cleanup(block: () -> Unit) {
                try { block() } catch (error: Throwable) {
                    if (failure == null) failure = error else failure!!.addSuppressed(error)
                }
            }
            val originalFailure = failure
            cleanup { main { controller?.destroy(); scope.cancel() } }
            cleanup { runBlocking { withContext(Dispatchers.Main) { store.deleteAllData() } } }
            cleanup { scenario.close() }
            cleanup { check(directory.deleteRecursively()) }
            if (originalFailure == null) failure?.let { throw it }
        }
    }
}
