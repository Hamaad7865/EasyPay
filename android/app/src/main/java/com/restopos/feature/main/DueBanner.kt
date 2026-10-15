package com.restopos.feature.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn

private val Ink = Color(0xFF241800)

// The reminder before an order for later is due (DueReminders): a band under
// the top bar of whichever screen is open (the bar's keys stay free), one for
// each order, until OK is pressed or the order is ready. Tapping it opens the
// Takeaway board.
@Composable
internal fun BoxScope.DueBannerHost(shell: ShellViewModel, onOpen: () -> Unit) {
    val banners by shell.dueBanners.collectAsState()
    if (banners.isEmpty()) return
    Column(
        // the top bar is 64 dp (MainShell)
        Modifier.align(Alignment.TopCenter).padding(top = 72.dp, start = 40.dp, end = 40.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        banners.forEach { b ->
            Row(
                Modifier.widthIn(max = 760.dp).shadow(12.dp, RoundedCornerShape(14.dp)).clip(RoundedCornerShape(14.dp)).background(V.Amber)
                    .clickable(onClick = onOpen).padding(start = 20.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                T(b.text, 16.sp, 800, Ink, Modifier.weight(1f, fill = false).padding(end = 14.dp), lines = 2)
                VBtn("OK", bg = Ink, fg = V.Amber, height = 44.dp, radius = 10.dp, weight = 800) { shell.dueOk(b.ticketId) }
            }
        }
    }
}
