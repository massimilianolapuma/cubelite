import Foundation
import Security

/// Service actor for secure storage and retrieval of Kubernetes credentials.
///
/// All Keychain operations are performed within the actor's isolated context.
/// Credentials are stored as generic password items tagged by service + account,
/// where account is typically the Kubernetes context name.
///
/// - Note: Client identity import (cert + key → `SecIdentity`) is prepared for M2
///   via ``KeychainService/importIdentity(_:key:account:)``.
actor KeychainService {

    // MARK: - Types

    /// Identifies the kind of credential stored in the Keychain.
    enum CredentialTag: String, Sendable {
        case bearerToken       = "it.lapuma.cubelite.bearer-token"
        case clientCertificate = "it.lapuma.cubelite.client-certificate"
        case clientKey         = "it.lapuma.cubelite.client-key"
    }

    // MARK: - Store

    /// Stores raw credential data in the Keychain.
    ///
    /// If a credential with the same tag and account already exists it is updated;
    /// otherwise a new item is added.
    ///
    /// - Parameters:
    ///   - value:   The raw credential bytes to persist.
    ///   - tag:     The kind of credential (token, certificate, key).
    ///   - account: The account identifier — typically the Kubernetes context name.
    func store(_ value: Data, tag: CredentialTag, account: String) throws {
        let query = baseQuery(tag: tag, account: account)
        let lookupStatus = SecItemCopyMatching(query as CFDictionary, nil)

        switch lookupStatus {
        case errSecSuccess:
            let update: [CFString: Any] = [kSecValueData: value]
            let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw CubeliteError.keychainError(
                    reason: "Update failed: OSStatus \(updateStatus)"
                )
            }

        case errSecItemNotFound:
            var addQuery = baseQuery(tag: tag, account: account)
            addQuery[kSecValueData as String] = value
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw CubeliteError.keychainError(
                    reason: "Add failed: OSStatus \(addStatus)"
                )
            }

        default:
            throw CubeliteError.keychainError(
                reason: "Lookup failed: OSStatus \(lookupStatus)"
            )
        }
    }

    /// Stores a UTF-8 string credential in the Keychain.
    func storeString(_ value: String, tag: CredentialTag, account: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw CubeliteError.keychainError(reason: "Failed to encode credential as UTF-8")
        }
        try store(data, tag: tag, account: account)
    }

    // MARK: - Retrieve

    /// Retrieves raw credential data from the Keychain.
    ///
    /// - Returns: The stored bytes, or `nil` if no matching item is found.
    func retrieve(tag: CredentialTag, account: String) throws -> Data? {
        var query = baseQuery(tag: tag, account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            return result as? Data
        case errSecItemNotFound:
            return nil
        default:
            throw CubeliteError.keychainError(reason: "Retrieve failed: OSStatus \(status)")
        }
    }

    /// Retrieves a UTF-8 string credential from the Keychain.
    ///
    /// - Returns: The stored string, or `nil` if no matching item is found.
    func retrieveString(tag: CredentialTag, account: String) throws -> String? {
        guard let data = try retrieve(tag: tag, account: account) else {
            return nil
        }
        guard let string = String(data: data, encoding: .utf8) else {
            throw CubeliteError.keychainError(reason: "Stored credential is not valid UTF-8")
        }
        return string
    }

    // MARK: - Delete

    /// Removes a credential from the Keychain.
    ///
    /// Silently succeeds when no matching item exists.
    func delete(tag: CredentialTag, account: String) throws {
        let query = baseQuery(tag: tag, account: account)
        let status = SecItemDelete(query as CFDictionary)

        switch status {
        case errSecSuccess, errSecItemNotFound:
            return
        default:
            throw CubeliteError.keychainError(reason: "Delete failed: OSStatus \(status)")
        }
    }

    // MARK: - Identity Import (prepared for M2)

    /// Imports a PEM-encoded client certificate and private key into the Keychain,
    /// constructing a `SecIdentity` usable for mutual TLS authentication.
    ///
    /// - Parameters:
    ///   - certificateDER: DER-encoded client certificate data.
    ///   - keyDER:         DER-encoded private key data (PKCS#8 or SEC1).
    ///   - account:        The account identifier (Kubernetes context name).
    /// - Returns: A `SecIdentity` that bundles the certificate and its private key.
    func importIdentity(
        certificateDER: Data,
        keyDER: Data,
        account: String
    ) throws -> SecIdentity {
        var importedItems: CFArray?
        let options: [CFString: Any] = [
            kSecImportExportPassphrase: "",
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock
        ]

        // Build a minimal PKCS#12 bundle; real implementation requires
        // wrapping cert + key in PKCS#12 format (planned for M2).
        let status = SecPKCS12Import(
            certificateDER as CFData,
            options as CFDictionary,
            &importedItems
        )

        guard status == errSecSuccess, let items = importedItems as? [[CFString: Any]],
              let first = items.first,
              let identity = first[kSecImportItemIdentity] as! SecIdentity? else {
            throw CubeliteError.keychainError(
                reason: "Failed to import client identity: OSStatus \(status)"
            )
        }

        return identity
    }

    // MARK: - Private Helpers

    private func baseQuery(tag: CredentialTag, account: String) -> [String: Any] {
        [
            kSecClass as String:      kSecClassGenericPassword,
            kSecAttrService as String: tag.rawValue,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
    }
}
