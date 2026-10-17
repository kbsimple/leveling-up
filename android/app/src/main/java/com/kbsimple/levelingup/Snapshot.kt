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

/**
 * One bolus as the widget shows it.
 *
 * Calculator fields come from leveling-up's sync (see bolus_details.py) and are
 * null for older treatments. [insulin] is the requested total (now + extended);
 * [delivered] is what has been delivered so far.
 */
data class Bolus(
    val timeMs: Long,
    val insulin: Double,
    val carbs: Int,
    val automatic: Boolean = false,
    val delivered: Double = insulin,
    val food: Double? = null,
    val correction: Double? = null,
    val suggested: Double? = null,
    val extended: Double? = null,
    val extendedMinutes: Int? = null,
    val declinedCorrection: Boolean = false,
    val completion: String? = null,
)

/** Everything the widget shows, as of [fetchedMs]. */
data class Snapshot(
    val glucose: Glucose?,
    val boluses: List<Bolus>,
    val pumpDataMs: Long?,
    val fetchedMs: Long,
    val error: String? = null,
    /** Freshness published by leveling-up's sync; null if none. */
    val sync: SyncStatus? = null,
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
            boluses.forEach { put(it.toJson()) }
        })
        pumpDataMs?.let { put("pumpDataMs", it) }
        put("fetchedMs", fetchedMs)
        error?.let { put("error", it) }
        sync?.let { put("sync", it.toJson()) }
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
                boluses = (0 until b.length()).map { bolusFromJson(b.getJSONObject(it)) },
                pumpDataMs = if (o.has("pumpDataMs")) o.getLong("pumpDataMs") else null,
                fetchedMs = o.getLong("fetchedMs"),
                error = if (o.has("error")) o.getString("error") else null,
                sync = o.optJSONObject("sync")?.let { syncStatusFromJson(it) },
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

private fun Bolus.toJson(): JSONObject = JSONObject().apply {
    put("timeMs", timeMs)
    put("insulin", insulin)
    put("carbs", carbs)
    put("automatic", automatic)
    put("delivered", delivered)
    food?.let { put("food", it) }
    correction?.let { put("correction", it) }
    suggested?.let { put("suggested", it) }
    extended?.let { put("extended", it) }
    extendedMinutes?.let { put("extendedMinutes", it) }
    put("declinedCorrection", declinedCorrection)
    completion?.let { put("completion", it) }
}

private fun bolusFromJson(x: JSONObject) = Bolus(
    timeMs = x.getLong("timeMs"),
    insulin = x.getDouble("insulin"),
    carbs = x.getInt("carbs"),
    automatic = x.optBoolean("automatic", false),
    delivered = x.optDouble("delivered", x.getDouble("insulin")),
    food = x.optNumber("food"),
    correction = x.optNumber("correction"),
    suggested = x.optNumber("suggested"),
    extended = x.optNumber("extended"),
    extendedMinutes = if (x.has("extendedMinutes")) x.getInt("extendedMinutes") else null,
    declinedCorrection = x.optBoolean("declinedCorrection", false),
    completion = if (x.has("completion")) x.getString("completion") else null,
)

/** The value as a Double, or null when absent, JSON null or not a number. */
private fun JSONObject.optNumber(key: String): Double? =
    if (isNull(key)) null else optDouble(key).takeIf { !it.isNaN() }

/**
 * Returns boluses and carb entries newer than the window, newest first.
 *
 * Extended-portion treatments (delivered later under the same `bolusId`) are
 * folded into their parent bolus rather than listed separately.
 */
