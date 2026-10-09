package com.restopos.core.common

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.concurrent.thread
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin

// The sounds the till and a kitchen screen make. The owner asked for them:
// "It should make sound when orders arrived in the kitchen screen", and a
// sound when a takeaway is marked ready.
//
// Each is a few notes made here, not a file and not the tablet's own
// notification sound: a kitchen is loud, and a tablet's notification volume
// is often down or on silent. They are played as an alarm is, so they sound
// whatever the notification volume says, and the tablet's volume keys set
// how loud while EasyPay is open (MainActivity).
object Chime {
    const val RATE = 44_100

    // a note: its pitch in hertz and how long it rings, in milliseconds
    class Note(val hz: Double, val ms: Int)

    // An order has arrived in the kitchen: two notes, rising.
    val ORDER = listOf(Note(880.0, 170), Note(1318.5, 320))
    // A takeaway is ready to hand over: three notes, rising, unlike the kitchen's.
    val READY = listOf(Note(784.0, 130), Note(987.8, 130), Note(1568.0, 380))

    fun order() = play(ORDER)
    fun ready() = play(READY)

    // The notes as sound: each starts at once and dies away like a bell, so
    // none begins or ends on a click. A short quiet stretch ends it, so the
    // last note is not cut off by the player stopping.
    fun pcm(notes: List<Note>, rate: Int = RATE): ShortArray {
        val tail = rate * 60 / 1000
        val out = ShortArray(notes.sumOf { rate * it.ms / 1000 } + tail)
        var at = 0
        for (n in notes) {
            val len = rate * n.ms / 1000
            for (i in 0 until len) {
                val t = i.toDouble() / rate
                val attack = minOf(1.0, i / (rate * 0.004))
                val decay = exp(-3.2 * i / len)
                // the note and a little of the one an octave above it: a bell, not a beep
                val wave = sin(2 * PI * n.hz * t) + 0.25 * sin(2 * PI * 2 * n.hz * t)
                out[at + i] = (wave / 1.25 * attack * decay * 0.85 * Short.MAX_VALUE).toInt().toShort()
            }
            at += len
        }
        return out
    }

    // Played off the screen's thread, and never an error to whoever asked: a
    // tablet with no sound must still take the order.
    private fun play(notes: List<Note>) {
        thread(name = "chime", isDaemon = true) {
            runCatching {
                val samples = pcm(notes)
                val track = AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(samples.size * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build()
                try {
                    track.write(samples, 0, samples.size)
                    track.play()
                    Thread.sleep(samples.size * 1000L / RATE + 120)
                } finally {
                    track.release()
                }
            }
        }
    }
}
