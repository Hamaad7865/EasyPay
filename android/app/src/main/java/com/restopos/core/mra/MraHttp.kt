package com.restopos.core.mra

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

// The one way a till talks to the MRA: one POST, never repeated here (a send
// repeated after a timeout can be fiscalised twice, the guide's 9.1), with its
// own timeouts (the till's other clients set none). What happened is one of
// three: the MRA answered; the request never reached it (nothing was sent);
// it went and no answer came (it may have been fiscalised). Nothing of the
// request, its headers or its answer is ever kept in an exception, a log or a
// report: only the kind of failure.
@Singleton
class MraHttp @Inject constructor() {
    sealed interface Out {
        data class Answered(val http: Int, val body: String) : Out
        data class NotReached(val why: String) : Out
        data class NoAnswer(val why: String) : Out
    }

    private val base by lazy { OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).build() }

    suspend fun post(r: MraApi.Request, timeoutMs: Long): Out = withContext(Dispatchers.IO) {
        val went = AtomicBoolean(false)
        val client = base.newBuilder()
            .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .eventListener(object : EventListener() {
                override fun requestBodyEnd(call: Call, byteCount: Long) { went.set(true) }
            })
            .build()
        val type = r.headers.firstOrNull { it.first.equals("Content-Type", ignoreCase = true) }?.second ?: "application/json"
        // bytes, so that OkHttp adds no "; charset=utf-8": the header is the one the MRA accepted
        val request = Request.Builder().url(r.url).post(r.body.toByteArray(Charsets.UTF_8).toRequestBody(type.toMediaType()))
            .apply { r.headers.filter { !it.first.equals("Content-Type", ignoreCase = true) }.forEach { (k, v) -> header(k, v) } }
            .build()
        try {
            client.newCall(request).execute().use { Out.Answered(it.code, it.body?.string() ?: "") }
        } catch (e: IOException) {
            // only the kind of failure: its message may hold the address, never anything else of ours, but it is not kept
            if (went.get()) Out.NoAnswer(e.javaClass.simpleName) else Out.NotReached(e.javaClass.simpleName)
        } catch (e: IllegalArgumentException) {
            Out.NotReached("bad address")
        }
    }
}
