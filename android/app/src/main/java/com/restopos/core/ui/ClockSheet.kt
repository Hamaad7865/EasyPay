package com.restopos.core.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TimePickerDefaults
import androidx.compose.material3.TimePickerLayoutType
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import java.util.Calendar

// A clock face to choose a time of day on: the hand is turned to the hour,
// then to the minutes. The owner, of when a takeaway is picked up: "you can
// make it a clock and we turn its needles to select the time". It opens at
// `at` (a moment), or at the time it is now. What the time means (today, or
// tomorrow's small hours, and not already past) is the caller's rule (Pickup.at).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClockSheet(title: String, sub: String?, at: Long?, onDismiss: () -> Unit, onPick: (hour: Int, minute: Int) -> Unit) {
    val start = remember(at) { Calendar.getInstance().apply { if (at != null) timeInMillis = at } }
    val state = rememberTimePickerState(start.get(Calendar.HOUR_OF_DAY), start.get(Calendar.MINUTE), is24Hour = true)
    Sheet(onDismiss = onDismiss, width = 640.dp, gap = 16.dp) {
        SheetHead(title, sub, onDismiss)
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            TimePicker(
                state,
                colors = TimePickerDefaults.colors(
                    clockDialColor = V.Well, selectorColor = V.Blue, containerColor = V.Panel,
                    clockDialSelectedContentColor = Color.White, clockDialUnselectedContentColor = V.Text,
                    timeSelectorSelectedContainerColor = V.BlueWash, timeSelectorUnselectedContainerColor = V.Well,
                    timeSelectorSelectedContentColor = V.BlueSoft, timeSelectorUnselectedContentColor = V.Text,
                ),
                // the hour and the minutes beside the face, not above it: a 10-inch tablet is not tall
                layoutType = TimePickerLayoutType.Horizontal,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Cancel", Modifier.weight(1f), height = 56.dp, onClick = onDismiss)
            VBtn(
                "Set ${state.hour.toString().padStart(2, '0')}:${state.minute.toString().padStart(2, '0')}",
                Modifier.weight(1f), V.Blue, Color.White, 56.dp, weight = 800,
            ) { onPick(state.hour, state.minute) }
        }
    }
}
