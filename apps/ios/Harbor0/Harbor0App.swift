import SwiftUI

@main
struct Harbor0App: App {
    @StateObject private var api: HarborAPI
    @StateObject private var transfers: TransferState
    @StateObject private var appearance = AppearanceStore()
    init() {
        FileTransfers.cleanPreviousLaunch()
        let api = HarborAPI()
        _api = StateObject(wrappedValue: api)
        _transfers = StateObject(wrappedValue: TransferState(api: api))
    }
    var body: some Scene {
        WindowGroup {
            RootView(api: api, transfers: transfers, appearance: appearance)
                .environmentObject(transfers)
                .environmentObject(appearance)
                .preferredColorScheme(appearance.appearance.colorScheme)
        }
    }
}

private struct RootView: View {
    @ObservedObject var api: HarborAPI
    @ObservedObject var transfers: TransferState
    @ObservedObject var appearance: AppearanceStore
    @Environment(\.colorScheme) private var colorScheme
    private var palette: HarborPalette { appearance.appearance.palette(for: colorScheme) }
    var body: some View {
            Group {
                if api.restoring {
                    ProgressView("Opening harbor0…")
                } else if api.signedIn {
                    WorkspaceView(api: api)
                } else {
                    SignInView(api: api)
                }
            }
            .environment(\.harborPalette, palette)
            .tint(palette.accent)
            .foregroundStyle(palette.ink)
            .sheet(isPresented: $transfers.showingPreview, onDismiss: { transfers.dismissPreview() }) {
                if let url = transfers.previewURL {
                    FilePreview(url: url) { transfers.showingPreview = false }
                        .ignoresSafeArea()
                }
            }
            .alert("Transfer failed", isPresented: Binding(get: { transfers.error != nil }, set: { if !$0 { transfers.error = nil } })) {
                Button("OK", role: .cancel) { transfers.error = nil }
            } message: { Text(transfers.error ?? "") }
            .onChange(of: api.signedIn) { _, signedIn in if !signedIn { transfers.reset(); appearance.reset() } }
            .task { await api.restore() }
    }
}

struct SignInView: View {
    @ObservedObject var api: HarborAPI
    @Environment(\.harborPalette) private var palette
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @FocusState private var focused: Field?
    private enum Field { case email, password }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 16) {
                        Image("BrandIcon").renderingMode(.template).resizable().scaledToFit().frame(width: 56, height: 56)
                            .accessibilityHidden(true)
                        Text("harbor0").font(.system(size: 40, weight: .semibold)).tracking(-1.5)
                        Text("Your files, within reach.").font(.title2).foregroundStyle(.secondary)
                    }.padding(.bottom, 16)
                    VStack(alignment: .leading, spacing: 18) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Email").font(.subheadline.weight(.medium))
                            TextField("Email", text: $email, prompt: Text("you@example.com").foregroundColor(palette.cardInk.opacity(0.45)))
                                .textContentType(.username).keyboardType(.emailAddress)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .focused($focused, equals: .email).submitLabel(.next)
                                .onSubmit { focused = .password }.accessibilityIdentifier("email")
                                .padding(15).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Password").font(.subheadline.weight(.medium))
                            SecureField("Password", text: $password)
                                .textContentType(.password).focused($focused, equals: .password).submitLabel(.go)
                                .onSubmit { signIn() }.accessibilityIdentifier("password")
                                .padding(15).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                        }
                    }
                    if let message = api.sessionMessage {
                        Label(message, systemImage: "exclamationmark.circle").font(.subheadline)
                            .foregroundStyle(.red).accessibilityIdentifier("signInError")
                    }
                    if api.canRestore {
                        Button("Retry saved sign-in") { Task { await api.restore() } }.font(.subheadline)
                    }
                    Button(action: signIn) {
                        HStack { Spacer(); if busy { ProgressView().tint(Color(.systemBackground)) }; Text(busy ? "Signing in…" : "Sign in").fontWeight(.semibold); Spacer() }
                            .padding(.vertical, 10)
                    }.buttonStyle(.borderedProminent).disabled(busy || email.isEmpty || password.isEmpty)
                        .accessibilityIdentifier("signIn")
                    Link("Create an account on harbor0", destination: URL(string: "https://d1bpha1d51nhxy.cloudfront.net/signup")!)
                        .font(.subheadline).frame(maxWidth: .infinity)
                }.padding(28).padding(.top, 48).frame(maxWidth: 520)
                    .frame(maxWidth: .infinity)
            }.background(palette.background)
        }
    }

    private func signIn() {
        guard !busy, !email.isEmpty, !password.isEmpty else { return }
        focused = nil
        busy = true
        api.sessionMessage = nil
        Task {
            defer { busy = false }
            do {
                try await api.login(email: email, password: password, deviceName: UIDevice.current.model)
                password = ""
            } catch { api.sessionMessage = error.localizedDescription }
        }
    }
}
