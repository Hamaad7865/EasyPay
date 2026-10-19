package com.restopos.core.print

import org.junit.Assert.assertEquals
import org.junit.Test

// Each line is kept with the style the printer had when it ended: what the
// back office's preview is held to.
class EscPosStyledTest {
    @Test
    fun `each line keeps its size, bold and alignment, and bars are a line of their own`() {
        val p = EscPos(32)
        p.align(EscPos.Align.Center).bold(true).line("A").big(true).line("B").big(false)
        p.tall(true).row("x", "1").tall(false).bold(false).align(EscPos.Align.Left)
        p.barcode("S1")
        p.feed(3)
        assertEquals(
            listOf(
                Styled("A", "normal", true, "center"),
                Styled("B", "big", true, "center"),
                Styled("x" + " ".repeat(30) + "1", "tall", true, "center"),
                Styled("", "normal", false, "center", bars = "S1"),
                Styled("S1", "normal", false, "center"),
            ),
            p.styled(),
        )
    }

    // Words never carry a printer's command: a control byte in a text (a note
    // typed anywhere) prints as a space, so ESC p, which opens the drawer,
    // cannot be printed from a note.
    @Test
    fun `a control byte in a text prints as a space`() {
        val bytes = EscPos(32).text("a\u001Bp\u0000\u0019b\u007F").bytes()
        val printed = bytes.drop(bytes.size - 7)
        assertEquals(listOf<Byte>(0x61, 0x20, 0x70, 0x20, 0x20, 0x62, 0x20), printed)
    }

    @Test
    fun `tall after big is tall alone, the printer having one register for size`() {
        val p = EscPos(32)
        p.big(true).tall(true).line("T").tall(false).line("N")
        assertEquals(listOf("tall", "normal"), p.styled().map { it.size })
    }
}
