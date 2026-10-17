package com.kbsimple.levelingup

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs

/** Glucose older than this is shown as stale. */
const val STALE_GLUCOSE_MINUTES = 12L

private val CLOCK: DateTimeFormatter = DateTimeFormatter.ofPattern("h:mm", Locale.US)

private val ARROWS = mapOf(
    "DoubleUp" to "⇈",
    "SingleUp" to "↑",
    "FortyFiveUp" to "↗",
    "Flat" to "→",
    "FortyFiveDown" to "↘",
    "SingleDown" to "↓",
    "DoubleDown" to "⇊",
)

fun arrow(direction: String): String = ARROWS[direction] ?: ""

fun formatDelta(delta: Int?): String = when {
    delta == null -> ""
    delta > 0 -> "+$delta"
    else -> "$delta"
}

/** "now", "7m", "2h 5m". */
fun formatAge(thenMs: Long, nowMs: Long): String {
    val minutes = ((nowMs - thenMs) / 60_000).coerceAtLeast(0)
    return when {
        minutes < 1 -> "now"
        minutes < 60 -> "${minutes}m"
        else -> "${minutes / 60}h ${minutes % 60}m"
    }
}

fun formatClock(timeMs: Long, zone: ZoneId = ZoneId.systemDefault()): String =
    CLOCK.format(Instant.ofEpochMilli(timeMs).atZone(zone))

/** Differences below this many units are rounding, not a user edit. */
private const val EDIT_THRESHOLD_UNITS = 0.05

private fun u(units: Double) = String.format(Locale.US, "%.1f", units)

/** First line for a bolus: "4.8U · 65g", "0.7U · auto", "18g". */
fun formatBolus(bolus: Bolus): String = listOfNotNull(
    if (bolus.insulin > 0) "${u(bolus.insulin)}U" else null,
    if (bolus.carbs > 0) "${bolus.carbs}g" else null,
    if (bolus.automatic) "auto" else null,
).joinToString(" · ")

/**
 * Second line for a bolus, or null when the first line says it all.
 *
 * Avoids repeating what's implied: automatic boluses are always pure
 * correction, and grams on the first line already mark a carb bolus, so the
 * carb/correction split is shown only when both parts are present.
 */
fun formatBolusDetail(bolus: Bolus): String? {
    val parts = mutableListOf<String>()
    val food = bolus.food ?: 0.0
    val correction = bolus.correction ?: 0.0
    if (!bolus.automatic) {
        when {
            food > 0 && correction != 0.0 ->
                parts += "${u(food)} carb ${if (correction > 0) "+" else "−"} ${u(abs(correction))} corr"
            food == 0.0 && correction > 0 && bolus.carbs == 0 -> parts += "correction"
        }
        if (bolus.declinedCorrection) parts += "corr declined"
    }
    bolus.suggested?.let { suggested ->
        val diff = bolus.insulin - suggested
        if (abs(diff) >= EDIT_THRESHOLD_UNITS) {
            parts += "edited ${if (diff > 0) "+" else "−"}${u(abs(diff))} from ${u(suggested)}"
        }
    }
    bolus.extended?.takeIf { it > 0 }?.let { ext ->
        parts += "${u(ext)}U over ${bolus.extendedMinutes?.let(::formatDuration) ?: "time"}"
    }
    bolus.completion?.let { parts += "${u(bolus.delivered)}U delivered, $it" }
    return parts.joinToString(" · ").ifEmpty { null }
}

/** "45m", "2h", "1h 30m". */
fun formatDuration(minutes: Int): String = when {
    minutes < 60 -> "${minutes}m"
    minutes % 60 == 0 -> "${minutes / 60}h"
    else -> "${minutes / 60}h ${minutes % 60}m"
}

fun formatIob(iob: Double?): String =
    if (iob == null) "IOB --" else String.format(Locale.US, "IOB %.1fU", iob)

fun isStale(glucose: Glucose, nowMs: Long): Boolean =
    nowMs - glucose.timeMs > STALE_GLUCOSE_MINUTES * 60_000
