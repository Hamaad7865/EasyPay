package com.restopos.app

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

// Launch modes (spec 7/8): POS and KDS share this APK.
// Mode is chosen at device setup and stored in DataStore; MainActivity routes.
@HiltAndroidApp
class RestoPosApp : Application(), Configuration.Provider {
    @Inject lateinit var workerFactory: HiltWorkerFactory
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setWorkerFactory(workerFactory).build()
}
