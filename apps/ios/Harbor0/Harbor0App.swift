import SwiftUI

@main
struct Harbor0App: App {
    @StateObject private var api: HarborAPI
    @StateObject private var transfers: TransferCenter
    @StateObject private var appearance: AppearanceStore
    @StateObject private var workspace: Workspace
    @MainActor private static var sync: SyncCenter?
    init() {
        FileTransfers.cleanPreviousLaunch()
        let api = HarborAPI()
        let appearance = AppearanceStore()
        let sync = SyncCenter(api: api)
        Self.sync = sync
        // Background catch-up must be registered before launch finishes.
        SyncCenter.register { Harbor0App.sync }
        _api = StateObject(wrappedValue: api)
        _appearance = StateObject(wrappedValue: appearance)
        _transfers = StateObject(wrappedValue: TransferCenter(api: api))
        _workspace = StateObject(wrappedValue: Workspace(api: api, appearance: appearance, sync: sync))
    }
    var body: some Scene {
        WindowGroup {
            RootView(api: api, transfers: transfers, appearance: appearance)
                .environmentObject(transfers)
                .environmentObject(appearance)
                .environmentObject(workspace)
                .preferredColorScheme(appearance.appearance.colorScheme)
        }
    }
}

private struct RootView: View {
    @ObservedObject var api: HarborAPI
    @ObservedObject var transfers: TransferCenter
    @ObservedObject var appearance: AppearanceStore
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.colorScheme) private var colorScheme
    private var tokens: ThemeTokens {
        let palette = appearance.appearance.palette(for: colorScheme).tokensPalette
        return palette.on(palette.background)
    }
    var body: some View {
        Group {
            if api.restoring {
                VStack(spacing: 14) {
                    BrandMark(size: 40)
                    Text("Opening harbor0…").font(TypeScale.sm).foregroundStyle(tokens.text2)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(tokens.background)
            } else if api.signedIn {
                Shell()
            } else {
                AuthScreen(api: api)
            }
        }
        .environment(\.tokens, tokens)
        .tint(tokens.primary)
        .foregroundStyle(tokens.text)
        .font(TypeScale.base)
        .sheet(isPresented: $transfers.showingPreview, onDismiss: { transfers.dismissPreview() }) {
            if let url = transfers.previewURL {
                FilePreview(url: url) { transfers.showingPreview = false }
                    .ignoresSafeArea()
            }
        }
        .onChange(of: api.signedIn) { _, signedIn in
            if !signedIn {
                transfers.reset(); appearance.reset(); workspace.reset()
                Task { await workspace.sync.disconnect() }
            }
        }
        .task { await api.restore() }
    }
}

// MARK: - Sign in, sign up, confirm, forgot and reset (auth-page.tsx)

enum AuthMode { case login, signup, confirm, forgot, reset }

