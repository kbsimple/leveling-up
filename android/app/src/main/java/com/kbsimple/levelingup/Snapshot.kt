package com.kbsimple.levelingup

import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import org.json.JSONArray
import org.json.JSONObject

/** How far back the widget lists boluses. */
const val BOLUS_WINDOW_MINUTES = 120L

/** Who tconnectsync records as the author of pump treatments. */
const val PUMP_ENTERED_BY = "Pump (tconnectsync)"

data class Glucose(
    val mgdl: Int,
    val direction: String,
    val delta: Int?,
    val timeMs: Long,
    val iob: Double?,
)

data class Bolus(val timeMs: Long, val insulin: Double, val carbs: Int)

/** Everything the widget shows, as of [fetchedMs]. */
data class Snapshot(
    val glucose: Glucose?,
    val boluses: List<Bolus>,
    val pumpDataMs: Long?,
    val fetchedMs: Long,
    val error: String? = null,
) {
    fun toJson(): String = JSONObject().apply {
        glucose?.let {
            put("glucose", JSONObject().apply {
                put("mgdl", it.mgdl)
                put("direction", it.direction)
                it.delta?.let { d -> put("delta", d) }
                put("timeMs", it.timeMs)
                it.iob?.let { i -> put("iob", i) }
            })
        }
        put("boluses", JSONArray().apply {
            boluses.forEach {
                put(JSONObject().put("timeMs", it.timeMs).put("insulin", it.insulin).put("carbs", it.carbs))
            }
        })
        pumpDataMs?.let { put("pumpDataMs", it) }
        put("fetchedMs", fetchedMs)
        error?.let { put("error", it) }
    }.toString()

    companion object {
        fun fromJson(json: String): Snapshot {
            val o = JSONObject(json)
            val g = o.optJSONObject("glucose")
            val b = o.getJSONArray("boluses")
            return Snapshot(
                glucose = g?.let {
                    Glucose(
                        mgdl = it.getInt("mgdl"),
                        direction = it.getString("direction"),
                        delta = if (it.has("delta")) it.getInt("delta") else null,
                        timeMs = it.getLong("timeMs"),
                        iob = if (it.has("iob")) it.getDouble("iob") else null,
                    )
                },
                boluses = (0 until b.length()).map {
                    val x = b.getJSONObject(it)
                    Bolus(x.getLong("timeMs"), x.getDouble("insulin"), x.getInt("carbs"))
                },
                pumpDataMs = if (o.has("pumpDataMs")) o.getLong("pumpDataMs") else null,
                fetchedMs = o.getLong("fetchedMs"),
                error = if (o.has("error")) o.getString("error") else null,
            )
        }
    }
}

/** Parses Nightscout's `/pebble` response (current glucose, delta and IOB). */
fun parsePebble(json: String): Glucose? {
    val bgs = JSONObject(json).optJSONArray("bgs") ?: return null
    if (bgs.length() == 0) return null
    val bg = bgs.getJSONObject(0)
    return Glucose(
        mgdl = bg.getString("sgv").toInt(),
        direction = bg.optString("direction", ""),
        delta = bg.optString("bgdelta", "").toDoubleOrNull()?.toInt(),
        timeMs = bg.getLong("datetime"),
        iob = bg.optString("iob", "").toDoubleOrNull(),
    )
}

/** Returns boluses and carb entries from a treatments array newer than the window, newest first. */
fun parseBoluses(json: String, nowMs: Long, windowMinutes: Long = BOLUS_WINDOW_MINUTES): List<Bolus> {
    val cutoff = nowMs - windowMinutes * 60_000
    val arr = JSONArray(json)
    return (0 until arr.length())
        .map { arr.getJSONObject(it) }
        .mapNotNull { t ->
            val insulin = t.optDouble("insulin", 0.0).takeIf { !it.isNaN() } ?: 0.0
            val carbs = t.optDouble("carbs", 0.0).takeIf { !it.isNaN() }?.toInt() ?: 0
            val time = treatmentTimeMs(t) ?: return@mapNotNull null
            if ((insulin <= 0.0 && carbs <= 0) || time < cutoff) null else Bolus(time, insulin, carbs)
        }
        .sortedByDescending { it.timeMs }
}

/** Returns the time of the newest treatment in the array, if any. */
fun parseLatestTreatmentMs(json: String): Long? {
    val arr = JSONArray(json)
    return (0 until arr.length()).mapNotNull { treatmentTimeMs(arr.getJSONObject(it)) }.maxOrNull()
}

private val SPACE_OFFSET_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ssXXX")

private fun treatmentTimeMs(t: JSONObject): Long? {
    if (t.has("mills")) return t.getLong("mills")
    val created = t.optString("created_at", "").ifEmpty { return null }
    return runCatching { Instant.parse(created).toEpochMilli() }
        .recoverCatching { OffsetDateTime.parse(created).toInstant().toEpochMilli() }
        .recoverCatching { OffsetDateTime.parse(created, SPACE_OFFSET_FORMAT).toInstant().toEpochMilli() }
        .getOrNull()
}
