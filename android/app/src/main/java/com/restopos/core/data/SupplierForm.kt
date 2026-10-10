package com.restopos.core.data

// A supplier as the till's own sheet makes or changes one: who a shop buys
// from. The server checks it again and has the last word (migration 0092);
// reading it here catches a slip before the tablet asks, and puts the
// server's refusals in the till's words. The lengths are the back office's.
object SupplierForm {
    data class Supplier(
        val name: String, val contact: String = "", val phone: String = "", val email: String = "", val address: String = "", val note: String = "",
    )

    // As it will be kept: the spaces round each field gone, each cut to what the server keeps.
    fun clean(s: Supplier) = Supplier(
        s.name.trim().take(120), s.contact.trim().take(120), s.phone.trim().take(40), s.email.trim().take(120), s.address.trim().take(200), s.note.trim().take(200),
    )

    // Why it cannot be saved yet, or null.
    fun problem(s: Supplier): String? = if (s.name.isBlank()) "A supplier needs a name." else null

    // The server's refusal of supplier.save or supplier.remove, in words.
    fun refused(code: String?): String = when (code) {
        "name-taken" -> "Another supplier already has that name."
        "name-required" -> "A supplier needs a name."
        "unknown-supplier" -> "That supplier was removed. Add it again under a new entry."
        "forbidden" -> "You are not allowed to change suppliers. Ask a manager."
        "conflict" -> "That did not work. Close this and try again."
        "unknown-op" -> "The server has to be updated before suppliers can be changed from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }
}
