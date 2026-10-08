package com.restopos.core.kitchen

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

// The kitchen tablet listening on the restaurant's Wi-Fi. A till connects,
// writes its request (two lines) and is written one line back; then the
// connection is closed, as a printer's is. What the request means is not
// this class's business: it hands the two lines to `answer` (ScreenBook) and
// sends on what comes back.
//
// Plain sockets, as for printers: nothing leaves the building.
class ScreenServer(
    private val wanted: Int = Wire.PORT,
    // how long a caller has to say what it wants before it is let go
    private val readMs: Int = 5000,
    private val answer: suspend (String, String) -> String,
) {
    @Volatile private var socket: ServerSocket? = null
    private var job: Job? = null

    // the port really listened on (0 until started; `wanted` 0 asks for any free one)
    val port: Int get() = socket?.localPort ?: 0
    val listening: Boolean get() = socket?.isClosed == false

    // Starts listening. Throws IOException when the port cannot be had
    // (another app holds it, or this one is already listening on it).
    fun start(scope: CoroutineScope) {
        if (listening) return
        val s = ServerSocket()
        try {
            s.bind(InetSocketAddress(wanted))
        } catch (e: IOException) {
            s.close()
            throw e
        }
        socket = s
        job = scope.launch(Dispatchers.IO) {
            while (isActive) {
                // closed by stop(): there is nobody left to answer
                val caller = try { s.accept() } catch (e: IOException) { break }
                // each caller in its own turn: one that says nothing holds no one else up
                launch { serve(caller) }
            }
        }
    }

    private suspend fun serve(caller: Socket) {
        try {
            caller.use { c ->
                c.soTimeout = readMs
                val input = c.getInputStream()
                val first = readLine(input) ?: return
                val second = readLine(input) ?: return
                val reply = answer(first, second)
                c.getOutputStream().apply { write(reply.toByteArray(Charsets.UTF_8)); flush() }
            }
        } catch (e: IOException) {
            // a caller that went away, or said nothing in time: nothing to do
        }
    }

    fun stop() {
        runCatching { socket?.close() }
        socket = null
        job?.cancel()
        job = null
    }

    companion object {
        // The longest line taken. A send of a few hundred lines is a few tens
        // of kilobytes; anything near this is not a till.
        const val MAX_LINE = 256 * 1024

        // One line, without its ending. Null when the other end closed before
        // ending it, or it ran past the limit.
        internal fun readLine(input: InputStream): String? {
            val out = ByteArrayOutputStream(512)
            while (true) {
                val b = input.read()
                if (b < 0) return null
                if (b == '\n'.code) return out.toString(Charsets.UTF_8.name()).trimEnd('\r')
                out.write(b)
                if (out.size() > MAX_LINE) return null
            }
        }
    }
}

// The till's one exchange with a kitchen screen: connect, say it, read the
// answer, close. It blocks, so it is called off the main thread. Throws
// IOException when nothing answers in time, which is what the till reports
// as "the kitchen screen is not answering".
object ScreenClient {
    fun exchange(host: String, port: Int, payload: String, connectMs: Int = 1500, readMs: Int = 4000): String =
        Socket().use { s ->
            s.connect(InetSocketAddress(host, port), connectMs)
            s.soTimeout = readMs
            s.getOutputStream().apply { write(payload.toByteArray(Charsets.UTF_8)); flush() }
            ScreenServer.readLine(s.getInputStream().buffered()) ?: throw IOException("the kitchen screen closed the connection without answering")
        }
}
