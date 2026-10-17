package com.kbsimple.levelingup

import java.io.File
import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs fixtures/bolus-cases.json, which the web app's tests also run. */
class SharedFixturesTest {

    @Test
    fun bolusCases() {
        val dir = System.getProperty("fixturesDir") ?: error("fixturesDir system property not set")
        val cases = JSONObject(File(dir, "bolus-cases.json").readText()).getJSONArray("cases")
        assertTrue(cases.length() > 0)
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val now = Instant.parse(case.getString("now")).toEpochMilli()
            val actual = parseBoluses(case.getJSONArray("treatments").toString(), now).map {
                formatBolus(it) to formatBolusDetail(it)
            }
            val expected = case.getJSONArray("expected").let { arr ->
                (0 until arr.length()).map {
                    val e = arr.getJSONObject(it)
                    e.getString("line1") to (if (e.isNull("line2")) null else e.getString("line2"))
                }
            }
            assertEquals(case.getString("name"), expected, actual)
        }
    }
}
