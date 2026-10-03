// RestoPOS till: Kotlin + Compose, min SDK 26. One :app module for now; the
// module split in spec section 3 comes when the code is big enough to need it.
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "RestoPOS"
include(":app")
