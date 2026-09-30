package app.harbor0.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface CredentialStore {
    fun load(): SavedSession?
    fun save(session: SavedSession)
    fun clear()
}

/** The encryption key never leaves Android Keystore; credentials are excluded from backup. */
class KeystoreCredentials(context: Context, realm: String = BuildConfig.API_URL): CredentialStore {
    private val scope = java.security.MessageDigest.getInstance("SHA-256").digest(realm.trimEnd('/').toByteArray())
        .joinToString("") { "%02x".format(it) }
    private val preferences = context.getSharedPreferences("credentials_$scope", Context.MODE_PRIVATE)
    private val alias = context.packageName + ".session." + scope
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    override fun load(): SavedSession? {
        val encoded = preferences.getString("session", null) ?: return null
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.size > 12) { "Saved sign-in could not be read. Remove it and sign in again." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return harborJson.decodeFromString(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    }
    override fun save(session: SavedSession) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.iv + cipher.doFinal(harborJson.encodeToString(session).toByteArray())
        check(preferences.edit().putString("session", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()) { "Could not save your sign-in securely. Try again." }
    }
    override fun clear() {
        check(preferences.edit().clear().commit()) { "Could not remove the saved sign-in. Try again." }
    }
}
