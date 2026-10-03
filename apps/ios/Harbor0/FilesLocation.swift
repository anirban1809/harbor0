import FileProvider

/// The harbor0 location in the Files app (the Harbor0FileProvider extension), one per signed-in account.
enum FilesLocation {
    /// Shows My Drive in the Files app for this account and shares the session with the extension.
    static func enable(apiURL: URL, userId: String) async {
        SharedAccount.save(apiURL: apiURL, userId: userId)
        let wanted = NSFileProviderDomainIdentifier(userId)
        let existing = (try? await NSFileProviderManager.domains()) ?? []
        for domain in existing where domain.identifier != wanted { try? await NSFileProviderManager.remove(domain) }
        if !existing.contains(where: { $0.identifier == wanted }) {
            try? await NSFileProviderManager.add(NSFileProviderDomain(identifier: wanted, displayName: "harbor0"))
        }
        refresh()
    }
    /// Removes the location and its downloaded copies when the account signs out. Edits that
    /// have not uploaded yet are lost with it, so this only runs on an explicit sign-out.
    static func disable() async {
        SharedAccount.clear()
        try? await NSFileProviderManager.removeAllDomains()
    }
    /// Asks Files to pick up changes made elsewhere, e.g. when the app comes to the foreground.
    static func refresh() {
        guard let userId = SharedAccount.userId else { return }
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(userId), displayName: "harbor0")
        NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet) { _ in }
    }
}
