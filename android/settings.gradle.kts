# Android — Phase 0 skeleton (Kotlin + Compose, Min SDK 26)
# Full modules per spec section 3 land in Phase 1+. Not built here (needs Android SDK + JDK).

pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "RestoPOS"
include(":app")
