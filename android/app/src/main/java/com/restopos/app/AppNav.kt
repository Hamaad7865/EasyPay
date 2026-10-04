package com.restopos.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.platform.LocalContext
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.SyncScheduler
import com.restopos.feature.auth.AuthScreen
import com.restopos.feature.auth.AuthViewModel
import com.restopos.feature.auth.StoreDeviceScreen
import com.restopos.feature.pay.PaymentScreen
import com.restopos.feature.pay.ReceiptDoneScreen
import com.restopos.feature.main.MainShell
import com.restopos.feature.staff.CashCountScreen
import com.restopos.feature.staff.ClockScreen
import com.restopos.feature.start.StartScreen
import com.restopos.feature.sync.RejectedScreen

// Launch modes (spec 7/8): POS and KDS share this APK, chosen at device setup.
// KDS screen lands in Phase 6; the route constant reserves it.
object Routes {
    const val AUTH = "auth"
    const val DEVICE = "device"
    const val START = "start"
    const val CLOCK = "clock"
    const val CASH_OPEN = "cash-open"
    const val CASH_CLOSE = "cash-close"
    const val SALE = "sale"
    const val PAY = "pay"
    const val DONE = "done/{receiptId}/{change}/{total}"
    const val REAUTH = "reauth"
    const val REJECTED = "rejected"
    const val KDS = "kds"
}

@Composable
fun AppNav(session: SessionStore, signedIn: () -> Boolean, onSignOut: () -> Unit) {
    val nav = rememberNavController()
    val context = LocalContext.current
    // A tablet that has been set up opens on the start screen, with or
    // without a network: everything it shows is on the tablet. Sign-in is only
    // the first-run path.
    val start by produceState<String?>(initialValue = null) {
        value = if (session.isSetUp()) Routes.START else Routes.AUTH
    }
    val startRoute = start ?: return
    LaunchedEffect(startRoute) {
        if (startRoute == Routes.START) SyncScheduler.startPeriodic(context)
    }
    // Who is at the register is kept in memory only. If Android killed the
    // app in the background and brings back the screen that was open (the
    // register, the pay screen, a cash count), nobody is signed in to it any
    // more: go back to the start screen rather than let it be used unsigned.
    LaunchedEffect(Unit) {
        val at = nav.currentDestination?.route
        if (startRoute == Routes.START && !signedIn() && at != null &&
            at !in setOf(Routes.START, Routes.CLOCK, Routes.REAUTH)
        ) {
            nav.navigate(Routes.START) { popUpTo(0) { inclusive = true } }
        }
    }
    NavHost(nav, startDestination = startRoute) {
        composable(Routes.AUTH) {
            val vm: AuthViewModel = hiltViewModel()
            AuthScreen(vm) { nav.navigate(Routes.DEVICE) { popUpTo(Routes.AUTH) { inclusive = true } } }
        }
        composable(Routes.DEVICE) {
            StoreDeviceScreen(onReady = {
                SyncScheduler.startPeriodic(context)
                nav.navigate(Routes.START) { popUpTo(Routes.DEVICE) { inclusive = true } }
            })
        }
        // The register sits on top of the start screen: Lock (or Back) returns here.
        composable(Routes.START) {
            StartScreen(
                onOpen = { nav.navigate(Routes.SALE) { launchSingleTop = true } },
                onClock = { nav.navigate(Routes.CLOCK) },
                onCashCount = { nav.navigate(Routes.CASH_OPEN) },
                onSignIn = { nav.navigate(Routes.REAUTH) },
            )
        }
        composable(Routes.CLOCK) {
            ClockScreen(onBack = { nav.popBackStack() })
        }
        // Opening a sales period: confirm the drawer, then on to the register.
        composable(Routes.CASH_OPEN) {
            CashCountScreen(
                closing = false,
                onBack = { nav.popBackStack() },
                onDone = { nav.navigate(Routes.SALE) { popUpTo(Routes.START) } },
            )
        }
        // Closing it: count, see the result, and back to the start screen.
        composable(Routes.CASH_CLOSE) {
            CashCountScreen(
                closing = true,
                onBack = { nav.popBackStack() },
                onDone = { nav.popBackStack(Routes.START, inclusive = false) },
            )
        }
        composable(Routes.SALE) {
            // Register, Orders, Receipts and Settings share this entry (tabs).
            MainShell(
                onPay = { nav.navigate(Routes.PAY) },
                onPaid = { id, change, total -> nav.navigate("done/$id/$change/$total") },
                onSignIn = { nav.navigate(Routes.REAUTH) },
                onRejected = { nav.navigate(Routes.REJECTED) },
                onLock = { nav.popBackStack(Routes.START, inclusive = false) },
                onClosePeriod = { nav.navigate(Routes.CASH_CLOSE) },
                onSignOut = onSignOut,
            )
        }
        composable(Routes.PAY) {
            PaymentScreen(
                onDone = { id, change, total -> nav.navigate("done/$id/$change/$total") {
                    popUpTo(Routes.SALE) { inclusive = false }
                } },
                onBack = { nav.popBackStack() },
            )
        }
        composable(Routes.DONE) { back ->
            ReceiptDoneScreen(
                change = back.arguments?.getString("change")?.toLongOrNull() ?: 0,
                total = back.arguments?.getString("total")?.toLongOrNull() ?: 0,
                onPrint = {},
                onNewSale = { nav.navigate(Routes.SALE) { popUpTo(Routes.SALE) { inclusive = true } } },
            )
        }
        // Signing in again on a tablet that is already set up: back to the
        // till afterwards, with its orders and unsynced sales untouched.
        composable(Routes.REAUTH) {
            AuthScreen(reauth = true, onCancel = { nav.popBackStack() }, onSignedIn = { nav.popBackStack() })
        }
        composable(Routes.REJECTED) {
            RejectedScreen(onBack = { nav.popBackStack() })
        }
    }
}
