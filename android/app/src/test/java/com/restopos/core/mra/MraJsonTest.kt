package com.restopos.core.mra

import org.junit.Assert.assertEquals
import org.junit.Test

class MraJsonTest {
    @Test fun keysKeepTheirOrderAndNothingIsSpaced() {
        val j = MraJson.obj("b" to "1", "a" to MraJson.arr(listOf(MraJson.obj("x" to ""))))
        assertEquals("""{"b":"1","a":[{"x":""}]}""", MraJson.encode(j))
    }

    // JSON.stringify: " and \ escaped, \b \f \n \r \t by name, other controls as \u00xx, the rest as it is
    @Test fun stringsAreEscapedAsJavaScriptEscapesThem() {
        assertEquals("\"a\\\"b\\\\c\\n\\t\\b\\f\\r\\u0001\\u001fé€/\"", MraJson.encode(MraJson.Str("a\"b\\c\n\t\b\u000C\r\u0001\u001Fé€/")))
    }

    // a surrogate pair stays as it is; one on its own is written as \udxxx, as JSON.stringify does
    @Test fun surrogates() {
        assertEquals("\"\uD83D\uDE00\"", MraJson.encode(MraJson.Str("\uD83D\uDE00")))
        assertEquals("\"\\ud83d\"", MraJson.encode(MraJson.Str("\uD83D")))
        assertEquals("\"\\ude00x\"", MraJson.encode(MraJson.Str("\uDE00x")))
    }

    @Test fun anEmptyListAndObject() {
        assertEquals("""{"a":[],"b":{}}""", MraJson.encode(MraJson.obj("a" to MraJson.arr(emptyList()), "b" to MraJson.obj())))
    }
}
