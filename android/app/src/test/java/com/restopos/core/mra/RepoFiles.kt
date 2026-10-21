package com.restopos.core.mra

import java.io.File

// A file of the repository (mra/fixtures/...), found from wherever Gradle runs
// the tests, as GuestTest finds the relay's menu.
internal fun repoFile(path: String): File {
    var dir: File? = File("").absoluteFile
    while (dir != null) {
        val f = File(dir, path)
        if (f.exists()) return f
        dir = dir.parentFile
    }
    error("$path is not above ${File("").absolutePath}")
}

// The folder of what the MRA's sandbox answered, on the owner's computer only
// (.claude/mra is kept out of git), or null.
internal fun sandboxOut(): File? {
    var dir: File? = File("").absoluteFile
    while (dir != null) {
        val f = File(dir, ".claude/mra/out")
        if (f.isDirectory) return f
        dir = dir.parentFile
    }
    return null
}
