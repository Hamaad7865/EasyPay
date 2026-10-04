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
import com.restopos.feature.sync.RejectedScreen

// Launch modes (spec 7/8): POS and KDS share this APK, chosen at device setup.
// KDS screen lands in Phase 6; the route constant reserves it.
object Routes {
    const val AUTH = "auth"
    const val DEVICE = "device"
    const val SALE = "sale"
    const val PAY = "pay"
    const val DONE = "done/{receiptId}/{change}/{total}"
    const val REAUTH = "reauth"
    const val REJECTED = "rejected"
    const val KDS = "kds"
}

@Composable
fun AppNav(session: SessionStore, onSignOut: () -> Unit) {
    val nav = rememberNavController()
    val context = LocalContext.current
    // A tablet that has been set up opens on the menu, with or without a
    // network: the menu is in Room. Sign-in is only the first-run path.
    val start by produceState<String?>(initialValue = null) {
        value = if (session.isSetUp()) Routes.SALE else Routes.AUTH
    }
    val startRoute = start ?: return
    LaunchedEffect(startRoute) {
        if (startRoute == Routes.SALE) SyncScheduler.startPeriodic(context)
    }
    NavHost(nav, startDestination = startRoute) {
        composable(Routes.AUTH) {
            val vm: AuthViewModel = hiltViewModel()
            AuthScreen(vm) { nav.navigate(Routes.DEVICE) { popUpTo(Routes.AUTH) { inclusive = true } } }
        }
        composable(Routes.DEVICE) {
            StoreDeviceScreen(onReady = {
                SyncScheduler.startPeriodic(context)
                nav.navigate(Routes.SALE) { popUpTo(Routes.DEVICE) { inclusive = true } }
            })
        }
        composable(Routes.SALE) {
            // Register, Orders, Receipts and Settings share this entry (tabs).
            MainShell(
                onPay = { nav.navigate(Routes.PAY) },
                onPaid = { id, change, total -> nav.navigate("done/$id/$change/$total") },
                onSignIn = { nav.navigate(Routes.REAUTH) },
                onRejected = { nav.navigate(Routes.REJECTED) },
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
