package com.restopos.core.data

import com.restopos.core.common.PinHash

// A member of staff and a PIN, as the first-run set-up adds and sets them.
// The server has the last word (0089, staff.save and staff.set_pin): it takes
// the PIN's hash and never the PIN, and only from someone who may manage
// staff, which is the owner.
object StaffForm {
    // The name and the PIN, or why they are not those of someone to add.
    fun read(name: String, pin: String): Result<Pair<String, String>> = runCatching {
        val called = name.trim().take(80)
        require(called.isNotEmpty()) { "Give them a name" }
        require(PinHash.isPin(pin)) { "A PIN is 4 digits" }
        called to pin
    }

    // Once anyone has a PIN the till asks for one: to clock in, to open the
    // day, and of someone who may whenever a cashier needs a go-ahead. So the
    // first PIN goes to someone who may open the day and set up the till: the
    // owner, or a manager. A cashier may open the day and approve nothing, and
    // a till where only a cashier had a PIN would have nobody to ask.
    fun leads(member: StaffMember): Boolean = member.can("shift.open_close") && member.can("settings.device")

    // Whether this person may be given a PIN now.
    fun mayHavePin(member: StaffMember, all: List<StaffMember>): Boolean = leads(member) || mayAdd(all)

    // Whether someone can be added: they come with a PIN.
    fun mayAdd(all: List<StaffMember>): Boolean = all.any { it.hasPin && leads(it) }

    // The server's refusal of staff.save or staff.set_pin (migration 0089), in words.
    fun refused(code: String?): String = when (code) {
        "name-required" -> "Give them a name"
        "forbidden" -> "Only the owner can add staff or set a PIN. Ask the owner, or do it in the back office, under Staff."
        "bad-role" -> "That role is no longer there. Pick another."
        "bad-pin" -> "That PIN could not be saved. Type it again."
        "unknown-staff" -> "That person is no longer there."
        "conflict" -> "That did not work. Close this and try again."
        "unknown-op" -> "The server has to be updated before staff can be added from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }
}
