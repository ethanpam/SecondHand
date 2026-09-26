package com.ethanpam.secondhand

import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.view.WindowManager
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.ethanpam.secondhand.core.AppStore
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Runs only on a dedicated emulator with synthetic data. It never opens Iowa's website. */
@RunWith(AndroidJUnit4::class)
class AppWorkflowTest {
    @get:Rule val compose = createEmptyComposeRule()
    private var scenario: ActivityScenario<MainActivity>? = null
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before fun cleanTestVault() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            runBlocking {
                val store = AppStore(context)
                check(store.unlock())
                store.deleteAllData()
            }
        }
    }

    @After fun closeActivity() { scenario?.close() }

    private fun launch() {
        scenario = ActivityScenario.launch(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("ui_testing", true))
    }
    private fun awaitText(text: String) {
        compose.waitUntil(timeoutMillis = 15_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun tapTab(title: String) { compose.onNode(hasText(title) and hasClickAction()).performClick() }

    @Test fun profilePersistsAfterRelaunchAndDataCanBeLockedAndDeleted() {
        launch()
        awaitText("Your next step starts here")
        capture("overview-empty.png")
        tapTab("Profile")
        compose.onNodeWithText("Edit and review my profile").performClick()
        compose.onNode(hasText("First name") and hasSetTextAction()).performScrollTo().performTextInput("Demo")
        compose.onNode(hasText("Last name") and hasSetTextAction()).performScrollTo().performTextInput("Applicant")
        scenario?.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
        compose.waitUntil(15_000) { context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE }
        compose.onNode(hasText("First name") and hasSetTextAction()).performScrollTo().assertTextContains("Demo")
        compose.onNode(hasText("Last name") and hasSetTextAction()).performScrollTo().assertTextContains("Applicant")
        scenario?.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
        compose.waitUntil(15_000) { context.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT }
        compose.onNodeWithText("I reviewed these details and they are accurate today.").performScrollTo()
        compose.onNode(isToggleable()).performClick()
        compose.onNode(hasText("Save") and hasClickAction()).performClick()
        awaitText("Demo Applicant")

        scenario?.close()
        launch()
        awaitText("Welcome back, Demo")
        tapTab("Profile")
        compose.onNodeWithText("Edit and review my profile").performClick()
        compose.onNode(hasText("First name") and hasSetTextAction()).performScrollTo().performTextReplacement("Unsaved")
        scenario?.moveToState(Lifecycle.State.CREATED)
        scenario?.moveToState(Lifecycle.State.RESUMED)
        awaitText("Unlock Second Hand")
        compose.onNodeWithText("Unlock Second Hand").performClick()
        awaitText("Demo Applicant")
        compose.onNodeWithText("Unsaved").assertDoesNotExist()
        tapTab("Overview")
        compose.onNodeWithContentDescription("Lock Second Hand").performClick()
        awaitText("Unlock Second Hand")
        compose.onNodeWithText("Unlock Second Hand").performClick()
        awaitText("Welcome back, Demo")

        tapTab("Documents")
        compose.onNodeWithText("A home for your paperwork").assertExists()
        capture("documents-empty.png")
        tapTab("Settings")
        compose.onNodeWithText("Delete all app data").performScrollTo().performClick()
        compose.onNode(hasText("Delete all data") and hasClickAction()).performClick()
        awaitText("Unlock Second Hand")
        compose.onNodeWithText("Unlock Second Hand").performClick()
        compose.waitUntil(15_000) { compose.onAllNodes(hasText("Overview") and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        tapTab("Overview")
        awaitText("Your next step starts here")
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        // Instrumentation temporarily permits a synthetic screenshot. Production
        // code always keeps FLAG_SECURE on, including debug builds.
        scenario?.onActivity { it.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
        try {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            android.os.SystemClock.sleep(150) // Let the test-only surface flag reach the compositor.
            val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            checkNotNull(bitmap)
            val additionalOutput = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.takeIf { it.isNotBlank() }
            val directory = (additionalOutput?.let { File(it) } ?: File(context.getExternalFilesDir(null), "ui-test-screenshots")).apply { mkdirs() }
            File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        } finally { scenario?.onActivity { it.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) } }
    }
}
