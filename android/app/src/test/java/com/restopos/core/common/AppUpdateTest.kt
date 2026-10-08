package com.restopos.core.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The key by the clock asks the server for the newest build of the till.
// These are the rules for what it then offers to install.
class AppUpdateTest {
    private val four = TillRelease(4, "0.4.0", "https://downloads.example/easypay-0.4.0.apk")

    @Test
    fun aNewerBuildIsOffered() {
        assertEquals(four, AppUpdate.newer(3, four))
    }

    @Test
    fun theSameBuildOrAnOlderOneIsNot() {
        assertNull(AppUpdate.newer(4, four))
        assertNull(AppUpdate.newer(5, four))
    }

    @Test
    fun aServerThatNamesNoneOffersNone() {
        assertNull(AppUpdate.newer(3, null))
    }

    @Test
    fun onlyAnHttpsAddressIsFetched() {
        assertNull(AppUpdate.newer(3, four.copy(url = "http://downloads.example/easypay.apk")))
        assertNull(AppUpdate.newer(3, four.copy(url = "")))
        assertNull(AppUpdate.newer(3, four.copy(url = "https://")))
        assertNull(AppUpdate.newer(3, four.copy(url = "file:///sdcard/easypay.apk")))
        assertEquals(four.copy(url = "HTTPS://downloads.example/a.apk"), AppUpdate.newer(3, four.copy(url = "HTTPS://downloads.example/a.apk")))
    }
}
