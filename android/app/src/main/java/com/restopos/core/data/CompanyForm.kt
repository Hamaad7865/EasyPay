package com.restopos.core.data

// Who the business is on paper: what prints at the top of every receipt,
// bill and closing report. The first-run set-up saves what the back office's
// Company details saves (server 0089, company.save), with the same lengths.
object CompanyForm {
    class Company(val name: String, val address: String, val phone: String, val brn: String, val vat: String)

    // What the boxes hold, read: or why not.
    fun read(name: String, address: String, phone: String, brn: String, vat: String): Result<Company> = runCatching {
        val called = name.trim().take(80)
        require(called.isNotEmpty()) { "The business needs a name" }
        Company(called, address.trim().take(240), phone.trim().take(40), brn.trim().take(30), vat.trim().take(30))
    }

    // The top of a receipt, line by line, as Docs.head prints it: the name,
    // the address, then the phone, the BRN and the VAT number where there is one.
    fun top(c: Company): List<String> = buildList {
        add(c.name)
        c.address.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.forEach { add(it) }
        if (c.phone.isNotBlank()) add("Tel: ${c.phone}")
        if (c.brn.isNotBlank()) add("BRN: ${c.brn}")
        if (c.vat.isNotBlank()) add("VAT: ${c.vat}")
    }

    // Whether two say the same thing: nothing to save.
    fun same(a: Company, b: Company): Boolean =
        a.name == b.name && a.address == b.address && a.phone == b.phone && a.brn == b.brn && a.vat == b.vat

    // The server's refusal of company.save (migration 0089), in words.
    fun refused(code: String?): String = when (code) {
        "name-required" -> "The business needs a name"
        "forbidden" -> "You are not allowed to change the business's details. Ask a manager."
        "unknown-op" -> "The server has to be updated before these can be changed from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }
}
