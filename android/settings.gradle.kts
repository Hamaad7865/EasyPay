// RestoPOS till: Kotlin + Compose, min SDK 26. One :app module for now; the
// module split in spec section 3 comes when the code is big enough to need it.
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google(); mavenCentral()
        // The USB-serial drivers of a customer pole display (usb-serial-for-android) are published
        // on JitPack only; taken from there and nothing else (the owner's choice, 2026-10-21).
        maven("https://jitpack.io") { content { includeGroup("com.github.mik3y") } }
    }
}
rootProject.name = "RestoPOS"
include(":app")
