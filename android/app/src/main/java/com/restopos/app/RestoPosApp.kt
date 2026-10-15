package com.restopos.app

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.restopos.core.print.Printing
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject
import kotlinx.coroutines.launch

// Launch modes (spec 7/8): POS and KDS share this APK.
// Mode is chosen at device setup and stored in DataStore; MainActivity routes.
@HiltAndroidApp
class RestoPosApp : Application(), Configuration.Provider {
    @Inject lateinit var workerFactory: HiltWorkerFactory
    @Inject lateinit var printing: Printing
    @Inject lateinit var dueReminders: com.restopos.core.data.DueReminders

    override fun onCreate() {
        // A backup picked at the first screen is moved into place here, before
        // anything has opened the database or the tablet's own settings.
        com.restopos.core.data.Backup.applyWaiting(this)
        super.onCreate()
        // before anything else can go wrong: a crash is written down for the next sync to send
        com.restopos.core.common.Crashes.install(this)
        // how many decimals amounts are shown with, before the first screen draws them;
        // and whether this tablet works on its own, which its sentences say (Journey)
        printing.scope.launch { runCatching { com.restopos.core.data.Journey.alone = printing.settings().alone } }
        // The reminder before an order for later is due rings from the moment
        // the app is up: after a restart the till waits on its start screen,
        // with nobody signed in, and must still ring (DueReminders).
        dueReminders.start()
    }
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setWorkerFactory(workerFactory).build()
}
