package com.kbsimple.levelingup

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.action.ActionParameters
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.state.GlanceStateDefinition
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextDecoration
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider

/** Home-screen widget: glucose, IOB and boluses from the last two hours. Tap to refresh. */
class GlucoseWidget : GlanceAppWidget() {

    override val stateDefinition: GlanceStateDefinition<*> = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val snapshot = currentState(SNAPSHOT_KEY)?.let { runCatching { Snapshot.fromJson(it) }.getOrNull() }
            GlanceTheme { WidgetContent(snapshot, System.currentTimeMillis()) }
        }
    }

    companion object {
        val SNAPSHOT_KEY = stringPreferencesKey("snapshot")
    }
}

class GlucoseWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = GlucoseWidget()

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        Refresh.schedule(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        Refresh.cancel(context)
    }
}

class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        Refresh.now(context)
    }
}

private const val MAX_BOLUS_ROWS = 4

@Composable
private fun WidgetContent(snapshot: Snapshot?, nowMs: Long) {
    val primary = GlanceTheme.colors.onSurface
    val secondary = GlanceTheme.colors.onSurfaceVariant
    val small = TextStyle(fontSize = 13.sp, color = secondary)

    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(GlanceTheme.colors.widgetBackground)
            .padding(12.dp)
            .clickable(actionRunCallback<RefreshAction>()),
    ) {
        if (snapshot == null) {
            Text("Tap to load", style = TextStyle(fontSize = 16.sp, color = primary))
            return@Column
        }

        val glucose = snapshot.glucose
        if (glucose != null) {
            val stale = isStale(glucose, nowMs)
            Row(verticalAlignment = Alignment.Bottom) {
                Text(
                    "${glucose.mgdl} ${arrow(glucose.direction)}",
                    style = TextStyle(
                        fontSize = 34.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (stale) secondary else primary,
                        textDecoration = if (stale) TextDecoration.LineThrough else TextDecoration.None,
                    ),
                )
                Spacer(GlanceModifier.width(8.dp))
                Text("${formatDelta(glucose.delta)}  ${formatAge(glucose.timeMs, nowMs)}", style = small)
            }
            Text(formatIob(glucose.iob), style = TextStyle(fontSize = 16.sp, color = primary))
        } else {
            Text("No glucose data", style = TextStyle(fontSize = 16.sp, color = primary))
        }

        Spacer(GlanceModifier.height(6.dp))
        if (snapshot.boluses.isEmpty()) {
            Text("No boluses in last 2h", style = small)
        } else {
            snapshot.boluses.take(MAX_BOLUS_ROWS).forEach { bolus -> BolusRow(bolus, primary, small) }
        }

        Spacer(GlanceModifier.height(6.dp))
        val footer = snapshot.error
            ?: snapshot.pumpDataMs?.let { "Pump data ${formatAge(it, nowMs)} old" }
            ?: "No pump data"
        Text(footer, style = small.copy(color = if (snapshot.error != null) GlanceTheme.colors.error else secondary))
    }
}

@Composable
private fun BolusRow(bolus: Bolus, color: ColorProvider, small: TextStyle) {
    Column {
        Row {
            Text(formatClock(bolus.timeMs), style = small, modifier = GlanceModifier.width(44.dp))
            Text(formatBolus(bolus), style = TextStyle(fontSize = 15.sp, color = color))
        }
        formatBolusDetail(bolus)?.let { detail ->
            Text(detail, style = small, maxLines = 1, modifier = GlanceModifier.padding(start = 44.dp))
        }
    }
}
