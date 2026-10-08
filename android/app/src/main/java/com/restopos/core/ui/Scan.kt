package com.restopos.core.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Scanner
import kotlinx.coroutines.delay

// Scan mode, on every screen of a shop's till that takes a scanner, after the
// Kids Corner till's: one switch for all of them. Lit, the search box gives
// way to a strip that says what the last scan did, and the scanner's keys are
// taken below the screen (MainActivity), so no field has the focus and the
// keyboard never comes up. To search by name, the key is tapped off again.

// a scanner's frame with a barcode in it
private const val FRAME = "M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 9v6M11 9v6M13.500 9v6M16 9v6"

// The scan-mode key. Turning it on also lets go of whatever field had the
// focus and puts the keyboard away.
@Composable
fun ScanKey(on: Boolean, size: Dp = 56.dp, onToggle: (Boolean) -> Unit) {
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    Box(
        Modifier.size(size).press {
            if (!on) { focus.clearFocus(force = true); keyboard?.hide() }
            Scanner.wedge.reset()
            onToggle(!on)
        }.clip(RoundedCornerShape(12.dp)).background(if (on) V.Blue else V.Panel).border(1.dp, if (on) V.Blue else V.Stroke, RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center,
    ) { VIcon(FRAME, 24.dp, if (on) Color.White else V.Text) }
}

// What the search box becomes in scan mode: never a box to type in. It says
// the till is ready, then what the last scan did, then that it is ready again.
@Composable
fun ScanPill(modifier: Modifier = Modifier, height: Dp = 56.dp, idle: String = "Scan mode · ready") {
    val said by Scanner.said.collectAsState()
    LaunchedEffect(said) {
        val s = said ?: return@LaunchedEffect
        delay(if (s.ok) 1600 else 2400)
        if (Scanner.said.value === s) Scanner.said.value = null
    }
    val bad = said?.ok == false
    Row(
        modifier.height(height).clip(RoundedCornerShape(12.dp)).background(if (bad) V.RedWash else V.Panel)
            .border(1.dp, if (bad) V.Red else V.Stroke, RoundedCornerShape(12.dp)).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(if (bad) V.Red else V.Green))
        T(said?.text ?: idle, 15.sp, 600, if (bad) V.RedText else V.Text)
    }
}
