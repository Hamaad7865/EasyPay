package com.restopos.core.mra

import com.restopos.core.database.MraCounts
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// What the strip under the top bar says of the MRA (plan Task 14). Sales carry
// on in every case: what cannot go waits and prints "Not Yet Fiscalised".
object MraBanner {
    data class Say(val text: String, val red: Boolean)

    const val LATE_MS = 3_600_000L
    private val HM = DateTimeFormatter.ofPattern("HH:mm")

    // A business live with EasyPay's MRA whose till the MRA still answers as
    // TEST: the MRA does not count its sales (its EBS is in the sandbox or a
    // Test Drive, not live on the MRA's side). Training is TEST by its nature.
    fun testAtMra(mode: String, environment: String?): Boolean = mode == "live" && environment == "TEST"

    fun say(mraOn: Boolean, hasLogin: Boolean, refused: String?, problem: String?, counts: MraCounts?, now: Long, zone: ZoneId = ZoneId.systemDefault(), testAtMra: Boolean = false): Say? {
        val waiting = counts?.waiting ?: 0
        if (!mraOn && waiting == 0) return null
        if (refused != null) return Say("The MRA refused this till's login: sales wait and print Not Yet Fiscalised. Settings, MRA.", true)
        if (testAtMra) return Say("The MRA answers this till as TEST: its sales are fiscalised but do not count. Its EBS is not live with the MRA yet. Settings, MRA.", true)
        if (mraOn && !hasLogin) return Say("This till is not connected to the MRA: sales wait and print Not Yet Fiscalised. Settings, MRA.", true)
        if (problem != null) return Say("The MRA refuses this till's invoices ($problem). Settings, MRA.", true)
        val oldest = counts?.oldestWaiting
        if (waiting > 0 && oldest != null && now - oldest > LATE_MS) {
            val since = HM.format(Instant.ofEpochMilli(oldest).atZone(zone))
            return Say("$waiting ${if (waiting == 1) "invoice is" else "invoices are"} waiting for the MRA since $since. They go once the line is back.", false)
        }
        return null
    }
}
