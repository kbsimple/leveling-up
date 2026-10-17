package com.kbsimple.levelingup

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

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

/** "2.6U · 65g", "0.4U", "18g". */
fun formatBolus(bolus: Bolus): String = listOfNotNull(
    if (bolus.insulin > 0) String.format(Locale.US, "%.1fU", bolus.insulin) else null,
    if (bolus.carbs > 0) "${bolus.carbs}g" else null,
).joinToString(" · ")

fun formatIob(iob: Double?): String =
    if (iob == null) "IOB --" else String.format(Locale.US, "IOB %.1fU", iob)

fun isStale(glucose: Glucose, nowMs: Long): Boolean =
    nowMs - glucose.timeMs > STALE_GLUCOSE_MINUTES * 60_000
