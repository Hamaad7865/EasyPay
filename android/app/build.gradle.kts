plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

android {
    namespace = "com.restopos.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.restopos.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // Phase 1: endpoints come from local.properties (never committed):
        //   functionUrl=https://br-...-api.compute.....neon.tech/
        //   authUrl=https://ep-....neonauth.....neon.tech
        buildConfigField("String", "FUNCTION_URL", "\"${project.findProperty("functionUrl") ?: ""}\"")
        buildConfigField("String", "AUTH_URL", "\"${project.findProperty("authUrl") ?: ""}\"")
    }
    buildFeatures { buildConfig = true; compose = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.15" }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.0")
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.work)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    implementation(libs.room.paging)
    ksp(libs.room.compiler)
    implementation(libs.datastore.preferences)
    implementation(libs.kotlinx.serialization)
    implementation(libs.ktor.client)
    implementation(libs.ktor.serialization)
    implementation(libs.ktor.serialization.json)
    implementation(libs.ktor.cookies)
    implementation(libs.workmanager)
    implementation(libs.paging.runtime)
    implementation(libs.paging.compose)
    implementation(libs.coil.compose)
}
