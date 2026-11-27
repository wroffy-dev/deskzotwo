package com.deskzo.calls

import android.content.Context

/** This phone's Deskzo: where it is and the phone's token. */
internal data class Session(val baseUrl: String, val token: String, val host: String?)

/**
 * What the app keeps on the phone, in its own private storage (never backed up: allowBackup is off).
 *
 *   · The session — the workspace's address and the phone's token, from pairing.
 *   · Call sync: on or off, from when (calls before it are never sent), and how far it has got.
 *
 * Kept here rather than in JavaScript so the background sync, with the app closed, can read it.
 */
internal object Store {
  private const val PREFS = "deskzo_app"

  private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun session(c: Context): Session? {
    val p = prefs(c)
    val base = p.getString("baseUrl", null) ?: return null
    val token = token(p) ?: return null
    return Session(base, token, p.getString("host", null))
  }

  /**
   * Security audit, 13 Nov 2026 (round two, phone lows): the token used to sit in this file as plain text, readable by
   * anything that could read the app's private files (a rooted phone, a forensic copy). It is now kept sealed under a
   * key that never leaves the Android Keystore (TokenSeal), as "tokenSealed". A plain "token" left by an older build is
   * sealed and removed the first time it is read. If the phone can't seal (a broken Keystore), the plain token is kept
   * rather than signing the person out; a sealed token that can no longer be opened (its key gone) reads as no session.
   */
  private fun token(p: android.content.SharedPreferences): String? {
    p.getString("tokenSealed", null)?.let { sealed -> return TokenSeal.open(sealed) }
    val plain = p.getString("token", null) ?: return null
    TokenSeal.seal(plain)?.let { sealed -> p.edit().putString("tokenSealed", sealed).remove("token").apply() }
    return plain
  }

  fun saveSession(c: Context, s: Session) {
    val edit = prefs(c).edit().putString("baseUrl", s.baseUrl).putString("host", s.host).putBoolean("signedOut", false)
    val sealed = TokenSeal.seal(s.token)
    if (sealed != null) edit.putString("tokenSealed", sealed).remove("token") else edit.putString("token", s.token).remove("tokenSealed")
    edit.apply()
  }

  /** Everything — signing out, or Deskzo saying this phone is no longer signed in. */
  fun clear(c: Context) {
    prefs(c).edit().clear().apply()
  }

  fun markSignedOut(c: Context) {
    prefs(c).edit().remove("token").remove("tokenSealed").putBoolean("signedOut", true).putBoolean("callSync", false).apply()
  }

  fun signedOut(c: Context): Boolean = prefs(c).getBoolean("signedOut", false)

  fun callSync(c: Context): Boolean = prefs(c).getBoolean("callSync", false) && session(c) != null

  fun setCallSync(c: Context, on: Boolean) {
    val p = prefs(c)
    val edit = p.edit().putBoolean("callSync", on)
    // Calls from before it was first switched on are never sent.
    if (on && p.getLong("syncFrom", 0L) == 0L) edit.putLong("syncFrom", System.currentTimeMillis())
    edit.apply()
  }

  fun syncFrom(c: Context): Long = prefs(c).getLong("syncFrom", 0L)

  /** The start of the latest call sent so far. */
  fun cursor(c: Context): Long = prefs(c).getLong("cursor", 0L)

  fun setCursor(c: Context, at: Long) {
    if (at > cursor(c)) prefs(c).edit().putLong("cursor", at).apply()
  }

  /** Whether to send the phone recorder's files (the workspace's switch, as /api/app/me says, and this phone's permission). */
  fun recordings(c: Context): Boolean = prefs(c).getBoolean("recordings", false) && session(c) != null

  fun setRecordings(c: Context, on: Boolean) {
    prefs(c).edit().putBoolean("recordings", on).apply()
  }

  /** Calls whose recording hasn't been found and sent yet (Recordings.kt). */
  fun waitingRecordings(c: Context): org.json.JSONArray = runCatching { org.json.JSONArray(prefs(c).getString("waitingRecordings", "[]")) }.getOrDefault(org.json.JSONArray())

  fun setWaitingRecordings(c: Context, list: org.json.JSONArray) {
    prefs(c).edit().putString("waitingRecordings", list.toString()).apply()
  }

  fun lastSyncAt(c: Context): Long = prefs(c).getLong("lastSyncAt", 0L)

  fun setLastSyncAt(c: Context, at: Long) {
    prefs(c).edit().putLong("lastSyncAt", at).apply()
  }

  /** Keys of calls Deskzo has already answered, inside the overlap CallSync re-reads (CallSync.kt). */
  fun answeredKeys(c: Context): Set<String> =
    runCatching { org.json.JSONArray(prefs(c).getString("answeredKeys", "[]")) }.getOrNull()
      ?.let { list -> (0 until list.length()).mapNotNull { list.optString(it).ifBlank { null } }.toSet() } ?: emptySet()

  fun setAnsweredKeys(c: Context, keys: Collection<String>) {
    prefs(c).edit().putString("answeredKeys", org.json.JSONArray(keys.toList()).toString()).apply()
  }
}

/**
 * The phone token, sealed with AES-GCM under a key made in and kept by the Android Keystore (no extra library: the
 * Keystore has done this since Android 6, below the app's minimum). Stored as base64 of the 12-byte IV and the
 * ciphertext. `seal` and `open` answer null rather than throw, so a broken Keystore never crashes the background sync.
 */
internal object TokenSeal {
  private const val ALIAS = "deskzo_phone_token_v1"
  private const val TRANSFORM = "AES/GCM/NoPadding"
  private const val IV_BYTES = 12
  private val lock = Any()
  /** The last token opened, by its sealed text, so a sync doesn't ask the Keystore on every read. */
  @Volatile private var cached: Pair<String, String>? = null

  private fun key(): javax.crypto.SecretKey = synchronized(lock) {
    val store = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? javax.crypto.SecretKey)?.let { return it }
    val gen = javax.crypto.KeyGenerator.getInstance(android.security.keystore.KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      android.security.keystore.KeyGenParameterSpec.Builder(
        ALIAS,
        android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    gen.generateKey()
  }

  fun seal(plain: String): String? = runCatching {
    val cipher = javax.crypto.Cipher.getInstance(TRANSFORM)
    cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, key())
    val iv = cipher.iv
    require(iv.size == IV_BYTES)
    val sealed = android.util.Base64.encodeToString(iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8)), android.util.Base64.NO_WRAP)
    cached = sealed to plain
    sealed
  }.getOrNull()

  fun open(sealed: String): String? {
    cached?.let { (s, plain) -> if (s == sealed) return plain }
    return runCatching {
      val all = android.util.Base64.decode(sealed, android.util.Base64.NO_WRAP)
      require(all.size > IV_BYTES)
      val cipher = javax.crypto.Cipher.getInstance(TRANSFORM)
      cipher.init(javax.crypto.Cipher.DECRYPT_MODE, key(), javax.crypto.spec.GCMParameterSpec(128, all, 0, IV_BYTES))
      val plain = String(cipher.doFinal(all, IV_BYTES, all.size - IV_BYTES), Charsets.UTF_8)
      cached = sealed to plain
      plain
    }.getOrNull()
  }
}
