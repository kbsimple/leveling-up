package com.kbsimple.levelingup

import android.content.Context
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.time.Instant

/** Nightscout URL and read-only access token, stored on the device. */
data class Settings(val url: String, val token: String) {
    val isComplete get() = url.isNotBlank() && token.isNotBlank()

    companion object {
        private const val PREFS = "settings"

        fun load(context: Context): Settings {
            val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return Settings(p.getString("url", "")!!, p.getString("token", "")!!)
        }

        fun save(context: Context, settings: Settings) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("url", settings.url.trim().trimEnd('/'))
                .putString("token", settings.token.trim())
                .apply()
        }
    }
}

/** Reads what the widget needs from Nightscout's v1 API. */
class NightscoutReader(private val settings: Settings) {

    fun fetch(nowMs: Long = System.currentTimeMillis()): Snapshot {
        val since = Instant.ofEpochMilli(nowMs - BOLUS_WINDOW_MINUTES * 60_000).toString()
        val glucose = parsePebble(get("pebble", emptyMap()))
        val boluses = parseBoluses(
            get("api/v1/treatments.json", mapOf("count" to "50", "find[created_at][\$gte]" to since)),
            nowMs,
        )
        // Temp basals arrive with every pump upload, so the newest one shows
        // how fresh the pump data is.
        val pumpDataMs = parseLatestTreatmentMs(
            get("api/v1/treatments.json", mapOf(
                "count" to "1",
                "find[eventType]" to "Temp Basal",
                "find[enteredBy]" to PUMP_ENTERED_BY,
            )),
        )
        val sync = parseSyncStatus(
            get("api/v1/devicestatus.json", mapOf("count" to "1", "find[device]" to "leveling-up")),
        )
        return Snapshot(glucose, boluses, pumpDataMs, nowMs, sync = sync)
    }

    private fun get(path: String, params: Map<String, String>): String {
        val query = (params + ("token" to settings.token)).entries.joinToString("&") { (k, v) ->
            URLEncoder.encode(k, "UTF-8") + "=" + URLEncoder.encode(v, "UTF-8")
        }
        val conn = URL("${settings.url}/$path?$query").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("Accept", "application/json")
            val code = conn.responseCode
            if (code != 200) {
                throw NightscoutException(
                    if (code == 401) "Nightscout rejected the token (401)" else "Nightscout HTTP $code")
            }
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }
}

class NightscoutException(message: String) : Exception(message)
