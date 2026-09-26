package com.ethanpam.secondhand.assistant

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.setContent
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.ethanpam.secondhand.MainActivity
import com.ethanpam.secondhand.core.AppStore
import com.ethanpam.secondhand.core.PersonalProfile
import com.ethanpam.secondhand.ui.SecondHandTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID

/** Renders the production native controls; every WebView request receives a local fixture. */
class AssistantScreenVisualTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test fun nativeAssistantRendersSyntheticPageBelowSystemBars() {
        val context = instrumentation.targetContext
        val testID = UUID.randomUUID().toString()
        val directory = File(context.noBackupFilesDir, "assistant-visual-$testID").apply { mkdirs() }
        val isolatedContext = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getNoBackupFilesDir(): File = directory
            override fun getCacheDir(): File = File(directory, "cache").apply { mkdirs() }
        }
        lateinit var store: AppStore
        runBlocking {
            withContext(Dispatchers.Main) {
                store = AppStore.forTesting(isolatedContext, testID)
                check(store.unlock())
                store.saveProfile(PersonalProfile(firstName = "Example", lastName = "Applicant", monthlyIncome = "1234.50", reviewedAt = System.currentTimeMillis()))
                store.authorizeAutofill()
            }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val scenario = ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java))
        lateinit var controller: AssistantController
        val fixtureURL = AssistantController.PORTAL + "/applyForBenefits/visualIncome"
        val fixture = """<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>body{font:16px sans-serif;margin:0;padding:24px;color:#243d35;background:#fff}h1{font-size:26px}label,input,button{display:block;margin:18px 0}input{box-sizing:border-box;width:100%;min-height:44px;border:1px solid #71887b;border-radius:6px}button{padding:12px 22px;background:#2b5c4a;color:white;border:0;border-radius:8px}.fixture{font-size:12px;color:#64796a}</style>
            <main><p class="fixture">LOCAL TEST FORM · NO DATA IS SENT</p><h1>Income</h1><p>Review your current income before continuing.</p>
            <form action="visualIncome"><label>Monthly earnings<input id="earnings" name="earnings"></label><button type="button">Continue</button></form></main>""".trimIndent()
        try {
            scenario.onActivity { activity ->
                controller = AssistantController(activity, store, scope, webViewFactory = { owner ->
                    object : WebView(owner) {
                        override fun loadUrl(url: String) { super.loadUrl(if (url == AssistantController.PORTAL) fixtureURL else url) }
                        override fun setWebViewClient(client: WebViewClient) {
                            super.setWebViewClient(object : WebViewClient() {
                                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = client.shouldOverrideUrlLoading(view, request)
                                override fun onPageStarted(view: WebView, url: String?, icon: Bitmap?) = client.onPageStarted(view, url, icon)
                                override fun onPageFinished(view: WebView, url: String?) = client.onPageFinished(view, url)
                                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                                    WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream(fixture.toByteArray()))
                            })
                        }
                    }
                })
                activity.setContent { SecondHandTheme { AssistantContent(store, controller, onClose = {}) } }
            }
            compose.waitForIdle()
            compose.waitUntil(20_000) { !controller.supported || controller.ready }
            compose.onNodeWithText("Iowa application assistant").assertExists()
            if (controller.supported) {
                compose.onNodeWithText("Start assistance").performClick()
                compose.waitUntil(20_000) { controller.preview != null && !controller.busy }
                assertTrue(controller.started)
            }
            var statusInset = 0
            scenario.onActivity { statusInset = it.window.decorView.rootWindowInsets.getInsets(WindowInsets.Type.statusBars()).top }
            val closeBounds = compose.onNodeWithText("Close").fetchSemanticsNode().boundsInWindow
            assertTrue("Native Close control must remain below the status bar", closeBounds.top >= statusInset - 1)
            capture(scenario, "assistant-native-fixture.png")
        } finally {
            scenario.close()
            runBlocking { withContext(Dispatchers.Main) { scope.cancel(); if (store.isUnlocked) store.deleteAllData() } }
            directory.deleteRecursively()
        }
    }

    private fun capture(scenario: ActivityScenario<MainActivity>, name: String) {
        compose.waitForIdle()
        scenario.onActivity { it.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
        try {
            instrumentation.waitForIdleSync()
            SystemClock.sleep(150)
            val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            val additionalOutput = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.takeIf { it.isNotBlank() }
            val directory = (additionalOutput?.let { File(it) } ?: File(instrumentation.targetContext.getExternalFilesDir(null), "ui-test-screenshots")).apply { mkdirs() }
            File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        } finally { scenario.onActivity { it.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) } }
    }
}
