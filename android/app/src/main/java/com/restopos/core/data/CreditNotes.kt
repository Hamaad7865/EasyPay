package com.restopos.core.data

import com.restopos.core.database.CreditNoteEntity
import com.restopos.core.database.TillDatabase
import javax.inject.Inject
import javax.inject.Singleton

// What an exchange's refund keeps for the customer on a credit note: the
// refund writes the note itself, under its own number, in its transaction.
data class NoteSpec(val id: String, val amount: Long, val validTo: String?, val customerId: String?)

// A shop's credit notes on this tablet: found by number to be spent on Pay.
// Issuing is the refund's (OrderOps.refund, with a NoteSpec); spending takes
// the balance down in the sale's own transaction (TicketRepository.pay), and
// the server's figure replaces the tablet's on the next pull.
@Singleton
class CreditNotes @Inject constructor(private val db: TillDatabase) {
    suspend fun find(number: String): CreditNoteEntity? = db.notes().byNumber(number.trim().uppercase())

    // Why a note cannot be spent, in words; null when it can. today: yyyy-mm-dd.
    fun refusal(n: CreditNoteEntity?, today: String = today()): String? = when {
        n == null -> "This till does not know that note. Let it sync and try again, or take another payment."
        n.status == "void" -> "Credit note ${n.number} was cancelled by the shop."
        n.status == "used" || n.balance <= 0 -> "Credit note ${n.number} has been used up."
        n.valid_to != null && n.valid_to < today -> "Credit note ${n.number} expired on ${n.valid_to}."
        else -> null
    }

    companion object {
        fun today(): String = java.time.LocalDate.now().toString()
    }
}
