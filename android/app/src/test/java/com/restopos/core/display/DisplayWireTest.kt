package com.restopos.core.display

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

// What a till and a customer display say to each other: nothing from a
// stranger, nothing changed on the way, and a newer build still understood.
class DisplayWireTest {
    private val code = "DSPLY234"
    private val picture = Picture(Picture.SALE, "Sale", listOf(PicLine("2", "Burger", "Egg", 24000)), total = 24000)
    private val req = DisplayRequest(till = "t-1", tillName = "Till 1", display = "Counter", picture = picture, logoHash = "abc", now = 5)

    private fun lines(text: String): Pair<String, String> = text.trimEnd('\n').split('\n').let { it[0] to it[1] }

    @Test
    fun aSignedRequestIsRead() {
        val (first, second) = lines(DisplayWire.encode(req, code))
        assertEquals(req, DisplayWire.decode(first, second, code))
    }

    @Test
    fun anotherCodeOrAChangedRequestIsNotRead() {
        val (first, second) = lines(DisplayWire.encode(req, code))
        assertNull(DisplayWire.decode(first, second, "KTCHN234"))
        assertNull(DisplayWire.decode(first.replace("Burger", "Cake"), second, code))
        assertNull(DisplayWire.decode("not json", com.restopos.core.kitchen.Wire.sign(code, "not json"), code))
    }

    @Test
    fun aReplyGoesThereAndBack() {
        val reply = DisplayReply(ok = false, error = DisplayWire.OTHER_VERSION, build = 33, logoHash = "f00")
        assertEquals(reply, DisplayWire.decodeReply(DisplayWire.encode(reply).trimEnd('\n')))
        assertNull(DisplayWire.decodeReply("nonsense"))
    }

    @Test
    fun aNewerBuildIsStillUnderstood() {
        // a key this build does not know, as a later build may send
        val line = """{"v":1,"till":"t-1","tillName":"Till 1","display":"Counter","picture":{"state":"idle","shine":true},"later":42}"""
        val read = DisplayWire.decode(line, com.restopos.core.kitchen.Wire.sign(code, line), code)
        assertNotNull(read)
        assertEquals(Picture.IDLE, read!!.picture.state)
    }

    @Test
    fun aLogoIsComparedByItsHash() {
        assertEquals("", DisplayWire.hash(null))
        assertEquals("", DisplayWire.hash(""))
        val a = DisplayWire.hash("data:image/png;base64,AAAA")
        assertEquals(16, a.length)
        assertEquals(a, DisplayWire.hash("data:image/png;base64,AAAA"))
        assertNotEquals(a, DisplayWire.hash("data:image/png;base64,AAAB"))
    }

    // What Settings, Printers says of a display, by how it answered.
    @Test
    fun troubleInWords() {
        assertNull(DisplayWire.trouble("Counter", "10.0.2.5", DisplayReply(ok = true)))
        assertEquals(true, DisplayWire.trouble("Counter", "", null)!!.contains("no address"))
        assertEquals(true, DisplayWire.trouble("Counter", "10.0.2.5", null)!!.startsWith("Counter is not answering"))
        assertEquals(true, DisplayWire.trouble("Counter", "10.0.2.5", DisplayReply(false, DisplayWire.REFUSED))!!.contains("pairing code"))
        assertEquals(true, DisplayWire.trouble("Counter", "10.0.2.5", DisplayReply(false, DisplayWire.OTHER_VERSION))!!.contains("version"))
    }

    @Test
    fun anAddressWithoutAPortIsTheDisplays() {
        assertEquals("10.0.2.5" to 9311, DisplayWire.address("10.0.2.5"))
        assertEquals("10.0.2.5" to 9400, DisplayWire.address(" 10.0.2.5:9400 "))
        assertNull(DisplayWire.address(""))
        assertNull(DisplayWire.address("10.0.2.5:x"))
        // the kitchen screen's own default is unchanged
        assertEquals("10.0.2.5" to 9310, com.restopos.core.kitchen.Wire.address("10.0.2.5"))
    }

    // A logo at its largest and a picture at its largest each fit the line a
    // display takes, alone; together they would not, and are never sent so.
    @Test
    fun aLogoAndAPictureEachFitAndTravelApart() {
        val logo = "data:image/png;base64," + "A".repeat(DisplayWire.MAX_LOGO - 22)
        val poster = Poster("0123456789abcdef", java.util.Base64.getEncoder().encodeToString(ByteArray(DisplayPictures.MAX_BYTES)))
        // the request's first line, as the display reads it
        fun line(r: DisplayRequest) = DisplayWire.encode(r, code).lineSequence().first()
        val limit = com.restopos.core.kitchen.ScreenServer.MAX_LINE
        assertEquals(true, line(req.copy(logo = logo)).toByteArray().size < limit)
        assertEquals(true, line(req.copy(poster = poster, posters = listOf(poster.hash))).toByteArray().size < limit)
        assertEquals(true, line(req.copy(logo = logo, poster = poster)).toByteArray().size > limit)
        assertEquals(logo to null, DisplayWire.parcel(logo, poster))
        assertEquals(null to poster, DisplayWire.parcel(null, poster))
        assertEquals(logo to null, DisplayWire.parcel(logo, null))
    }
}
