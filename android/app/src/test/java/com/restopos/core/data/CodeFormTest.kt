package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The box a tablet's code is typed into.
class CodeFormTest {
    @Test fun the_code_itself_is_its_capitals_and_digits() {
        assertEquals("ABCDEFGHJKMN", CodeForm.plain(" abcd-efgh jkmn "))
        assertEquals("", CodeForm.plain(" - "))
    }

    @Test fun typed_any_way_it_reads_in_three_groups_of_four() {
        assertEquals("ABCD-EFGH-JKMN", CodeForm.typed("abcdefghjkmn"))
        assertEquals("ABCD-EFGH-JKMN", CodeForm.typed(" abcd efgh-jkmn "))
        assertEquals("ABCD-EFGH-JKMN", CodeForm.typed("ABCD-EFGH-JKMN"))
        // as it is being typed: the dash comes with the fifth character, never before it
        assertEquals("", CodeForm.typed(""))
        assertEquals("ABCD", CodeForm.typed("abcd"))
        assertEquals("ABCD", CodeForm.typed("ABCD-"))
        assertEquals("ABCD-E", CodeForm.typed("abcde"))
        assertEquals("ABCD-EFGH-2", CodeForm.typed("abcdefgh2"))
    }

    @Test fun no_more_than_a_code_holds_and_nothing_that_is_not_in_one() {
        assertEquals("ABCD-EFGH-JKMN", CodeForm.typed("abcdefghjkmnpqrs"))
        assertEquals("AB12", CodeForm.typed("a.b/1_2"))
    }

    @Test fun ready_when_all_twelve_are_there() {
        assertFalse(CodeForm.ready(""))
        assertFalse(CodeForm.ready("ABCD-EFGH-JKM"))
        assertTrue(CodeForm.ready("ABCD-EFGH-JKMN"))
        assertTrue(CodeForm.ready("abcd efgh 2345"))
        // one too many is not a code, though its first twelve would read as one
        assertFalse(CodeForm.ready("abcdefghjkmnp"))
    }
}
