package com.restopos.core.kitchen

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

// What a kitchen sets on its own screen, and keeps on that tablet: one set
// per screen, since a bar's five minutes are not a grill's fifteen. The owner
// asked for the kitchen to be configurable, and chose these: when a ticket
// turns late, what a ticket shows, and sound and display. (Which items a
// screen shows is the back office's: Printers.)
data class KitchenPrefs(
    // a ticket's head turns amber, then red, after this many minutes
    val amberMin: Int = 8,
    val redMin: Int = 15,
    // what a ticket shows besides its table or number and its items
    val covers: Boolean = true,
    val waiter: Boolean = true,
    val kind: Boolean = true, // the order type: Dine-in, Takeaway
    val remark: Boolean = true,
    // a short sound when an order arrives (a kitchen tablet's own; the till's
    // Kitchen screen follows the back office's POS setting)
    val sound: Boolean = true,
    val largeText: Boolean = false,
) {
    enum class Tone { Fresh, Amber, Red }

    fun tone(ageMs: Long): Tone {
        val minutes = ageMs / 60_000
        return when {
            minutes >= redMin -> Tone.Red
            minutes >= amberMin -> Tone.Amber
            else -> Tone.Fresh
        }
    }

    fun late(ageMs: Long): Boolean = tone(ageMs) == Tone.Red

    companion object {
        // the minutes as they may be kept: 1 to 120, red at least a minute after amber
        fun tidy(amber: Int, red: Int): Pair<Int, Int> {
            val a = amber.coerceIn(1, 119)
            return a to red.coerceIn(a + 1, 120)
        }
    }
}

private val Context.kitchenPrefs by preferencesDataStore("kitchen_prefs")

// Where they are kept: on this tablet, apart from everything a sign-out clears.
@Singleton
class KitchenPrefsStore @Inject constructor(@ApplicationContext private val context: Context) {
    private val amber = intPreferencesKey("amber_min")
    private val red = intPreferencesKey("red_min")
    private val covers = booleanPreferencesKey("show_covers")
    private val waiter = booleanPreferencesKey("show_waiter")
    private val kind = booleanPreferencesKey("show_kind")
    private val remark = booleanPreferencesKey("show_remark")
    private val sound = booleanPreferencesKey("sound")
    private val large = booleanPreferencesKey("large_text")

    val prefs: Flow<KitchenPrefs> = context.kitchenPrefs.data.map { p ->
        val d = KitchenPrefs()
        val (a, r) = KitchenPrefs.tidy(p[amber] ?: d.amberMin, p[red] ?: d.redMin)
        KitchenPrefs(a, r, p[covers] ?: d.covers, p[waiter] ?: d.waiter, p[kind] ?: d.kind, p[remark] ?: d.remark, p[sound] ?: d.sound, p[large] ?: d.largeText)
    }

    suspend fun save(v: KitchenPrefs) {
        val (a, r) = KitchenPrefs.tidy(v.amberMin, v.redMin)
        context.kitchenPrefs.edit {
            it[amber] = a; it[red] = r
            it[covers] = v.covers; it[waiter] = v.waiter; it[kind] = v.kind; it[remark] = v.remark
            it[sound] = v.sound; it[large] = v.largeText
        }
    }
}
