package com.restopos.core.sync

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.restopos.core.data.ZMail
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit

// The Z report's email on its own (ZMail.run): once the line is up, after each
// day closing, when the setting is saved and when Settings is opened; again
// and again, later each time, while an address waits for its Confirm; and
// every 6 hours. A till with the setting off and nothing to forget asks nothing.
@HiltWorker
class ZMailWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val zMail: ZMail,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = if (runCatching { zMail.run() }.getOrDefault(false)) Result.success() else Result.retry()
}

object ZMailWork {
    private const val PERIODIC = "z-mail-periodic"
    private const val SOON = "z-mail-soon"
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun start(context: Context) {
        val req = PeriodicWorkRequestBuilder<ZMailWorker>(6, TimeUnit.HOURS).setConstraints(online).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    // Once the line is up. One that comes while another runs goes after it, so
    // a closing made during a run is not left for the next six hours.
    fun soon(context: Context) {
        val req = OneTimeWorkRequestBuilder<ZMailWorker>().setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES).build()
        WorkManager.getInstance(context).enqueueUniqueWork(SOON, ExistingWorkPolicy.APPEND_OR_REPLACE, req)
    }

    fun stop(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        WorkManager.getInstance(context).cancelUniqueWork(SOON)
    }
}
