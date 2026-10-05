package com.restopos.feature.auth

import com.restopos.core.network.AuthRefused
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.UnknownHostException

// The sign-in screen must always say why it did not sign in, in words a
// cashier can act on.
class AuthProblemTest {
    @Test
    fun aWrongEmailOrPasswordSaysSo() {
        val said = authProblem(AuthRefused(401, "Invalid email or password"), "Sign-in failed")
        assertEquals("That email and password do not match. Check both and try again.", said)
    }

    @Test
    fun tooManyTriesAsksToWait() {
        assertEquals("Too many tries. Wait a minute, then try again.", authProblem(AuthRefused(429, "Too many requests"), "Sign-in failed"))
    }

    @Test
    fun noInternetIsNotShownAsAHostName() {
        val said = authProblem(UnknownHostException("Unable to resolve host \"ep-example.neon.tech\""), "Sign-in failed")
        assertEquals("Cannot reach EasyPay. Check the tablet's internet connection and try again.", said)
    }

    @Test
    fun anythingElseKeepsTheServicesWordsOrTheFallback() {
        assertEquals("This login was switched off", authProblem(AuthRefused(403, "This login was switched off"), "Sign-in failed"))
        assertEquals("Sign-in failed", authProblem(IllegalStateException(""), "Sign-in failed"))
        assertEquals("Sign-in failed", authProblem(null, "Sign-in failed"))
    }
}
