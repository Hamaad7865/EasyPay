package com.restopos.core.common

import android.content.Context
import android.os.Build
import com.restopos.app.BuildConfig
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.time.Instant

// When the till stops unexpectedly it writes down where: the stack trace, its
// version and the tablet, one small file per crash. Nothing of a sale and no
// name goes in: not even the error's own message. The next sync sends the files to the restaurant's own server
// and deletes them, so EasyPay hears of a crash before the restaurant has to
// call. Android's own handler runs afterwards, exactly as before.
object Crashes {
    private const val DIR = "crashes"
    private const val KEEP = 10

    fun install(context: Context) {
        val dir = File(context.filesDir, DIR)
        val before = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                dir.mkdirs()
                // a till that stops on every start must not fill the tablet
                dir.listFiles()?.sortedBy { it.name }?.dropLast(KEEP - 1)?.forEach { it.delete() }
                val at = System.currentTimeMillis()
                File(dir, "$at.json").writeText(describe(at, thread.name, error).toString())
            }
            before?.uncaughtException(thread, error)
        }
    }

    fun describe(at: Long, thread: String, error: Throwable): JsonObject = buildJsonObject {
        put("at", Instant.ofEpochMilli(at).toString())
        put("app_version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        put("android", Build.VERSION.RELEASE ?: "")
        put("model", listOfNotNull(Build.MANUFACTURER, Build.MODEL).joinToString(" "))
        put("thread", thread)
        put("trace", where(error))
    }

    // Where it stopped: the kind of error and the path through the program,
    // for the error and whatever caused it. An error's own message is left
    // out on purpose: it can quote what was being worked on (a customer's
    // name in a line that could not be read, say), and that stays on the tablet.
    fun where(error: Throwable): String {
        val out = StringBuilder()
        var e: Throwable? = error
        var depth = 0
        while (e != null && depth < 6) {
            out.append(if (depth == 0) "" else "Caused by: ").append(e.javaClass.name).append('\n')
            e.stackTrace.take(60).forEach { out.append("\tat ").append(it.toString()).append('\n') }
            e = e.cause?.takeIf { it !== e }
            depth++
        }
        return out.toString().take(20_000)
    }

    // The reports waiting to be sent, oldest first, each with its file. A file
    // that cannot be read is thrown away rather than tried for ever.
    fun waiting(context: Context): List<Pair<File, JsonObject>> =
        (File(context.filesDir, DIR).listFiles() ?: emptyArray()).sortedBy { it.name }.take(KEEP).mapNotNull { f ->
            runCatching { Json.parseToJsonElement(f.readText()).jsonObject }.getOrNull()?.let { f to it } ?: run { f.delete(); null }
        }
}
