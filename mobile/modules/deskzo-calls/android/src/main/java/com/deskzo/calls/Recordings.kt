package com.deskzo.calls

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import org.json.JSONArray
import org.json.JSONObject

/**
 * Call recordings, the way Kylas does it (owner, 9 Nov 2026 — src/lib/calls/recordings.ts on the server). Android
 * won't let an app record a call, but many phones' own dialers do (Samsung, Xiaomi, OnePlus, Vivo, Oppo) and save an
 * audio file. When the workspace has recordings on, each call Deskzo logs from this phone waits here until the
 * recorder's file for it turns up — an audio file saved as the call ended, in a folder or under a name that says
 * call, its number in the name where the recorder puts one — and is sent. One that never turns up is let go after
 * two days: the phone has no recorder, or it was off for that call.
 */
internal object Recordings {
  private val lock = Any()
  private const val GIVE_UP_MS = 2 * 24 * 3_600_000L
  /** A recorder writes its file as the call ends, give or take: this long either side. */
  private const val BEFORE_S = 60L
  private const val AFTER_S = 15 * 60L
  /** How far a recording's length may be from the call's talking time (the recorder starts and stops a moment apart). */
  private const val DURATION_SLACK_S = 8L

  data class Waiting(val callId: String, val number: String, val startedAt: Long, val duration: Int, val queuedAt: Long)

  fun permitted(c: Context): Boolean {
    val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
    return ContextCompat.checkSelfPermission(c, permission) == PackageManager.PERMISSION_GRANTED
  }

  /** A call Deskzo just logged, to find the recording of. Only when recordings are on and the call was talked on. */
  fun queue(c: Context, callId: String, number: String, startedAt: Long, duration: Int) {
    if (!Store.recordings(c) || duration <= 0 || callId.isBlank()) return
    synchronized(lock) {
      val list = Store.waitingRecordings(c)
      if ((0 until list.length()).any { list.optJSONObject(it)?.optString("callId") == callId }) return
      list.put(JSONObject().put("callId", callId).put("number", number).put("startedAt", startedAt).put("duration", duration).put("queuedAt", System.currentTimeMillis()))
      Store.setWaitingRecordings(c, list)
    }
  }

  /** Whether a run of digits reads as a date and time a recorder stamped — 20yyMMdd… — rather than a phone number. */
  private fun dateLike(run: String): Boolean {
    if (run.length < 8 || !run.startsWith("20")) return false
    val month = run.substring(4, 6).toIntOrNull() ?: return false
    val day = run.substring(6, 8).toIntOrNull() ?: return false
    return month in 1..12 && day in 1..31
  }

