package com.restopos.core.sync

import com.restopos.core.data.GoLiveRules
import com.restopos.core.data.PosSettings
import com.restopos.core.data.settingUpNow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// Go live of a business in the cloud (server 0157). While the server says the
// business is being set up, its tablets mark what they ring up TEST and offer
// Go live, as a tablet alone does. Going live, the server clears the test
// sales of every till, puts their stock back, and writes `cleared` (as Delete
// all transactions does) and `live`, when, in ms. A till empties itself on the
// mark (OfficeClear), and first drops from its queue what was rung up before
// `live`: the server drops it too, by the same list.
class PremiumGoLiveTest {
    private val at = "2026-11-06T14:46:30.922201+00:00"
    private val live = 1_793_976_390_922L

    @Test fun the_server_and_the_till_drop_the_same_kinds() {
        val file = Json.parseToJsonElement(File("../../db/tests/fixtures/go-live/rung-up.json").readText()).jsonObject
        val kinds = file["kinds"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
        assertEquals(GoLiveRules.RUNG_UP, kinds)
    }

    @Test fun the_settings_say_whether_the_business_is_being_set_up_and_since_when_it_is_live() {
        val setting = PosSettings.parse("""{"plan":"premium","settingUp":true}""")
        assertTrue(setting.settingUp)
        assertNull(setting.live)
        val gone = PosSettings.parse("""{"plan":"premium","cleared":"$at","live":$live}""")
        assertFalse(gone.settingUp)
        assertEquals(live, gone.live)
        assertNull(PosSettings.parse("""{"live":"soon"}""").live)
        assertNull(PosSettings.parse("""{"live":0}""").live)
    }

    @Test fun a_business_in_the_cloud_is_being_set_up_when_the_server_says_so() {
        assertTrue(settingUpNow(own = false, PosSettings.parse("""{"plan":"premium","settingUp":true}""")))
        assertTrue(settingUpNow(own = false, PosSettings.parse("""{"plan":"trial","settingUp":true}""")))
        assertFalse(settingUpNow(own = false, PosSettings.parse("""{"plan":"premium"}""")))
        // the tablet's own flag is a tablet alone's: in the cloud the server decides
        assertFalse(settingUpNow(own = true, PosSettings.parse("""{"plan":"premium"}""")))
    }

    @Test fun a_tablet_alone_goes_by_its_own_flag_as_before() {
        assertTrue(settingUpNow(own = true, PosSettings.parse("""{"plan":"offline"}""")))
        assertFalse(settingUpNow(own = false, PosSettings.parse("""{"plan":"offline","settingUp":true}""")))
    }

    @Test fun on_a_go_live_mark_not_acted_on_what_was_rung_up_before_live_goes() {
        assertEquals(live, OfficeClear.dropBefore(live, at, applied = null, alone = false))
        assertEquals(live, OfficeClear.dropBefore(live, at, applied = "2026-10-01T00:00:00+00:00", alone = false))
    }

    @Test fun nothing_is_dropped_once_acted_on_on_a_tablet_alone_or_with_no_go_live() {
        assertNull(OfficeClear.dropBefore(live, at, applied = at, alone = false))
        assertNull(OfficeClear.dropBefore(live, at, applied = null, alone = true))
        // Delete all transactions alone writes no `live`
        assertNull(OfficeClear.dropBefore(null, at, applied = null, alone = false))
        assertNull(OfficeClear.dropBefore(live, null, applied = null, alone = false))
    }
}
