package com.restopos.core.display

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbManager
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.restopos.core.sync.SessionStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton

// A 2-line customer pole display plugged into this tablet by USB: what the
// customer display shows, in 20 characters a line (PoleText), written to it
// through its USB-serial chip (usb-serial-for-android: Prolific, CH340,
// FTDI, CP210x and the plain USB kind). Switched on in Settings, Printers,
// with the kind of command it takes and its speed; this tablet's own.
//
// Never run on a real display before the owner's: written to the common
// command sets and tested on the bytes they send (PoleTextTest).
@Singleton
class PoleDisplay @Inject constructor(
    @ApplicationContext private val context: Context,
    private val session: SessionStore,
    private val feed: DisplayFeed,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private val turn = Mutex()
    private var port: UsbSerialPort? = null
    private var portName = ""
    private var opened: SessionStore.Pole? = null
    private var shown: ByteArray? = null
    private var asked = false
    // the test lines stay this long before the sale comes back
    @Volatile private var testUntil = 0L

    // In words for Settings, Printers: what it is doing, or what is wrong. Null while it is off.
    private val _status = MutableStateFlow<String?>(null)
    val status: StateFlow<String?> = _status

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            val picture = feed.live().stateIn(this, SharingStarted.Eagerly, null)
            while (isActive) {
                val pole = session.pole.first()
                if (!pole.on) {
                    turn.withLock { close() }
                    _status.value = null
                } else if (System.currentTimeMillis() >= testUntil) picture.value?.let { show(pole, PoleText.bytes(PoleText.lines(it), pole.commands)) }
                delay(400)
            }
        }
    }

    // Settings, Printers: two lines of test, and how it went in words.
    suspend fun test(): String {
        val pole = session.pole.first()
        testUntil = System.currentTimeMillis() + 4000
        show(pole, PoleText.bytes(PoleText.fit("EasyPay") to PoleText.fit("Pole display test"), pole.commands), again = true)
        return _status.value ?: "The pole display is switched off."
    }

    private suspend fun show(pole: SessionStore.Pole, bytes: ByteArray, again: Boolean = false) = turn.withLock {
        // set another way (another speed, other commands): opened afresh
        if (opened != null && opened != pole) close()
        if (!again && port != null && shown?.contentEquals(bytes) == true) return@withLock
        val p = port ?: open(pole) ?: return@withLock
        runCatching { p.write(bytes, 1000) }
            .onSuccess {
                shown = bytes
                _status.value = "Showing on $portName."
            }
            .onFailure {
                close()
                _status.value = "The pole display stopped answering. Check its cable; it is tried again by itself."
            }
    }

    private fun open(pole: SessionStore.Pole): UsbSerialPort? {
        val manager = context.getSystemService(Context.USB_SERVICE) as? UsbManager ?: run {
            _status.value = "This tablet has no USB port for a pole display."
            return null
        }
        val driver = UsbSerialProber.getDefaultProber().findAllDrivers(manager).firstOrNull() ?: run {
            _status.value = "No USB pole display is plugged into this tablet."
            asked = false
            return null
        }
        if (!manager.hasPermission(driver.device)) {
            // asked once while it stays plugged in: the tablet's question is not put again every second
            if (!asked) {
                asked = true
                val ask = PendingIntent.getBroadcast(
                    context, 1, Intent(PERMISSION).setPackage(context.packageName),
                    if (android.os.Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0,
                )
                manager.requestPermission(driver.device, ask)
            }
            _status.value = "Allow EasyPay to use the pole display: the tablet asks once it is plugged in."
            return null
        }
        val connection = manager.openDevice(driver.device) ?: run {
            _status.value = "The pole display could not be opened. Unplug it and plug it in again."
            return null
        }
        return runCatching {
            driver.ports.first().also { p ->
                p.open(connection)
                p.setParameters(pole.baud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            }
        }.onSuccess {
            port = it
            opened = pole
            portName = driver.device.productName?.takeIf { n -> n.isNotBlank() } ?: "the USB pole display"
        }.onFailure {
            runCatching { connection.close() }
            _status.value = "The pole display would not start: ${it.message ?: "no reason given"}."
        }.getOrNull()
    }

    private fun close() {
        runCatching { port?.close() }
        port = null
        opened = null
        shown = null
    }

    private companion object {
        const val PERMISSION = "com.restopos.app.USB_POLE_PERMISSION"
    }
}
