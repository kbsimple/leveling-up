package com.kbsimple.levelingup

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test

/** Bolus parsing details; wording is covered by [SharedFixturesTest]. */
class BolusDetailTest {

    private val now = Instant.parse("2026-10-17T16:30:00Z").toEpochMilli()

    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test
    fun parseBoluses_foldsExtendedPortionIntoParent() {
        val json = """[
            {"eventType":"Combo Bolus","created_at":"2026-10-17T15:50:00.000Z","insulin":2.25,
             "extendedPortion":true,"bolusId":16257},
            {"eventType":"Combo Bolus","created_at":"2026-10-17T15:05:00.000Z","insulin":2.5,"carbs":65,
             "automatic":false,"foodInsulin":4.25,"correctionInsulin":0.5,"suggestedInsulin":4.75,
             "requestedInsulin":4.75,"extendedInsulin":2.25,"extendedMinutes":45,"bolusId":16257},
            {"eventType":"Combo Bolus","created_at":"2026-10-17T16:06:00.000Z","insulin":0.69,"carbs":null,
             "automatic":true,"foodInsulin":0,"correctionInsulin":0.69,"suggestedInsulin":0.69,
             "requestedInsulin":0.69,"bolusId":16258}
        ]"""
        assertEquals(
            listOf(
                Bolus(ms("2026-10-17T16:06:00Z"), 0.69, 0, automatic = true, delivered = 0.69,
                    food = 0.0, correction = 0.69, suggested = 0.69),
                Bolus(ms("2026-10-17T15:05:00Z"), 4.75, 65, automatic = false, delivered = 4.75,
                    food = 4.25, correction = 0.5, suggested = 4.75, extended = 2.25, extendedMinutes = 45),
            ),
            parseBoluses(json, now),
        )
    }

    @Test
    fun parseBoluses_olderTreatmentsWithoutDetails() {
        val json = """[{"eventType":"Combo Bolus","created_at":"2026-10-17T16:00:00.000Z","insulin":0.4,
            "notes":"Automatic Bolus"}]"""
        assertEquals(listOf(Bolus(ms("2026-10-17T16:00:00Z"), 0.4, 0, automatic = true)), parseBoluses(json, now))
    }

    @Test
    fun durations() {
        assertEquals("45m", formatDuration(45))
        assertEquals("2h", formatDuration(120))
        assertEquals("1h 30m", formatDuration(90))
    }

    @Test
    fun snapshotRoundTripKeepsDetails() {
        val snapshot = Snapshot(null, listOf(
            Bolus(1, 4.8, 65, automatic = false, delivered = 2.63, food = 4.33, correction = 0.47,
                suggested = 4.8, extended = 2.17, extendedMinutes = 45, declinedCorrection = true,
                completion = "user aborted"),
            Bolus(2, 0.4, 0, automatic = true),
        ), null, 3)
        assertEquals(snapshot, Snapshot.fromJson(snapshot.toJson()))
    }
}
