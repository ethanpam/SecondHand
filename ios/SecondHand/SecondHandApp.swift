import SwiftUI

@main
struct SecondHandApp: App {
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            AppRootView()
                .environmentObject(store)
                .tint(AppTheme.accent)
        }
    }
}

struct AppRootView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            if store.isUnlocked {
                TabView {
                    OverviewView().tabItem { Label("Overview", systemImage: "square.grid.2x2") }
                    ProfileView().tabItem { Label("Profile", systemImage: "person.crop.circle") }
                    DocumentsView().tabItem { Label("Documents", systemImage: "doc.on.doc") }
                    SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }
                    #if DEBUG && targetEnvironment(simulator)
                    if ProcessInfo.processInfo.arguments.contains("--offline-qa") {
                        OfflineApplicantQAView().tabItem { Label("QA demo", systemImage: "testtube.2") }
                    }
                    #endif
                }
                .privacySensitive()
            } else {
                LockScreenView()
            }
            if scenePhase != .active {
                AppTheme.canvas.ignoresSafeArea()
                VStack(spacing: 18) {
                    Image(systemName: "hand.raised.fingers.spread.fill")
                        .font(.system(size: 48)).foregroundStyle(AppTheme.accent)
                    Text("Second Hand").font(.title2.weight(.semibold)).foregroundStyle(AppTheme.ink)
                    Text("A little support. All yours.").foregroundStyle(.secondary)
                }
                .accessibilityHidden(true)
            }
        }
        #if DEBUG && targetEnvironment(simulator)
        .padding(.top, ProcessInfo.processInfo.arguments.contains("--offline-qa") ? 28 : 0)
        .safeAreaInset(edge: .top, spacing: 0) {
            if ProcessInfo.processInfo.arguments.contains("--offline-qa") {
                Text("OFFLINE QA · FICTIONAL PROFILE · IPHONE SIMULATOR")
                    .font(.system(size: 10, weight: .bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color(red: 1, green: 0.92, blue: 0.70))
                    .foregroundStyle(Color(red: 0.25, green: 0.20, blue: 0.10))
            }
        }
        #endif
        .background(PrivacyShield().frame(width: 0, height: 0))
        .task { await store.unlock() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { store.lock() }
            if phase == .active && store.isUnlocked {
                Task { await store.consumePendingReceipts() }
            }
        }
        .alert("Something needs attention", isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
            Button("OK", role: .cancel) { store.errorMessage = nil }
        } message: {
            Text(store.errorMessage ?? "Please try again.")
        }
    }
}

struct LockScreenView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var pin = ""
    @State private var firstPIN = ""
    @State private var confirming = false

    private var digitCount: Int { store.needsPINSetup ? 4 : store.requiredPINDigits }
    private var title: String {
        if store.needsPINSetup { return confirming ? "Confirm your PIN" : "Create your four-digit PIN" }
        return "Enter PIN"
    }

    var body: some View {
        ZStack {
            AppTheme.canvas.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 20) {
                    Image("AppLogo")
                        .resizable().scaledToFit()
                        .frame(width: 88, height: 88)
                        .clipShape(RoundedRectangle(cornerRadius: 24))
                        .accessibilityHidden(true)
                    Text("Second Hand").font(.largeTitle.bold()).foregroundStyle(AppTheme.ink)
                    Text(title).font(.headline)
                    if digitCount == 6 {
                        Text("Enter your previous PIN once, then choose a new four-digit PIN.")
                            .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    HStack(spacing: 18) {
                        ForEach(0..<digitCount, id: \.self) { index in
                            Circle()
                                .fill(index < pin.count ? AppTheme.accent : Color.secondary.opacity(0.2))
                                .frame(width: 16, height: 16)
                        }
                    }
                    .padding(.vertical, 8)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("PIN")
                    .accessibilityValue("\(pin.count) of \(digitCount) digits entered")
                    .accessibilityIdentifier("auth.pin")

                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: 3), spacing: 12) {
                        ForEach(1...9, id: \.self) { digit in digitButton(digit) }
                        Color.clear.frame(height: 58).accessibilityHidden(true)
                        digitButton(0)
                        Button {
                            if !pin.isEmpty { pin.removeLast() }
                        } label: {
                            Image(systemName: "delete.left").font(.title2)
                                .frame(maxWidth: .infinity, minHeight: 58)
                        }
                        .accessibilityLabel("Delete last digit")
                        .accessibilityIdentifier("auth.delete")
                        .disabled(pin.isEmpty || store.isLoading)
                    }
                    .frame(maxWidth: 300)
                    Button(store.needsPINSetup ? (confirming ? "Create PIN" : "Continue") : "Continue with PIN", action: submit)
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(pin.count != digitCount || store.isLoading)
                        .accessibilityIdentifier("auth.continue")
                    if confirming {
                        Button("Choose a different PIN") { clearPIN() }
                            .disabled(store.isLoading)
                    }
                    if !store.needsPINSetup && store.faceIDEnabled {
                        Button {
                            clearPIN()
                            Task { await store.unlock() }
                        } label: { Label("Use Face ID", systemImage: "faceid") }
                        .disabled(store.isLoading)
                    }
                    if store.isLoading { ProgressView("Opening your information…") }
                }
                .padding(24).frame(maxWidth: 420).frame(maxWidth: .infinity)
            }
        }
        .onDisappear { clearPIN() }
        .onChange(of: store.needsPINSetup) { _, _ in clearPIN() }
        .onChange(of: scenePhase) { _, phase in if phase == .background { clearPIN() } }
    }

    private func digitButton(_ digit: Int) -> some View {
        Button {
            if pin.count < digitCount { pin.append(String(digit)) }
        } label: {
            Text(String(digit)).font(.title.weight(.medium))
                .frame(maxWidth: .infinity, minHeight: 58)
                .background(AppTheme.softGreen, in: RoundedRectangle(cornerRadius: 18))
        }
        .accessibilityLabel(String(digit))
        .accessibilityIdentifier("auth.digit.\(digit)")
        .disabled(pin.count >= digitCount || store.isLoading)
    }

    private func submit() {
        guard pin.count == digitCount, !store.isLoading else { return }
        let entered = pin
        pin = ""
        if store.needsPINSetup {
            if !confirming { firstPIN = entered; confirming = true; return }
            let original = firstPIN
            clearPIN()
            Task { await store.createPIN(original, confirmation: entered) }
        } else {
            Task { await store.unlock(pin: entered) }
        }
    }

    private func clearPIN() { pin = ""; firstPIN = ""; confirming = false }
}
