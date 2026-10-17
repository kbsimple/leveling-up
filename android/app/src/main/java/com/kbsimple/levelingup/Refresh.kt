package com.kbsimple.levelingup

import android.content.Context
import android.util.Log
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TAG = "LevelingUp"
private const val CHAIN_WORK = "refresh-chain"
private const val CHAIN_TAG = "chain"
private const val BACKSTOP_WORK = "refresh-backstop"
private const val REFRESH_MINUTES = 5L

/**
 * Schedules widget refreshes.
 *
 * WorkManager's periodic minimum is 15 minutes, so a chain of one-time jobs
 * (each scheduling the next) gives a 5-minute cadence, with a 15-minute
 * periodic job as a backstop in case the chain breaks. Android may still
 * delay refreshes while the phone is idle (Doze).
 */
object Refresh {
    private val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedule(context: Context) {
        val wm = WorkManager.getInstance(context)
        wm.enqueueUniquePeriodicWork(
            BACKSTOP_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES).setConstraints(network).build(),
        )
        now(context)
    }

    fun now(context: Context) = enqueue(context, delayMinutes = 0, policy = ExistingWorkPolicy.REPLACE)

    /** Called by a chain job as it finishes: runs after it, [REFRESH_MINUTES] later. */
    internal fun next(context: Context) =
        enqueue(context, delayMinutes = REFRESH_MINUTES, policy = ExistingWorkPolicy.APPEND_OR_REPLACE)

    /** Called by the backstop: restarts the chain only if nothing is queued. */
    internal fun ensureChain(context: Context) =
        enqueue(context, delayMinutes = REFRESH_MINUTES, policy = ExistingWorkPolicy.KEEP)

    fun cancel(context: Context) {
        WorkManager.getInstance(context).apply {
            cancelUniqueWork(CHAIN_WORK)
            cancelUniqueWork(BACKSTOP_WORK)
        }
    }

    private fun enqueue(context: Context, delayMinutes: Long, policy: ExistingWorkPolicy) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            CHAIN_WORK,
            policy,
            OneTimeWorkRequestBuilder<RefreshWorker>()
                .addTag(CHAIN_TAG)
                .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
                .setConstraints(network)
                .build(),
        )
    }
}

class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val snapshot = fetchSnapshot(applicationContext)
        storeAndRender(applicationContext, snapshot)
        if (CHAIN_TAG in tags) Refresh.next(applicationContext) else Refresh.ensureChain(applicationContext)
        return Result.success()
    }
}

/** Fetches a snapshot, keeping the previous data (with an error) on failure. */
suspend fun fetchSnapshot(context: Context): Snapshot = withContext(Dispatchers.IO) {
    val settings = Settings.load(context)
    val now = System.currentTimeMillis()
    if (!settings.isComplete) {
        return@withContext Snapshot(null, emptyList(), null, now, error = "Open the app to set up Nightscout")
    }
    try {
        NightscoutReader(settings).fetch(now)
    } catch (e: Exception) {
        Log.w(TAG, "refresh failed", e)
        val previous = lastSnapshot(context)
        (previous ?: Snapshot(null, emptyList(), null, now)).copy(error = e.message ?: e.javaClass.simpleName)
    }
}

suspend fun storeAndRender(context: Context, snapshot: Snapshot) {
    val json = snapshot.toJson()
    context.getSharedPreferences("snapshot", Context.MODE_PRIVATE).edit().putString("json", json).apply()
    val widget = GlucoseWidget()
    GlanceAppWidgetManager(context).getGlanceIds(GlucoseWidget::class.java).forEach { id ->
        updateAppWidgetState(context, id) { prefs -> prefs[GlucoseWidget.SNAPSHOT_KEY] = json }
        widget.update(context, id)
    }
}

fun lastSnapshot(context: Context): Snapshot? =
    context.getSharedPreferences("snapshot", Context.MODE_PRIVATE).getString("json", null)
        ?.let { runCatching { Snapshot.fromJson(it) }.getOrNull() }
