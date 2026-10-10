package com.restopos.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

// A role as a till's own sheet makes or changes it (server 0095): its name
// and what it may do. The owner's role, which may do everything, is made by
// EasyPay and is not changed here or anywhere.
object RoleForm {
    fun name(typed: String): Result<String> = runCatching {
        val called = typed.trim().take(30)
        require(called.isNotEmpty()) { "Give the role a name" }
        called
    }

    // What a role holds, from the JSON list it is kept as.
    fun held(permissions: String): Set<String> =
        runCatching { Json.parseToJsonElement(permissions).jsonArray.mapNotNull { it.jsonPrimitive.content } }.getOrDefault(emptyList()).toSet()

    fun isOwner(permissions: String): Boolean = "*" in held(permissions)

    // "Can do everything", or how many of what is offered it holds
    fun says(permissions: String, shop: Boolean): String {
        val has = held(permissions)
        if ("*" in has) return "Can do everything"
        val offered = Perms.offered(shop)
        return "${offered.count { it in has }} of ${offered.size} permissions"
    }

    // What a role holds after its sheet is saved: of what the sheet offered,
    // the ticks; and whatever it held that the sheet does not show (the other
    // kind of business's, one added since). The server does the same.
    fun saved(had: Set<String>, ticked: Set<String>, offered: List<String>): List<String> =
        (had.filter { it !in offered && it != "*" } + offered.filter { it in ticked }).distinct().sorted()

    fun refused(code: String?): String = when (code) {
        "name-required" -> "Give the role a name"
        "name-taken" -> "Another role already has that name."
        "owner-role" -> "The owner's role can do everything and cannot be changed."
        "role-in-use" -> "Staff still have this role. Give them another role first."
        "bad-role" -> "That role is no longer there."
        "forbidden" -> "You are not allowed to change roles. Ask the owner."
        "conflict" -> "That did not work. Close this and try again."
        "unknown-op" -> "The server has to be updated before roles can be changed from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }
}
