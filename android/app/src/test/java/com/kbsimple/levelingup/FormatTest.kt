package com.kbsimple.levelingup

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FormatTest {

    @Test
    fun arrows() {
        assertEquals("↑", arrow("SingleUp"))
        assertEquals("⇊", arrow("DoubleDown"))
        assertEquals("→", arrow("Flat"))
        assertEquals("", arrow("NOT COMPUTABLE"))
    }

    @Test
    fun delta() {
        assertEquals("+4", formatDelta(4))
        assertEquals("-12", formatDelta(-12))
        assertEquals("0", formatDelta(0))
        assertEquals("", formatDelta(null))
    }

    @Test
    fun age() {
        val now = 10_000_000L
        assertEquals("now", formatAge(now - 30_000, now))
        assertEquals("7m", formatAge(now - 7 * 60_000, now))
        assertEquals("2h 5m", formatAge(now - 125 * 60_000, now))
        assertEquals("now", formatAge(now + 60_000, now)) // clock skew
    }

    @Test
    fun clock() {
        val t = Instant.parse("2026-10-17T16:05:00Z").toEpochMilli()
        assertEquals("9:05", formatClock(t, ZoneId.of("America/Los_Angeles")))
    }

    @Test
    fun bolus() {
        assertEquals("2.6U · 65g", formatBolus(Bolus(0, 2.63, 65)))
        assertEquals("0.4U", formatBolus(Bolus(0, 0.39, 0)))
        assertEquals("18g", formatBolus(Bolus(0, 0.0, 18)))
    }

    @Test
    fun iob() {
        assertEquals("IOB 1.5U", formatIob(1.54))
        assertEquals("IOB --", formatIob(null))
    }

    @Test
    fun stale() {
        val now = 100 * 60_000L
        assertFalse(isStale(Glucose(100, "Flat", 0, now - 5 * 60_000, null), now))
        assertTrue(isStale(Glucose(100, "Flat", 0, now - 13 * 60_000, null), now))
    }
}
