package com.restopos.core.print

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.util.Base64
import com.restopos.core.common.Money
import com.restopos.core.data.PosSettings
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.net.Socket
import javax.inject.Inject
import javax.inject.Singleton

// The tablet prints by itself: over the local network to a printer's IP
// address, or down a USB cable. Nothing goes through the internet, so
// printing works while the tablet is offline.
@Singleton
class Printing @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    @ApplicationContext private val context: Context,
) {
    // Printing that follows a payment runs here, so the till never waits on a
    // printer; what goes wrong is shown on the screen.
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _problems = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val problems: SharedFlow<String> = _problems
    fun report(message: String) { _problems.tryEmit(message) }

    suspend fun settings(): PosSettings = PosSettings.parse(db.ops().settings()).also { Money.decimals = it.decimals }

    suspend fun printers(): List<PrinterEntity> = session.storeId()?.let { db.ops().printers(it) } ?: emptyList()

    suspend fun receiptPrinter(): PrinterEntity? = printers().firstOrNull { it.is_receipt }

    fun paper(p: PrinterEntity) = Paper(EscPos.columnsFor(p.paper_mm), p.feed_lines, p.cut)

    suspend fun shop(): Shop = settings().shop(session.businessName() ?: "")

    // Sends the bytes and says, in words a cashier can act on, why it could not.
    suspend fun send(p: PrinterEntity, bytes: ByteArray): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            if (p.kind == "usb") usb(bytes) else tcp(p, bytes)
        }.recoverCatching { e ->
            throw PrintError(
                when (e) {
                    is PrintError -> e.message ?: "${p.name} did not print"
                    is java.net.SocketTimeoutException, is java.net.ConnectException, is java.net.NoRouteToHostException ->
                        "${p.name} is not answering at ${p.address}. Check that it is on and on the same network."
                    else -> "${p.name} did not print: ${e.message ?: e.javaClass.simpleName}"
                },
            )
        }
    }

    private fun tcp(p: PrinterEntity, bytes: ByteArray) {
        val address = p.address?.trim().orEmpty()
        if (address.isEmpty()) throw PrintError("${p.name} has no IP address. Set it in the back office, under Printers.")
        val host = address.substringBefore(':')
        val port = address.substringAfter(':', "9100").toIntOrNull() ?: 9100
        Socket().use { s ->
            s.connect(InetSocketAddress(host, port), 3000)
            s.soTimeout = 5000
            s.getOutputStream().apply { write(bytes); flush() }
            // some printers drop what is still in their buffer if the line closes at once
            Thread.sleep(150)
        }
    }

    private fun usb(bytes: ByteArray) {
        val manager = context.getSystemService(Context.USB_SERVICE) as? UsbManager ?: throw PrintError("This tablet has no USB port for a printer.")
        val device = manager.deviceList.values.firstOrNull { printerInterface(it) != null }
            ?: throw PrintError("No USB printer is plugged into this tablet.")
        if (!manager.hasPermission(device)) {
            val ask = PendingIntent.getBroadcast(
                context, 0, Intent(USB_PERMISSION).setPackage(context.packageName),
                if (android.os.Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0,
            )
            manager.requestPermission(device, ask)
            throw PrintError("Allow RestoPOS to use the USB printer (the tablet is asking now), then print again.")
        }
        val (iface, out) = printerInterface(device) ?: throw PrintError("That USB device is not a printer.")
        val conn = manager.openDevice(device) ?: throw PrintError("The USB printer could not be opened. Unplug it and plug it in again.")
        try {
            if (!conn.claimInterface(iface, true)) throw PrintError("The USB printer is busy. Try again.")
            var off = 0
            while (off < bytes.size) {
                val n = minOf(4096, bytes.size - off)
                val sent = conn.bulkTransfer(out, bytes, off, n, 5000)
                if (sent <= 0) throw PrintError("The USB printer stopped answering. Check its paper and cable.")
                off += sent
            }
            conn.releaseInterface(iface)
        } finally {
            conn.close()
        }
    }

    // a printer is USB class 7; the endpoint that takes data is the bulk OUT one
    private fun printerInterface(d: UsbDevice) =
        (0 until d.interfaceCount).map { d.getInterface(it) }.firstNotNullOfOrNull { i ->
            if (i.interfaceClass != UsbConstants.USB_CLASS_PRINTER) return@firstNotNullOfOrNull null
            (0 until i.endpointCount).map { i.getEndpoint(it) }
                .firstOrNull { it.type == UsbConstants.USB_ENDPOINT_XFER_BULK && it.direction == UsbConstants.USB_DIR_OUT }
                ?.let { i to it }
        }

    // The logo, scaled to the paper and turned into black and white dots.
    // Worked out once per logo and width.
    private var logoKey: String? = null
    private var logoRaster: Raster? = null
    fun logo(s: PosSettings, p: PrinterEntity): Raster? {
        if (!s.showLogo || s.logo == null) return null
        val max = EscPos.dotsFor(p.paper_mm) * 6 / 10
        val key = "${s.logo.hashCode()}:$max"
        if (key == logoKey) return logoRaster
        val made = runCatching {
            val raw = Base64.decode(s.logo.substringAfter("base64,"), Base64.DEFAULT)
            val src = BitmapFactory.decodeByteArray(raw, 0, raw.size) ?: return@runCatching null
            val scale = minOf(1f, max.toFloat() / src.width)
            val w = (src.width * scale).toInt().coerceAtLeast(8)
            val h = (src.height * scale).toInt().coerceAtLeast(8)
            val bmp = Bitmap.createScaledBitmap(src, w, h, true)
            val widthBytes = (w + 7) / 8
            val bits = ByteArray(widthBytes * h)
            for (y in 0 until h) for (x in 0 until w) {
                val c = bmp.getPixel(x, y)
                val alpha = Color.alpha(c) / 255f
                // see-through counts as white paper
                val lum = (0.299f * Color.red(c) + 0.587f * Color.green(c) + 0.114f * Color.blue(c)) * alpha + 255f * (1 - alpha)
                if (lum < 140f) bits[y * widthBytes + x / 8] = (bits[y * widthBytes + x / 8].toInt() or (0x80 shr (x % 8))).toByte()
            }
            Raster(widthBytes, h, bits)
        }.getOrNull()
        logoKey = key
        logoRaster = made
        return made
    }

    companion object {
        const val USB_PERMISSION = "com.restopos.USB_PERMISSION"
    }
}

class PrintError(message: String) : Exception(message)
