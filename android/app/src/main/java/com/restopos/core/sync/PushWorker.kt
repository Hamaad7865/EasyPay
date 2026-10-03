package com.restopos.core.sync

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.room.withTransaction
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.ApiClient
import com.restopos.core.network.ApiError
import com.restopos.core.network.AuthRequired
import com.restopos.core.network.dto.OutboxOp
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import kotlinx.serialization.json.Json
import java.io.IOException
import java.util.concurrent.TimeUnit

internal const val PUSH_WORK = "push-now"

// Push (spec 5.4): outbox rows in creation order, batches of 50, until the
// outbox is empty. Per op the server answers:
//   applied   done (also when it had already seen the op_id: replayed)  -> row removed
//   rejected  a business refusal with a code                           -> dead-letter, data kept
//   retry     transient; this op and every later one were not processed -> stay queued, in order
// Network failures and 5xx retry with backoff. A 401 is handled inside
// ApiClient (token refresh, one retry). If the session itself is gone, the
// rows stay queued and the tablet asks for a sign-in; signing in again pushes
// them. A pull follows every successful push.
@HiltWorker
class PushWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val db: TillDatabase,
    private val api: ApiClient,
    private val session: SessionStore,
) : CoroutineWorker(context, params) {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun doWork(): Result {
        var pushedAny = false
        var mustRetry = false
        while (!mustRetry) {
            val batch = db.outbox().pending(BATCH)
            if (batch.isEmpty()) break
            val ops = batch.map { row -> OutboxOp(row.op_id, row.type, json.parseToJsonElement(row.payload)) }
            val results = try {
                api.push(ops)
            } catch (e: AuthRequired) {
                session.setNeedsSignIn(true)
                return Result.failure()
            } catch (e: IOException) {
                return Result.retry()
            } catch (e: ApiError) {
                return if (e.status >= 500) Result.retry() else Result.failure()
            }
            val byId = results.associateBy { it.opId }
            var progressed = false
            db.withTransaction {
                batch.forEach { row ->
                    val result = byId[row.op_id]
                    when (result?.status) {
                        "applied", "duplicate" -> { db.outbox().remove(row.op_id); progressed = true }
                        "rejected" -> { db.outbox().dead(row.op_id, result.code ?: "rejected"); progressed = true }
                        else -> mustRetry = true // "retry", or not answered: stays queued
                    }
                }
            }
            pushedAny = pushedAny || progressed
            if (!progressed) mustRetry = true
        }
        if (pushedAny) SyncScheduler.pullNow(applicationContext)
        return if (mustRetry) Result.retry() else Result.success()
    }

    private companion object {
        const val BATCH = 50
    }
}

fun pushNow(context: Context) {
    val req = OneTimeWorkRequestBuilder<PushWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .build()
    WorkManager.getInstance(context).enqueueUniqueWork(PUSH_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, req)
}
