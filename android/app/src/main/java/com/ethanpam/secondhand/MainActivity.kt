package com.ethanpam.secondhand

import android.app.Application
import android.app.KeyguardManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.Lifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.ethanpam.secondhand.core.AppStore
import com.ethanpam.secondhand.ui.SecondHandRoot
import com.ethanpam.secondhand.ui.SecondHandTheme
import com.ethanpam.secondhand.ui.cleanupDocumentPreviews
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class SecondHandViewModel(application: Application) : AndroidViewModel(application) {
    val store = AppStore(application)
    var pendingDocument by mutableStateOf<Uri?>(null)
    override fun onCleared() { store.lock() }
}

class MainActivity : ComponentActivity() {
    private lateinit var model: SecondHandViewModel
    private var authentication: CancellationSignal? = null
    private var authenticationGeneration = 0
    private var pendingAuthenticationAt: Long? = null
    private var initialDemoUnlock = false
    private var authenticating by mutableStateOf(false)
    private var authenticationError by mutableStateOf<String?>(null)
    private val documentPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) model.pendingDocument = uri
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        model = ViewModelProvider(this)[SecondHandViewModel::class.java]
        lifecycleScope.launch(Dispatchers.IO) { cleanupDocumentPreviews(applicationContext) }
        setContent {
            SecondHandTheme {
                SecondHandRoot(store = model.store, authenticating = authenticating,
                    authenticationError = authenticationError, onAuthenticate = ::authenticate,
                    onPickDocument = { documentPicker.launch(arrayOf("application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/gif", "image/webp")) },
                    pendingDocument = model.pendingDocument, onDocumentConsumed = { model.pendingDocument = null })
            }
        }
        // Release builds cannot bypass device authentication, and a debug phone cannot either.
        initialDemoUnlock = demoAuthenticationAllowed()
    }

    private fun authenticate() {
        if (authenticating || model.store.state.value.isUnlocked) return
        authenticationError = null
        if (demoAuthenticationAllowed()) {
            unlockWhenResumed()
            return
        }
        val keyguard = getSystemService(KeyguardManager::class.java)
        if (!keyguard.isDeviceSecure) {
            authenticationError = "Set a screen lock on this phone in Android Settings, then return to unlock Second Hand."
            return
        }
        val allowed = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val manager = getSystemService(BiometricManager::class.java)
        if (manager.canAuthenticate(allowed) != BiometricManager.BIOMETRIC_SUCCESS) {
            authenticationError = "Device authentication is unavailable. Check your phone’s screen lock and try again."
            return
        }
        authenticating = true
        val attempt = ++authenticationGeneration
        val signal = CancellationSignal()
        authentication = signal
        BiometricPrompt.Builder(this)
            .setTitle("Unlock Second Hand")
            .setSubtitle("Your information stays on this phone")
            .setAllowedAuthenticators(allowed)
            .build().authenticate(signal, mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (attempt != authenticationGeneration) return
                    authentication = null
                    authenticating = false
                    pendingAuthenticationAt = android.os.SystemClock.elapsedRealtime()
                    consumePendingAuthentication()
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (attempt != authenticationGeneration) return
                    authentication = null
                    authenticating = false
                    if (errorCode !in listOf(BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED, BiometricPrompt.BIOMETRIC_ERROR_CANCELED)) {
                        authenticationError = "Authentication was not completed. Try again using your screen lock or biometrics."
                    }
                }
            })
    }

    override fun onResume() {
        super.onResume()
        // Lifecycle dispatch completes after onResume; the next main-loop turn is RESUMED.
        window.decorView.post {
            if (initialDemoUnlock) { initialDemoUnlock = false; unlockWhenResumed() }
            else consumePendingAuthentication()
        }
    }

    private fun consumePendingAuthentication() {
        val authenticatedAt = pendingAuthenticationAt ?: return
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
        pendingAuthenticationAt = null
        if (android.os.SystemClock.elapsedRealtime() - authenticatedAt > 30_000) {
            authenticationError = "Please unlock again to continue."
            return
        }
        unlockWhenResumed()
    }

    private fun unlockWhenResumed() {
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
        val attempt = authenticationGeneration
        authenticating = true
        lifecycleScope.launch {
            val unlocked = model.store.unlock()
            if (attempt == authenticationGeneration) {
                authenticating = false
                if (!unlocked && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                    authenticationError = model.store.state.value.errorMessage ?: "Your saved information could not be unlocked."
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) {
            model.store.lock()
            lifecycleScope.launch(Dispatchers.IO) { cleanupDocumentPreviews(applicationContext) }
            // Android may display the device-credential prompt in another activity.
            // Keep that prompt alive while the vault remains locked. A successful
            // result is consumed only after returning to this resumed activity.
            if (authentication == null && pendingAuthenticationAt == null) {
                authenticationGeneration++
                authenticating = false
            }
        }
    }

    override fun onDestroy() {
        authenticationGeneration++
        authentication?.cancel()
        authentication = null
        pendingAuthenticationAt = null
        super.onDestroy()
    }

    private fun demoAuthenticationAllowed(): Boolean = BuildConfig.DEBUG && intent.getBooleanExtra("ui_testing", false) && isEmulator()

    private fun isEmulator(): Boolean = Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.startsWith("unknown") ||
        Build.MODEL.contains("google_sdk") || Build.MODEL.contains("Emulator") || Build.MODEL.contains("Android SDK built for") ||
        (Build.MANUFACTURER.contains("Genymotion")) || (Build.HARDWARE == "goldfish" || Build.HARDWARE == "ranchu")
}
