package app.harbor0.android

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/** An installation's ECDSA P-256 signing key. Its fingerprint is the installation's device ID. */
class DeviceKey(val publicKey: ByteArray, private val privateKey: PrivateKey) {
    val fingerprint: String = base64Url(MessageDigest.getInstance("SHA-256").digest(publicKey))

    /** Signs the server's session-bound challenge; matches `deviceProofMessage` in contracts. */
    fun proof(challenge: String, userId: String): JsonObject {
        val message = listOf("harbor0-device-v1", challenge, userId, fingerprint).joinToString("\n")
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey); update(message.toByteArray()); sign()
        }
        return buildJsonObject {
            put("publicKey", base64Url(publicKey)); put("challenge", challenge); put("signature", base64Url(signature))
        }
    }

    private companion object {
        fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}

interface DeviceKeyStore {
    fun key(account: String): DeviceKey
}

/** One non-exportable Keystore key per account and server, so installations are not linkable across accounts. */
class KeystoreDeviceKeys(private val context: Context, private val realm: String = BuildConfig.API_URL): DeviceKeyStore {
    override fun key(account: String): DeviceKey {
        val scope = MessageDigest.getInstance("SHA-256").digest("${realm.trimEnd('/')}\n$account".toByteArray())
            .joinToString("") { "%02x".format(it) }
        val alias = context.packageName + ".device." + scope
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry)?.let {
            return DeviceKey(it.certificate.publicKey.encoded, it.privateKey)
        }
        fun generate(strongBox: Boolean) = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .apply { if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true) }
                .build())
        }.generateKeyPair()
        // Prefer a dedicated secure element; most devices fall back to the TEE.
        val pair = runCatching { generate(true) }.getOrElse { generate(false) }
        return DeviceKey(pair.public.encoded, pair.private)
    }
}