struct AuthScreen: View {
    @ObservedObject var api: HarborAPI
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.tokens) private var tokens
    @State private var mode: AuthMode = .login
    @State private var email = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var username = ""
    @State private var usernameEdited = false
    @State private var code = ""
    @State private var error: String?
    @State private var unverified = false
    @State private var notice: (AuthMode, String)?
    @State private var busy = false
    @State private var cooldown = 0
    @State private var cooldownTask: Task<Void, Never>?

    private var copy: (title: String, lead: String, submit: String, busy: String) {
        switch mode {
        case .login: ("Welcome back", "Sign in to your files.", "Sign in", "Signing in…")
        case .signup: ("Create your account", "100 GB of private storage, free.", "Create your account", "Creating account…")
        case .confirm: ("Check your email", "Enter the 6-digit code we sent you.", "Verify email", "Verifying…")
        case .forgot: ("Reset your password", "Enter your account email and we’ll send you a reset code.", "Send reset code", "Sending…")
        case .reset: ("Set a new password", "Enter the code from your email and choose a new password.", "Reset password", "Saving…")
        }
    }
    private var newPassword: Bool { mode == .signup || mode == .reset }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                story.surface({ $0.sidebar }, paint: false)
                form
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .background(alignment: .top) {
            VStack(spacing: 0) { tokens.sidebar.frame(height: 420); tokens.background }.ignoresSafeArea()
        }
        .onChange(of: mode) { _, _ in error = nil; unverified = false; password = "" }
    }

    private var story: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 8) {
                BrandMark(size: 32)
                Text("harbor0").font(Font.geist(18, 600)).tracking(-0.3)
                Spacer()
                ThemeToggle()
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Your files, everywhere.").font(Font.geist(26, 600)).tracking(-0.9)
                Text("Store, sync, and share files across every device you own.")
                    .font(Font.geist(15)).foregroundStyle(tokens.onSidebar.text2).lineSpacing(4)
            }
            HStack(spacing: 8) {
                Icon(.shieldCheck, size: 15)
                Text("Files are private unless you share them.").font(TypeScale.xs)
            }.foregroundStyle(tokens.onSidebar.text2)
        }
        .padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 20)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(copy.title).font(Font.geist(24, 600)).tracking(-0.6).padding(.bottom, 6).accessibilityIdentifier("authTitle")
            Group {
                if mode == .confirm && !email.isEmpty {
                    Text("Enter the 6-digit code we sent to ") + Text(email).foregroundColor(tokens.text).fontWeight(.medium) + Text(".")
                } else { Text(copy.lead) }
            }.font(TypeScale.sm).foregroundStyle(tokens.text2)
            if let notice, notice.0 == mode {
                AlertBanner(tone: .success, text: notice.1).padding(.top, 16).accessibilityIdentifier("authNotice")
            }
            VStack(alignment: .leading, spacing: 16) {
                Field(label: "Email") {
                    TextInput(placeholder: "you@example.com", text: Binding(get: { email }, set: { value in
                        email = value
                        if !usernameEdited { username = Self.usernameFrom(value) }
                    }), large: true, keyboard: .emailAddress, content: .username, identifier: "email") { submit() }
                }
                if mode == .signup {
                    Field(label: "Display name") {
                        TextInput(placeholder: "Your name", text: $displayName, large: true, content: .name, autocapitalize: true, identifier: "displayName")
                    }
                    Field(label: "Username", hint: "People can send files directly to your @username.") {
                        TextInput(placeholder: "", text: Binding(get: { username }, set: { value in
                            usernameEdited = true
                            username = value.lowercased().filter { $0.isLetter && $0.isASCII || $0.isNumber || $0 == "_" || $0 == "." }
                        }), prefix: "@", large: true, content: .username, identifier: "username")
                    }
                }
                if mode == .confirm || mode == .reset {
                    Field(label: "Verification code") {
                        TextField("", text: $code, prompt: Text("000000").foregroundStyle(tokens.text3.opacity(0.6)))
                            .font(.system(size: 18, design: .monospaced)).tracking(5.4)
                            .keyboardType(.numberPad).textContentType(.oneTimeCode)
                            .accessibilityIdentifier("code")
                            .modifier(InputChrome(focused: false, large: true))
                    }
                }
                if mode == .login || mode == .signup || mode == .reset {
                    Field(label: mode == .reset ? "New password" : "Password") {
                        if mode == .login {
                            Button("Forgot password?") { go(.forgot) }.harborButton(.link).font(TypeScale.sm).accessibilityIdentifier("forgotPassword")
                        }
                    } content: {
                        VStack(alignment: .leading, spacing: 6) {
                            PasswordInput(text: $password, newPassword: newPassword) { submit() }
                            if newPassword { rules }
                        }
                    }
                }
                if let error {
                    AlertBanner(tone: .danger, text: error, actionLabel: unverified ? "Verify now" : nil) { Task { await verifyInstead() } }
                        .accessibilityIdentifier("signInError")
                }
                if api.canRestore && mode == .login, let message = api.sessionMessage, error == nil {
                    AlertBanner(tone: .warning, text: message, actionLabel: "Retry saved sign-in") { Task { await api.restore() } }
                }
                Button { submit() } label: {
                    if busy { Spinner(size: 16) }
                    Text(busy ? copy.busy : copy.submit)
                }
                .harborButton(.primary, size: .lg, block: true)
                .disabled(busy || !canSubmit)
                .padding(.top, 4)
                .accessibilityIdentifier("signIn")
            }
            .padding(.top, 24)
            if mode == .confirm || mode == .reset {
                HStack(spacing: 4) {
                    Text("Didn’t get it?").foregroundStyle(tokens.text2)
                    if mode == .confirm {
                        Button(cooldown > 0 ? "Resend in \(cooldown)s" : "Resend code") { Task { await resend() } }
                            .harborButton(.link).disabled(busy || cooldown > 0)
                    } else {
                        Button("Send a new code") { go(.forgot) }.harborButton(.link)
                    }
                }.font(TypeScale.sm).padding(.top, 16)
            }
            VStack(alignment: .leading, spacing: 0) {
                Hairline().padding(.bottom, 20)
                HStack(spacing: 4) {
                    switch mode {
                    case .login:
                        Text("New to harbor0?").foregroundStyle(tokens.text2)
                        Button("Create an account") { go(.signup) }.harborButton(.link).accessibilityIdentifier("createAccount")
                    case .signup:
                        Text("Already have an account?").foregroundStyle(tokens.text2)
                        Button("Sign in") { go(.login) }.harborButton(.link)
                    default:
                        Button("Back to sign in") { go(.login) }.harborButton(.link)
                    }
                }.font(TypeScale.sm)
            }.padding(.top, 28)
        }
        .padding(.horizontal, 20).padding(.top, 32).padding(.bottom, 40)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 560, alignment: .top)
        .background(tokens.background, in: UnevenRoundedRectangle(topLeadingRadius: 16, topTrailingRadius: 16))
        .overlay(UnevenRoundedRectangle(topLeadingRadius: 16, topTrailingRadius: 16).stroke(tokens.line, lineWidth: 1).mask(
            VStack(spacing: 0) { Rectangle().frame(height: 24); Spacer() }))
    }

    private var rules: some View {
        let checks: [(String, Bool)] = [("12+ characters", password.count >= 12),
                                        ("Upper & lowercase", password.rangeOfCharacter(from: .lowercaseLetters) != nil && password.rangeOfCharacter(from: .uppercaseLetters) != nil),
                                        ("A number", password.rangeOfCharacter(from: .decimalDigits) != nil),
                                        ("A symbol", password.rangeOfCharacter(from: CharacterSet.alphanumerics.inverted) != nil)]
        return LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], spacing: 4) {
            ForEach(checks, id: \.0) { rule in
                HStack(spacing: 6) {
                    Icon(.check, size: 13).opacity(rule.1 ? 1 : 0.35)
                    Text(rule.0)
                }
                .font(TypeScale.xs)
                .foregroundStyle(rule.1 ? tokens.successText : tokens.text3)
                .accessibilityLabel(rule.0 + (rule.1 ? " (met)" : " (not met)"))
            }
        }
    }

    private var canSubmit: Bool {
        let hasEmail = !email.trimmingCharacters(in: .whitespaces).isEmpty
        switch mode {
        case .login: return hasEmail && !password.isEmpty
        case .signup: return hasEmail && !displayName.trimmingCharacters(in: .whitespaces).isEmpty && username.count >= 3 && password.count >= 12
        case .confirm: return hasEmail && !code.isEmpty
        case .forgot: return hasEmail
        case .reset: return hasEmail && !code.isEmpty && password.count >= 12
        }
    }

    static func usernameFrom(_ email: String) -> String {
        String(email.split(separator: "@").first.map(String.init)?.lowercased().filter { ($0.isLetter && $0.isASCII) || $0.isNumber || $0 == "_" || $0 == "." }.prefix(32) ?? "")
    }

    private func go(_ next: AuthMode, notice text: String? = nil) {
        notice = text.map { (next, $0) }
        withAnimation(.easeOut(duration: 0.15)) { mode = next }
    }
    private func startCooldown() {
        cooldown = 30
        cooldownTask?.cancel()
        cooldownTask = Task {
            while cooldown > 0 && !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                cooldown -= 1
            }
        }
    }

    private func submit() {
        guard !busy, canSubmit else { return }
        busy = true
        error = nil
        unverified = false
        notice = nil
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        Task {
            defer { busy = false }
            do {
                switch mode {
                case .login:
                    try await api.login(email: address, password: password, deviceName: UIDevice.current.model)
                    password = ""
                case .signup:
                    let _: EmptyResponse = try await api.publicRequest("/v1/auth/signup", body: ["email": address, "password": password,
                        "displayName": displayName.trimmingCharacters(in: .whitespaces), "username": username])
                    startCooldown()
                    go(.confirm, notice: "We sent a verification code to \(address).")
                case .confirm:
                    let _: EmptyResponse = try await api.publicRequest("/v1/auth/confirm", body: ["email": address, "code": code.trimmingCharacters(in: .whitespaces)])
                    code = ""
                    go(.login, notice: "Email verified. Sign in to continue.")
                case .forgot:
                    let _: EmptyResponse = try await api.publicRequest("/v1/auth/forgot", body: ["email": address])
                    startCooldown()
                    go(.reset, notice: "If \(address) has an account, a reset code is on its way.")
                case .reset:
                    let _: EmptyResponse = try await api.publicRequest("/v1/auth/reset", body: ["email": address, "code": code.trimmingCharacters(in: .whitespaces), "password": password])
                    code = ""
                    go(.login, notice: "Password updated. Sign in with your new password.")
                }
            } catch {
                self.error = error.localizedDescription
                unverified = (error as? APIError)?.code == "EMAIL_NOT_VERIFIED"
            }
        }
    }
    private func resend() async {
        error = nil
        notice = nil
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !address.isEmpty else { error = "Enter your email to get a new code."; return }
        do {
            let _: EmptyResponse = try await api.publicRequest("/v1/auth/resend", body: ["email": address])
            startCooldown()
            notice = (.confirm, "A new code is on its way to \(address).")
        } catch { self.error = error.localizedDescription }
    }
    private func verifyInstead() async {
        await resend()
        let pending = notice
        mode = .confirm
        notice = pending
    }
}
