package com.restopos.core.sync

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

// Where a download of the till's own update has got to.
sealed interface Download {
    data object None : Download
    data object Running : Download
    data class Ready(val apk: Uri) : Download
    data object Failed : Download
}

// Fetches the till's own update and hands it to Android to install, after the
// Kids Corner till's. Android's DownloadManager does the fetching: it goes on
// when the till is put aside, and tries again by itself when the connection
// drops. The file lands in the app's own "Download" folder, which needs no
// permission, and a FileProvider (in the manifest, for that folder alone)
// makes it something the installer is allowed to open.
//
// Android installs it over this app only if it is signed with the same key,
// and asks the person at the till once to let EasyPay install updates.
@Singleton
class AppUpdater @Inject constructor(@ApplicationContext private val context: Context) {
    private val manager: DownloadManager? get() = context.getSystemService(DownloadManager::class.java)
    private var id: Long? = null
    private var version: Int? = null

    private val file: File get() = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), FILE)

    // Starts the download, unless this very build is already on its way or
    // already here. False when this tablet would not take it: said, never
    // thrown, since it is asked from a key someone has just tapped.
    //
    // The till says where the download has got to itself, so it is asked for
    // without a notification, which Android allows only an app that declares
    // DOWNLOAD_WITHOUT_NOTIFICATION (the manifest does). 0.5.0 to 0.6.0 did
    // not declare it: Android refused the request ("Invalid value for
    // visibility: 2"), nothing caught that, and tapping Download closed the
    // till. A tablet that still refuses is asked the ordinary way, with the
    // notification.
    fun start(versionCode: Int, url: String): Boolean {
        if (version == versionCode && id != null) return true
        val m = manager ?: return false
        return runCatching {
            file.delete() // what an earlier try left behind
            val request = { visibility: Int ->
                DownloadManager.Request(Uri.parse(url))
                    .setTitle("EasyPay update")
                    .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, FILE)
                    .setNotificationVisibility(visibility)
            }
            id = runCatching { m.enqueue(request(DownloadManager.Request.VISIBILITY_HIDDEN)) }
                .getOrElse { m.enqueue(request(DownloadManager.Request.VISIBILITY_VISIBLE)) }
            version = versionCode
            true
        }.getOrDefault(false)
    }

    fun poll(): Download {
        val at = id ?: return Download.None
        val m = manager ?: return Download.None
        m.query(DownloadManager.Query().setFilterById(at)).use { c ->
            if (!c.moveToFirst()) return Download.None
            return when (c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                DownloadManager.STATUS_SUCCESSFUL -> Download.Ready(FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file))
                DownloadManager.STATUS_FAILED -> {
                    // forgotten, so the next try starts afresh
                    id = null
                    version = null
                    Download.Failed
                }
                else -> Download.Running
            }
        }
    }

    // whether Android lets this app hand it an update to install
    fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

    // the tablet's own switch for it, "Allow from this source", asked for once
    fun allowIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    // Android's own "Update this app?" for the file that was fetched
    fun installIntent(apk: Uri): Intent =
        Intent(Intent.ACTION_VIEW).setDataAndType(apk, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)

    private companion object { const val FILE = "easypay-update.apk" }
}
