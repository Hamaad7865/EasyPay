import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

// Endpoints live in android/local.properties (never committed):
//   functionUrl=https://br-...-api.compute.....neon.tech
//   authUrl=https://ep-....neonauth.....neon.tech/neondb/auth
// findProperty() does not read local.properties, so it is loaded here;
// -PfunctionUrl=... on the command line still wins.
val localProps = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun endpoint(key: String): String =
    ((project.findProperty(key) as String?) ?: localProps.getProperty(key) ?: "").trim()

android {
    namespace = "com.restopos.app"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.restopos.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "FUNCTION_URL", "\"${endpoint("functionUrl")}\"")
        buildConfigField("String", "AUTH_URL", "\"${endpoint("authUrl")}\"")
    }
    buildFeatures { buildConfig = true; compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { jvmToolchain(17) }

// Room writes its schema here; every later schema change ships a migration
// checked against these files (spec 15).
ksp { arg("room.schemaLocation", "$projectDir/schemas") }

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.core.ktx)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.navigation.compose)
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.work)
    ksp(libs.hilt.androidx.compiler)
    implementation(libs.hilt.navigation.compose)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    implementation(libs.room.paging)
    ksp(libs.room.compiler)
    implementation(libs.datastore.preferences)
    implementation(libs.kotlinx.serialization)
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.content.negotiation)
    implementation(libs.ktor.serialization.json)
    implementation(libs.workmanager)
    implementation(libs.paging.runtime)
    implementation(libs.paging.compose)
    testImplementation(libs.junit)
}
