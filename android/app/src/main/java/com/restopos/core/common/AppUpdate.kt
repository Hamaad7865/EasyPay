package com.restopos.core.common

// The newest build of the till the server knows of: its versionCode, the name
// people know it by ("0.4.0"), and where its APK is fetched from.
data class TillRelease(val version: Int, val name: String, val url: String)

object AppUpdate {
    // The release this till should offer to install: one newer than the build
    // that is running, with an https address to fetch it from. Anything else
    // (none, the same build, an older one, an address that is not https) is
    // no update. No Android in it, so it is tested without a tablet.
    fun newer(installed: Int, latest: TillRelease?): TillRelease? =
        latest?.takeIf { it.version > installed && it.url.trim().startsWith("https://", ignoreCase = true) && it.url.trim().length > "https://".length }
}
