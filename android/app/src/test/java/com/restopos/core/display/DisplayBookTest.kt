package com.restopos.core.display

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// What a customer display does with what a till sends it: nothing from a
// stranger, the latest picture shown, and no old order left on the screen
// once its till has gone quiet.
class DisplayBookTest {
    private val code = "DSPLY234"
    private var now = 1_000_000L
    private val kept = ArrayList<Pair<String?, String>>()
    private val shelf = DisplayBook.MemoryPosters()
    private val book = DisplayBook(code = { code }, build = 33, clock = { now }, keepLogo = { l, h -> kept += l to h }, shelf = shelf)
    private val jpegA = byteArrayOf(1, 2, 3, 4)
    private val jpegB = byteArrayOf(5, 6, 7)
    private val a = DisplayWire.hash(jpegA)
    private val b = DisplayWire.hash(jpegB)
    private fun whole(jpeg: ByteArray) = Poster(DisplayWire.hash(jpeg), java.util.Base64.getEncoder().encodeToString(jpeg))

    private val sale = Picture(Picture.SALE, "Sale", listOf(PicLine("1", "Cola", amount = 5000)), total = 5000, business = "Star Grill", message = "Hello")
    private val logo = "data:image/png;base64,AAAA"

    private fun ask(
        picture: Picture = sale, till: String = "t-1", with: String = code, v: Int = DisplayWire.VERSION, logo: String? = null,
        posters: List<String> = emptyList(), poster: Poster? = null,
    ): DisplayReply = runBlocking {
        val out = DisplayWire.encode(DisplayRequest(v = v, till = till, tillName = "Till $till", display = "Counter", picture = picture, logo = logo, posters = posters, poster = poster), with)
        val (first, second) = out.trimEnd('\n').split('\n')
        DisplayWire.decodeReply(book.answer(first, second).trimEnd('\n'))!!
    }

    @Test
    fun nothingHeardYetIsThePairingPage() {
        assertNull(book.shown())
    }

    @Test
    fun aWrongCodeIsRefusedAndNothingIsKept() {
        val r = ask(with = "KTCHN234")
        assertFalse(r.ok)
        assertEquals(DisplayWire.REFUSED, r.error)
        assertNull(book.shown())
    }

    @Test
    fun anotherVersionIsRefusedWithTheBuild() {
        val r = ask(v = 2)
        assertFalse(r.ok)
        assertEquals(DisplayWire.OTHER_VERSION, r.error)
        assertEquals(33, r.build)
        assertNull(book.shown())
    }

    @Test
    fun thePictureIsShownUntilTheTillGoesQuiet() {
        assertTrue(ask().ok)
        assertEquals(sale, book.shown())
        now += DisplayBook.SILENT_MS - 1
        assertEquals(sale, book.shown())
        now += 1
        // the business stays on the screen, the order does not
        assertEquals(Pictures.idleOf(sale), book.shown())
        assertEquals("Star Grill", book.shown()!!.business)
    }

    @Test
    fun theLatestPictureWinsWhicheverTillSentIt() {
        ask()
        val other = sale.copy(title = "Takeaway A-2")
        ask(other, till = "t-2")
        assertEquals(other, book.shown())
        assertEquals("t-2", book.held.value!!.till)
    }

    @Test
    fun aLogoIsKeptByItsHashUntilAnotherIsSent() {
        val r = ask(logo = logo)
        assertEquals(DisplayWire.hash(logo), r.logoHash)
        assertEquals(logo, book.logo.value)
        assertEquals(listOf(logo to DisplayWire.hash(logo)), kept)
        // a request with no logo leaves the one held, and it is not written again
        val again = ask()
        assertEquals(DisplayWire.hash(logo), again.logoHash)
        assertEquals(logo, book.logo.value)
        ask(logo = logo)
        assertEquals(1, kept.size)
        // "" is a business that has none now
        val none = ask(logo = "")
        assertEquals("", none.logoHash)
        assertNull(book.logo.value)
        assertEquals(null to "", kept.last())
    }

    @Test
    fun aLogoKeptOnTheTabletComesBackAfterARestart() {
        book.restore(logo)
        assertEquals(DisplayWire.hash(logo), ask().logoHash)
        assertEquals(logo, book.logo.value)
    }

    @Test
    fun forgetLeavesNothing() {
        ask(logo = logo)
        runBlocking { book.forget() }
        assertNull(book.shown())
        assertNull(book.logo.value)
        assertEquals("", ask().logoHash)
    }

    // The pictures shown in turn: told of by hash, sent whole one at a time,
    // kept only when they are what their hash says, and in the till's order.
    @Test
    fun picturesArriveOneAtATimeAndInTheTillsOrder() {
        var r = ask(posters = listOf(a, b))
        assertEquals(emptyList<String>(), r.posters)
        r = ask(posters = listOf(a, b), poster = whole(jpegB))
        assertEquals(listOf(b), r.posters)
        r = ask(posters = listOf(a, b), poster = whole(jpegA))
        assertEquals(listOf(a, b), r.posters)
        assertEquals(listOf(a, b), book.posters.value)
    }

    @Test
    fun aPictureThatIsNotWhatItsHashSaysIsNotKept() {
        val r = ask(posters = listOf(a), poster = Poster(a, java.util.Base64.getEncoder().encodeToString(jpegB)))
        assertEquals(emptyList<String>(), r.posters)
        // nor one the till did not name
        assertEquals(emptyList<String>(), ask(posters = listOf(a), poster = whole(jpegB)).posters)
    }

    @Test
    fun aPictureTakenOffOnTheTillGoesFromTheDisplay() {
        ask(posters = listOf(a, b), poster = whole(jpegA))
        ask(posters = listOf(a, b), poster = whole(jpegB))
        val r = ask(posters = listOf(b))
        assertEquals(listOf(b), r.posters)
        assertEquals(setOf(b), shelf.held.keys)
        // a till that sends none (one built before them): none shown
        ask()
        assertEquals(emptyList<String>(), book.posters.value)
    }
}