fun parseBoluses(json: String, nowMs: Long, windowMinutes: Long = BOLUS_WINDOW_MINUTES): List<Bolus> {
    val cutoff = nowMs - windowMinutes * 60_000
    val arr = JSONArray(json)
    val treatments = (0 until arr.length()).map { arr.getJSONObject(it) }
    val extendedDelivered = treatments
        .filter { it.optBoolean("extendedPortion", false) && it.has("bolusId") }
        .groupBy { it.getLong("bolusId") }
        .mapValues { (_, parts) -> parts.sumOf { it.optNumber("insulin") ?: 0.0 } }
    return treatments
        .filterNot { it.optBoolean("extendedPortion", false) }
        .mapNotNull { t ->
            val deliveredNow = t.optNumber("insulin") ?: 0.0
            val carbs = t.optNumber("carbs")?.toInt() ?: 0
            val time = treatmentTimeMs(t) ?: return@mapNotNull null
            if ((deliveredNow <= 0.0 && carbs <= 0) || time < cutoff) return@mapNotNull null
            val laterDelivered = if (t.has("bolusId")) extendedDelivered[t.getLong("bolusId")] ?: 0.0 else 0.0
            val delivered = deliveredNow + laterDelivered
            Bolus(
                timeMs = time,
                insulin = t.optNumber("requestedInsulin") ?: delivered,
                carbs = carbs,
                automatic = if (t.has("automatic")) t.getBoolean("automatic")
                    else t.optString("notes").contains("Automatic"),
                delivered = delivered,
                food = t.optNumber("foodInsulin"),
                correction = t.optNumber("correctionInsulin"),
                suggested = t.optNumber("suggestedInsulin"),
                extended = t.optNumber("extendedInsulin"),
                extendedMinutes = if (t.has("extendedMinutes")) t.getInt("extendedMinutes") else null,
                declinedCorrection = t.optBoolean("declinedCorrection", false),
                completion = t.optString("completion").ifEmpty { null },
            )
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

/** Data freshness published by leveling-up's sync (see sync_status.py). */
data class SyncStatus(
    val checkedMs: Long,
    /** Last successful Tandem -> Nightscout sync. */
    val syncedMs: Long?,
    /** Last pump -> Tandem cloud upload. */
    val pumpUploadedMs: Long?,
    /** Newest pump event in Tandem. */
    val newestEventMs: Long?,
    val uploadClient: String?,
    val error: String?,
)

private fun SyncStatus.toJson(): JSONObject = JSONObject().apply {
    put("checkedMs", checkedMs)
    syncedMs?.let { put("syncedMs", it) }
    pumpUploadedMs?.let { put("pumpUploadedMs", it) }
    newestEventMs?.let { put("newestEventMs", it) }
    uploadClient?.let { put("uploadClient", it) }
    error?.let { put("error", it) }
}

private fun syncStatusFromJson(o: JSONObject) = SyncStatus(
    checkedMs = o.getLong("checkedMs"),
    syncedMs = if (o.has("syncedMs")) o.getLong("syncedMs") else null,
    pumpUploadedMs = if (o.has("pumpUploadedMs")) o.getLong("pumpUploadedMs") else null,
    newestEventMs = if (o.has("newestEventMs")) o.getLong("newestEventMs") else null,
    uploadClient = if (o.has("uploadClient")) o.getString("uploadClient") else null,
    error = if (o.has("error")) o.getString("error") else null,
)

/** Epoch ms of a zoned ISO-8601 string, or null. */
private fun isoMs(value: Any?): Long? =
    (value as? String)?.let { runCatching { OffsetDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() }

/** The newest leveling-up freshness record in a devicestatus array, or null. */
fun parseSyncStatus(json: String): SyncStatus? {
    val arr = JSONArray(json)
    var best: Pair<Long, JSONObject>? = null
    for (i in 0 until arr.length()) {
        val record = arr.optJSONObject(i) ?: continue
        val tandem = record.optJSONObject("levelingUp")?.optJSONObject("tandem") ?: continue
        val ms = isoMs(record.opt("created_at")) ?: continue
        if (best == null || ms > best.first) best = ms to tandem
    }
    val (createdMs, t) = best ?: return null
    fun str(key: String) = if (t.isNull(key)) null else t.optString(key).ifEmpty { null }
    return SyncStatus(
        checkedMs = isoMs(t.opt("checkedAt")) ?: createdMs,
        syncedMs = isoMs(t.opt("syncedAt")),
        pumpUploadedMs = isoMs(t.opt("pumpUploadedAt")),
        newestEventMs = isoMs(t.opt("newestEventAt")),
        uploadClient = str("uploadClient"),
        error = str("error"),
    )
}