  /** The recorder's file for a call, or null: the closest match in time among audio saved as it ended. */
  fun find(c: Context, w: Waiting): Triple<Uri, String, Long>? {
    if (!permitted(c)) return null
    val endS = (w.startedAt / 1000) + w.duration
    val from = (w.startedAt / 1000) - BEFORE_S
    val to = endS + AFTER_S
    val digits = w.number.filter { it.isDigit() }.takeLast(7)
    val projection = mutableListOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.DISPLAY_NAME, MediaStore.Audio.Media.DATE_ADDED, MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.DURATION)
    val pathColumn = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) MediaStore.Audio.Media.RELATIVE_PATH else @Suppress("DEPRECATION") MediaStore.Audio.Media.DATA
    projection.add(pathColumn)
    var best: Triple<Uri, String, Long>? = null
    var bestGap = Long.MAX_VALUE
    c.contentResolver.query(
      MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
      projection.toTypedArray(),
      "${MediaStore.Audio.Media.DATE_ADDED} BETWEEN ? AND ?",
      arrayOf(from.toString(), to.toString()),
      null,
    )?.use { cursor ->
      val id = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
      val name = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
      val added = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED)
      val size = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
      val path = cursor.getColumnIndexOrThrow(pathColumn)
      val length = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
      while (cursor.moveToNext()) {
        val fileName = cursor.getString(name) ?: continue
        val where = (cursor.getString(path) ?: "").lowercase()
        val lower = fileName.lowercase()
        val bytes = cursor.getLong(size)
        if (bytes < 1024) continue
        // A call recorder's file: in a call folder, or named for a call, or for this number.
        val callLike = where.contains("call") || lower.contains("call") || (digits.length >= 7 && fileName.filter { it.isDigit() }.contains(digits))
        if (!callLike) continue
        // Security audit round two, 13 Nov 2026 (Low — the matcher could upload a personal call's audio): a recorder that
        // names its files by number must name this one's, and the file must last as long as the call, give or take a
        // few seconds. A file whose length isn't known is skipped. A number in a name is 10 to 13 digits that aren't a
        // date-and-time (recorders also stamp 20261113 or 20261113101530 in the name).
        val runs = Regex("\\d{10,14}").findAll(fileName).map { it.value }.filter { it.length <= 13 && !dateLike(it) }.toList()
        if (runs.isNotEmpty() && (digits.length < 7 || runs.none { it.contains(digits) })) continue
        val seconds = cursor.getLong(length) / 1000
        if (seconds <= 0 || kotlin.math.abs(seconds - w.duration) > DURATION_SLACK_S) continue
        val gap = kotlin.math.abs(cursor.getLong(added) - endS)
        if (gap < bestGap) {
          bestGap = gap
          best = Triple(ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, cursor.getLong(id)), fileName, bytes)
        }
      }
    }
    return best
  }

  /** Sends what's waiting and found; lets go of what's done, refused, or too old. Throws IOException with no network. */
  fun run(c: Context): Int = synchronized(lock) {
    val session = Store.session(c) ?: return 0
    val list = Store.waitingRecordings(c)
    if (!Store.recordings(c)) {
      if (list.length() > 0) Store.setWaitingRecordings(c, JSONArray())
      return 0
    }
    val keep = JSONArray()
    var sent = 0
    val now = System.currentTimeMillis()
    for (i in 0 until list.length()) {
      val o = list.optJSONObject(i) ?: continue
      val w = Waiting(o.optString("callId"), o.optString("number"), o.optLong("startedAt"), o.optInt("duration"), o.optLong("queuedAt"))
      val found = runCatching { find(c, w) }.getOrNull()
      if (found == null) {
        if (now - w.queuedAt < GIVE_UP_MS) keep.put(o)
        continue
      }
      try {
        upload(c, session, w.callId, found.first, found.second, found.third)
        sent += 1
      } catch (e: ApiError) {
        // Deskzo busy or down, or no store yet: later. Anything else (switched off, not this phone's call, not audio): let go.
        if (e.status == 429 || e.status >= 500) keep.put(o)
        if (e.status == 401) Store.markSignedOut(c)
      } catch (e: IOException) {
        keep.put(o)
      }
    }
    Store.setWaitingRecordings(c, keep)
    sent
  }

  private fun upload(c: Context, s: Session, callId: String, uri: Uri, fileName: String, size: Long) {
    val conn = (URL("${s.baseUrl}/api/app/calls/${URLEncoder.encode(callId, "UTF-8")}/recording").openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 10_000
      readTimeout = 120_000
      doOutput = true
      setFixedLengthStreamingMode(size)
      setRequestProperty("Authorization", "Bearer ${s.token}")
      setRequestProperty("Accept", "application/json")
      setRequestProperty("Content-Type", "application/octet-stream")
      setRequestProperty("X-File-Name", URLEncoder.encode(fileName, "UTF-8"))
      s.host?.let { setRequestProperty("Host", it) }
    }
    try {
      c.contentResolver.openInputStream(uri)?.use { input -> conn.outputStream.use { input.copyTo(it) } } ?: throw IOException("The recording couldn't be opened")
      val status = conn.responseCode
      if (status >= 400) {
        val text = conn.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        val code = runCatching { JSONObject(text).optJSONObject("error")?.optString("code") }.getOrNull()
        throw ApiError(status, code)
      }
    } finally {
      conn.disconnect()
    }
  }
}
