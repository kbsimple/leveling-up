package com.kbsimple.levelingup

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Bolus parsing and wording, using treatments as leveling-up's sync uploads them. */
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
    fun automatic_isOneLine() {
        val bolus = Bolus(0, 0.69, 0, automatic = true, food = 0.0, correction = 0.69, suggested = 0.69)
        assertEquals("0.7U · auto", formatBolus(bolus))
        assertNull(formatBolusDetail(bolus))
    }

    @Test
    fun manualCarbAndCorrection_showsSplitAndExtension() {
        val bolus = Bolus(0, 4.8, 65, food = 4.33, correction = 0.47, suggested = 4.8,
            extended = 2.17, extendedMinutes = 45)
        assertEquals("4.8U · 65g", formatBolus(bolus))
        assertEquals("4.3 carb + 0.5 corr · 2.2U over 45m", formatBolusDetail(bolus))
    }

    @Test
    fun manualCarbOnly_needsNoDetail() {
        assertNull(formatBolusDetail(Bolus(0, 3.18, 45, food = 3.18, correction = 0.0, suggested = 3.18)))
    }

    @Test
    fun negativeCorrection_reducesCarbPortion() {
        val bolus = Bolus(0, 1.5, 30, food = 1.8, correction = -0.3, suggested = 1.5)
        assertEquals("1.8 carb − 0.3 corr", formatBolusDetail(bolus))
    }

    @Test
    fun manualCorrection() {
        assertEquals("correction", formatBolusDetail(Bolus(0, 0.72, 0, food = 0.0, correction = 0.72, suggested = 0.72)))
    }

    @Test
    fun editedAmount() {
        val lowered = Bolus(0, 2.0, 40, food = 2.35, correction = 0.0, suggested = 2.35)
        assertEquals("edited −0.4 from 2.4", formatBolusDetail(lowered))
        val raised = Bolus(0, 3.0, 0, food = 0.0, correction = 2.5, suggested = 2.5)
        assertEquals("correction · edited +0.5 from 2.5", formatBolusDetail(raised))
        // Rounding noise is not an edit.
        assertNull(formatBolusDetail(Bolus(0, 0.63, 0, automatic = true, suggested = 0.63000005)))
    }

    @Test
    fun declinedCorrection() {
        assertEquals("corr declined",
            formatBolusDetail(Bolus(0, 1.76, 30, food = 1.76, correction = 0.0, suggested = 1.76, declinedCorrection = true)))
    }

    @Test
    fun stoppedEarly() {
        val bolus = Bolus(0, 1.4, 0, automatic = true, delivered = 0.795, correction = 1.4, suggested = 1.4,
            completion = "stopped by alarm")
        assertEquals("0.8U delivered, stopped by alarm", formatBolusDetail(bolus))
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
