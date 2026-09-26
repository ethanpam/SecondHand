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
        .background(PrivacyShield().frame(width: 0, height: 0))
        .task { await store.unlock() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { store.lock() }
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

    var body: some View {
        ZStack {
            AppTheme.canvas.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 24) {
                Spacer()
                Image(systemName: "hand.raised.fingers.spread.fill")
                    .font(.system(size: 58))
                    .foregroundStyle(AppTheme.accent)
                    .padding(26)
                    .background(AppTheme.softGreen, in: RoundedRectangle(cornerRadius: 34))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 14) {
                    Text("Second Hand").font(.largeTitle.bold()).foregroundStyle(AppTheme.ink)
                    Text("Your next step,\na little easier.")
                        .font(.title2).foregroundStyle(AppTheme.ink)
                    Text("Keep your information, documents, and Iowa SNAP deadlines together on your iPhone.")
                        .font(.body).foregroundStyle(.secondary).lineSpacing(4)
                }
                Spacer()
                if store.isLoading {
                    ProgressView("Unlocking your information…").frame(maxWidth: .infinity).padding()
                } else {
                    Button { Task { await store.unlock() } } label: {
                        Label("Unlock Second Hand", systemImage: "lock.open")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
                Text("Protected with your iPhone’s authentication.\nIndependent app • Not affiliated with Iowa HHS")
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).frame(maxWidth: .infinity)
            }
            .padding(28)
            .frame(maxWidth: 600)
        }
    }
}
