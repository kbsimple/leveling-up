package com.kbsimple.levelingup

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SnapshotTest {

    private val now = Instant.parse("2026-10-17T18:30:00Z").toEpochMilli()

    @Test
    fun parsePebble_readsGlucoseDeltaAndIob() {
        val json = """{"status":[{"now":1792260911968}],"bgs":[{"sgv":"121","trend":6,
            "direction":"SingleDown","datetime":1792260622255,"bgdelta":-12,"iob":"0.47",
            "bwp":"0","bwpo":85,"cob":10}],"cals":[]}"""
        assertEquals(Glucose(121, "SingleDown", -12, 1792260622255, 0.47), parsePebble(json))
    }

    @Test
    fun parsePebble_handlesMissingFields() {
        val json = """{"bgs":[{"sgv":"89","datetime":1,"bgdelta":"4.0"}]}"""
        assertEquals(Glucose(89, "", 4, 1, null), parsePebble(json))
        assertNull(parsePebble("""{"bgs":[]}"""))
        assertNull(parsePebble("""{}"""))
    }

    @Test
    fun parseBoluses_filtersWindowAndNonDoses_newestFirst() {
        val json = """[
            {"eventType":"Combo Bolus","created_at":"2026-10-17T17:11:51.000Z","insulin":0.39,"carbs":0},
            {"eventType":"Combo Bolus","created_at":"2026-10-17T18:05:18.000Z","insulin":2.63,"carbs":65},
            {"eventType":"Temp Basal","created_at":"2026-10-17T18:01:27.000Z","absolute":0.41,"insulin":null,"carbs":null},
            {"eventType":"Carb Correction","created_at":"2026-10-17T18:20:00Z","carbs":15},
            {"eventType":"Combo Bolus","created_at":"2026-10-17T16:00:00.000Z","insulin":1.0,"carbs":0}
        ]"""
        assertEquals(
            listOf(
                Bolus(Instant.parse("2026-10-17T18:20:00Z").toEpochMilli(), 0.0, 15),
                Bolus(Instant.parse("2026-10-17T18:05:18Z").toEpochMilli(), 2.63, 65),
                Bolus(Instant.parse("2026-10-17T17:11:51Z").toEpochMilli(), 0.39, 0),
            ),
            parseBoluses(json, now),
        )
    }

    @Test
    fun parseBoluses_acceptsOffsetAndSpaceSeparatedTimes() {
        val json = """[
            {"created_at":"2026-10-17 11:00:00-07:00","insulin":1.0},
            {"created_at":"2026-10-17T11:10:00-07:00","insulin":2.0},
            {"mills":${now - 60_000},"insulin":3.0},
            {"created_at":"garbage","insulin":4.0}
        ]"""
        assertEquals(listOf(3.0, 2.0, 1.0), parseBoluses(json, now).map { it.insulin })
    }

    @Test
    fun parseLatestTreatmentMs() {
        val json = """[{"created_at":"2026-10-17T18:01:27.000Z"},{"created_at":"2026-10-17T17:56:28.000Z"}]"""
        assertEquals(Instant.parse("2026-10-17T18:01:27Z").toEpochMilli(), parseLatestTreatmentMs(json))
        assertNull(parseLatestTreatmentMs("[]"))
    }

    @Test
    fun snapshotJsonRoundTrip() {
        val full = Snapshot(
            Glucose(121, "Flat", -3, 10, 1.5),
            listOf(Bolus(5, 2.6, 65), Bolus(4, 0.4, 0)),
            pumpDataMs = 7,
            fetchedMs = 11,
            error = "boom",
        )
        assertEquals(full, Snapshot.fromJson(full.toJson()))
        val empty = Snapshot(null, emptyList(), null, 11)
        assertEquals(empty, Snapshot.fromJson(empty.toJson()))
        val noOptional = Snapshot(Glucose(90, "", null, 1, null), emptyList(), null, 2)
        assertEquals(noOptional, Snapshot.fromJson(noOptional.toJson()))
    }
}
