package com.restopos.core.mra

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit

// The till's MRA work on its own (MraSender.tick): every 15 minutes it keeps
// its token fresh and sends what waits; after a sale that did not get through,
// once the line is back. A till not on the MRA, with nothing waiting, does
// nothing and asks nothing.
@HiltWorker
class MraWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val sender: MraSender,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        runCatching { sender.tick() }
        return Result.success()
    }
}

object MraWork {
    private const val PERIODIC = "mra-periodic"
    private const val SOON = "mra-soon"
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun start(context: Context) {
        val req = PeriodicWorkRequestBuilder<MraWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    // once the line is back, and not before delayMs
    fun soon(context: Context, delayMs: Long) {
        val req = OneTimeWorkRequestBuilder<MraWorker>().setConstraints(online).setInitialDelay(delayMs, TimeUnit.MILLISECONDS).build()
        WorkManager.getInstance(context).enqueueUniqueWork(SOON, ExistingWorkPolicy.KEEP, req)
    }

    fun stop(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        WorkManager.getInstance(context).cancelUniqueWork(SOON)
    }
}
