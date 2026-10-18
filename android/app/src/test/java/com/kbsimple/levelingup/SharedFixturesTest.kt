package com.kbsimple.levelingup

import java.io.File
import java.time.Instant
import java.time.OffsetDateTime
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs the shared fixtures in fixtures/, which the web app's tests also run. */
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

    @Test
    fun syncStatusCases() {
        val dir = System.getProperty("fixturesDir") ?: error("fixturesDir system property not set")
        val cases = JSONObject(File(dir, "sync-status-cases.json").readText()).getJSONArray("cases")
        assertTrue(cases.length() > 0)
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val now = Instant.parse(case.getString("now")).toEpochMilli()
            val actual = parseSyncStatus(case.getJSONArray("devicestatus").toString())?.let { formatSyncStatus(it, now) }
            val expected = if (case.isNull("expected")) null else case.getJSONObject("expected").let {
                SyncLine(it.getString("text"), it.getBoolean("stale"))
            }
            assertEquals(case.getString("name"), expected, actual)
        }
    }

    /** Replays the obfuscated real-data snapshot in fixtures/snapshot/ (see expected.json). */
    @Test
    fun snapshotViews() {
        val dir = File(System.getProperty("fixturesDir") ?: error("fixturesDir system property not set"), "snapshot")
        fun read(name: String) = File(dir, "$name.json").readText()
        val expected = JSONObject(read("expected"))

        val glucose = parsePebble(read("pebble")) ?: error("no glucose in pebble.json")
        val g = expected.getJSONObject("glucose")
        assertEquals(g.getInt("mgdl"), glucose.mgdl)
        assertEquals(g.getString("direction"), glucose.direction)
        assertEquals(g.getInt("delta"), glucose.delta)
        assertEquals(g.getDouble("iob"), glucose.iob!!, 1e-9)

        val treatments = JSONArray(read("treatments"))
        val views = expected.getJSONArray("views")
        assertTrue(views.length() > 0)
        for (i in 0 until views.length()) {
            val view = views.getJSONObject(i)
            val now = Instant.parse(view.getString("now")).toEpochMilli()
            // Replaying an earlier moment: only treatments recorded by then.
            val known = JSONArray()
            for (j in 0 until treatments.length()) {
                val t = treatments.getJSONObject(j)
                if (OffsetDateTime.parse(t.getString("created_at")).toInstant().toEpochMilli() <= now) known.put(t)
            }
            val actual = parseBoluses(known.toString(), now, view.getLong("windowMinutes")).map {
                formatBolus(it) to formatBolusDetail(it)
            }
            val lines = view.getJSONArray("boluses").let { arr ->
                (0 until arr.length()).map {
                    val e = arr.getJSONObject(it)
                    e.getString("line1") to (if (e.isNull("line2")) null else e.getString("line2"))
                }
            }
            assertEquals(view.getString("name"), lines, actual)
            view.optJSONObject("sync")?.let {
                val status = parseSyncStatus(read("devicestatus")) ?: error("no sync status in devicestatus.json")
                assertEquals(SyncLine(it.getString("text"), it.getBoolean("stale")), formatSyncStatus(status, now))
            }
        }
    }
}
