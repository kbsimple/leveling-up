package com.kbsimple.levelingup

import android.app.Activity
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.glance.appwidget.GlanceAppWidgetManager
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Setup screen: Nightscout URL and read-only token, with a connection test. */
class SettingsActivity : Activity() {

    private val scope = MainScope()
    private lateinit var url: EditText
    private lateinit var token: EditText
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val settings = Settings.load(this)
        val pad = (16 * resources.displayMetrics.density).toInt()

        url = EditText(this).apply {
            hint = "https://your-site.example.com"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(settings.url)
        }
        token = EditText(this).apply {
            hint = "read-only access token"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(settings.token)
        }
        status = TextView(this).apply { setPadding(0, pad, 0, 0) }

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 2, pad, pad)
            addView(label("Nightscout URL"))
            addView(url, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(label("Access token (Admin Tools → Subjects, role \"readable\")"))
            addView(token, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(Button(context).apply {
                text = "Save and test"
                setOnClickListener { saveAndTest() }
            })
            addView(Button(context).apply {
                text = "Add widget to home screen"
                setOnClickListener {
                    scope.launch {
                        GlanceAppWidgetManager(this@SettingsActivity)
                            .requestPinGlanceAppWidget(GlucoseWidgetReceiver::class.java)
                    }
                }
            })
            addView(status)
        }
        setContentView(ScrollView(this).apply { addView(layout) })
        showSnapshot(lastSnapshot(this))
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        setPadding(0, (12 * resources.displayMetrics.density).toInt(), 0, 0)
    }

    private fun saveAndTest() {
        Settings.save(this, Settings(url.text.toString(), token.text.toString()))
        status.text = "Testing…"
        scope.launch {
            val snapshot = fetchSnapshot(this@SettingsActivity)
            storeAndRender(this@SettingsActivity, snapshot)
            Refresh.schedule(this@SettingsActivity)
            showSnapshot(snapshot)
        }
    }

    private fun showSnapshot(snapshot: Snapshot?) {
        if (snapshot == null) {
            status.text = "Not connected yet."
            return
        }
        val now = System.currentTimeMillis()
        val lines = mutableListOf<String>()
        snapshot.error?.let { lines += "Error: $it" }
        snapshot.glucose?.let {
            lines += "Glucose ${it.mgdl} ${arrow(it.direction)} (${formatAge(it.timeMs, now)} old), ${formatIob(it.iob)}"
        }
        lines += "Boluses in last 2h: ${snapshot.boluses.size}"
        snapshot.sync?.let { lines += formatSyncStatus(it, now).text }
            ?: snapshot.pumpDataMs?.let { lines += "Pump data ${formatAge(it, now)} old" }
        lines += "Checked ${formatClock(snapshot.fetchedMs)}"
        status.text = lines.joinToString("\n")
    }
}
