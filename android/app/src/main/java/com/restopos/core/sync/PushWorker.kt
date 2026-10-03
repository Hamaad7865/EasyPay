package com.restopos.core.sync

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkerParameters
import androidx.room.withTransaction
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.ApiClient
import com.restopos.core.network.AuthClient
import com.restopos.core.network.dto.OutboxOp
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import java.util.concurrent.TimeUnit

// Push (spec 5.4): outbox rows in creation order, batches of 50. applied and
// duplicate delete the row (duplicate = the server already has it, e.g. the
// app was killed mid-push, spec 14.3). rejected moves to dead-letter and
// surfaces as a manager badge; local data is kept. Network failure retries
// with exponential backoff; a 401 refreshes the JWT once and retries.
@HiltWorker
class PushWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val db: TillDatabase,
    private val api: ApiClient,
    private val auth: AuthClient,
) : CoroutineWorker(context, params) {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun doWork(): Result {
        val batch = db.outbox().pending(50)
        if (batch.isEmpty()) return Result.success()
        val ops = batch.map { row ->
            OutboxOp(row.op_id, row.type, json.parseToJsonElement(row.payload))
        }
        val results = try {
            api.push(ops)
        } catch (e: io.ktor.client.plugins.ClientRequestException) {
            if (e.response.status.value == 401 && auth.refreshJwt().isSuccess) {
                try {
                    return pushOnce(batch)
                } catch (e2: Exception) {
                    return if (e2 is java.io.IOException) Result.retry() else Result.failure()
                }
            }
            return Result.retry()
        } catch (e: java.io.IOException) {
            return Result.retry()
        } catch (e: Exception) {
            return Result.failure()
        }
        return applyResults(batch, results)
    }

    private suspend fun pushOnce(batch: List<OutboxEntity>): Result {
        val ops = batch.map { row ->
            OutboxOp(row.op_id, row.type, json.parseToJsonElement(row.payload))
        }
        return applyResults(batch, api.push(ops))
    }

    private suspend fun applyResults(batch: List<OutboxEntity>, results: List<com.restopos.core.network.dto.OpResult>): Result {
        val byId = results.associateBy { it.opId }
        db.withTransaction {
            batch.forEach { row ->
                when (byId[row.op_id]?.status) {
                    "applied", "duplicate" -> db.outbox().remove(row.op_id)
                    "rejected" -> db.outbox().dead(row.op_id, byId[row.op_id]?.code ?: "rejected")
                    else -> Unit // server omitted it: leave pending for next run
                }
            }
        }
        return Result.success()
    }
}

fun pushNow(context: Context) {
    val req = OneTimeWorkRequestBuilder<PushWorker>()
        .setConstraints(Constraints(requiredNetworkType = NetworkType.CONNECTED))
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .build()
    androidx.work.WorkManager.getInstance(context)
        .enqueueUniqueWork("push-now", ExistingWorkPolicy.APPEND_OR_REPLACE, req)
}
