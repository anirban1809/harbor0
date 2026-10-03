import Foundation
import PushKit
import os

/// Lets harbor0 wake the Files extension when something changes on another device.
/// iOS delivers `fileProvider` pushes straight to the extension (no alert, no permission
/// prompt), which then reads the change feed. Without them, Files catches up when the app opens.
@MainActor
final class FilesPush: NSObject, PKPushRegistryDelegate {
    private let api: HarborAPI
    private var registry: PKPushRegistry?
    private var domain: String?
    private var sentToken: String?
    private let log = Logger(subsystem: "app.harbor0.ios", category: "push")

    init(api: HarborAPI) { self.api = api }

    /// Starts (or refreshes) push registration for this account's Files location.
    func start(domain: String) {
        self.domain = domain
        if let registry {
            if let token = registry.pushToken(for: .fileProvider) { upload(token) }
            return
        }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.fileProvider]
        self.registry = registry
    }
    /// The server forgets the token on sign-out; this only stops local registration.
    func stop() {
        registry?.desiredPushTypes = []
        registry = nil
        domain = nil
        sentToken = nil
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        guard type == .fileProvider else { return }
        let token = credentials.token
        Task { @MainActor in self.upload(token) }
    }
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        Task { @MainActor in
            self.sentToken = nil
            let _: EmptyResponse? = try? await self.api.request("/v1/devices/current/push", method: "DELETE")
        }
    }
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                                  for type: PKPushType, completion: @escaping () -> Void) {
        // File Provider pushes go to the extension; nothing to do in the app.
        completion()
    }

    private func upload(_ token: Data) {
        guard let domain else { return }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        guard hex != sentToken else { return }
        log.info("File Provider push token received (\(token.count) bytes)")
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        Task {
            do {
                let _: EmptyResponse = try await api.request("/v1/devices/current/push", method: "PUT", body: [
                    "token": hex, "environment": environment, "kind": "FILE_PROVIDER", "domain": domain,
                ])
                sentToken = hex
                log.info("File Provider push token registered with harbor0")
            } catch {
                log.error("Push registration failed: \(error.localizedDescription, privacy: .public)")
                // Older servers don't support push; Files still catches up when the app opens.
            }
        }
    }
}
