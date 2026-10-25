package com.restopos.core.data

import android.content.Context
import com.restopos.core.database.DayCloseEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.MailClient
import com.restopos.core.print.Docs
import com.restopos.core.print.Printing
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.ZMailWork
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.SecureRandom
import javax.inject.Inject
import javax.inject.Singleton

// The Z report by email: each day closing of this till, mailed to the address
// the owner typed, once that address has confirmed (ZMailRules; the service is
// cloudflare/mail). Every plan, offline tablets included: the service is not
// EasyPay's server and wakes no database.
//
// Nothing is queued apart from the closings themselves. The till keeps the
// moment it has mailed up to, and a run mails every closing after it that is
// in its database, the oldest first: closed by hand, by the back office's ask
// or by itself, with or without a connection at the time. A closing cannot be
// lost between being closed and being mailed, and none is mailed twice (the
// service takes a closing's id once).
@Singleton
class ZMail @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val cash: CashOps,
    private val printing: Printing,
    private val mail: MailClient,
    @ApplicationContext private val context: Context,
) {
    val setting: Flow<ZMailSetting> get() = session.zMail

    private fun now() = System.currentTimeMillis()
    private fun newKey(): String = ZMailRules.key(ByteArray(32).also { SecureRandom().nextBytes(it) })

    // Saved from Settings. The address is asked as soon as there is a connection.
    suspend fun save(on: Boolean, typed: String): Result<ZMailSetting> = runCatching {
        if (on) require(ZMailRules.address(typed) != null) { "That is not an email address." }
        session.editZMail { ZMailRules.saved(it, on, typed, now()) { newKey() } }.also { ZMailWork.soon(context) }
    }

    // "Send it again": the address is mailed to confirm once more.
    suspend fun again() { session.editZMail { ZMailRules.again(it) }; ZMailWork.soon(context) }

    // Asks the service how the address stands, when Settings is opened.
    fun check() = ZMailWork.soon(context)

    // The closings still to mail.
    suspend fun waiting(): Int {
        val s = session.zMail()
        if (!s.on) return 0
        val device = session.deviceId() ?: return 0
        return db.ops().dayClosesAfter(device, ZMailRules.from(s, now()), 100).size
    }

    // One run. What was switched off is forgotten by the service, the address
    // is asked or looked up, and the closings due are mailed, the oldest
    // first. True: nothing more to do for now. False: try again later (no
    // connection, the service down or over a limit).
    suspend fun run(): Boolean {
        var s = session.zMail()
        for (f in s.forget) {
            if (ZMailRules.later(mail.call("stop", buildJsonObject { put("to", f.to); put("key", f.key) }))) return false
            s = session.editZMail { it.copy(forget = it.forget - f) }
        }
        if (!s.on || ZMailRules.address(s.to) == null) return true
        val device = session.deviceId() ?: return true
        if (s.state == ZMailRules.ASK) {
            val a = mail.call("ask", buildJsonObject { put("to", s.to); put("key", s.key); put("business", business()); put("till", till(device)) }) ?: return false
            s = answered(s) { ZMailRules.asked(it, a, now()) }
            if (ZMailRules.later(a)) return false
        }
        if (s.state == ZMailRules.WAITING) {
            val a = mail.call("state", buildJsonObject { put("to", s.to); put("key", s.key) }) ?: return false
            s = answered(s) { ZMailRules.checked(it, a) }
            if (ZMailRules.later(a)) return false
            // Nobody has pressed Confirm yet. The service cannot tell the till
            // when someone does, so the till asks again, later each time (1, 2,
            // 4 ... minutes, then every 5 hours), until it is confirmed or the
            // link's week is over: an owner who confirms at once has the day's
            // closing in minutes.
            if (s.state == ZMailRules.WAITING) return false
        }
        while (s.on && s.state == ZMailRules.YES) {
            val rows = db.ops().dayClosesAfter(device, ZMailRules.from(s, now()), ZMailRules.BATCH)
            if (rows.isEmpty()) return true
            for (row in rows) {
                val a = mail.call("z", report(s, row)) ?: return false
                s = answered(s) { ZMailRules.mailed(it, row.closed_at, row.number, now(), a) }
                if (ZMailRules.later(a)) return false
                // not taken, and not to be passed over: tried again later, never in a loop here
                if (s.on && s.state == ZMailRules.YES && s.after < row.closed_at) return false
                if (!s.on || s.state != ZMailRules.YES) return true
            }
        }
        return true
    }

    // An answer is written onto the setting as it is now, if it is still for
    // that address: the owner may have changed it while the tablet was asking.
    private suspend fun answered(asked: ZMailSetting, rule: (ZMailSetting) -> ZMailSetting): ZMailSetting =
        session.editZMail { if (ZMailRules.stillFor(it, asked)) rule(it) else it }

    // A closing as its paper prints it, as lines of text: the one Print again
    // makes from the database, on an 80 mm roll's width.
    private suspend fun report(s: ZMailSetting, row: DayCloseEntity): JsonObject {
        val z = cash.dayDocOf(row)
        val st = printing.settings()
        val paper = printing.mailPaper()
        val shop = printing.shop()
        val lines = Docs.zLook(z, shop, paper, st.decimals, st.dayCloseDetailed)
        val parts = Docs.zParts(z, shop, paper, st.decimals, st.dayCloseDetailed)
        return buildJsonObject {
            put("to", s.to); put("key", s.key)
            put("id", row.id); put("number", row.number); put("date", Docs.stamp(row.closed_at))
            put("business", business()); put("till", z.till); put("test", paper.trial)
            // the paper's text, for a mail read as text; its parts, for the report and its PDF
            put("lines", JsonArray(lines.map { JsonPrimitive(it) }))
            put("parts", ZMailRules.partsJson(parts))
        }
    }

    private suspend fun business(): String = printing.shop().name.ifBlank { session.businessName().orEmpty() }
    private suspend fun till(device: String): String = db.catalog().device(device)?.name ?: "Till"
}
