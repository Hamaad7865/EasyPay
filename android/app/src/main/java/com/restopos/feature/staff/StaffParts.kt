package com.restopos.feature.staff

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.restopos.core.data.StaffMember
import com.restopos.core.ui.Pos
import com.restopos.core.ui.PosIcons
import kotlinx.coroutines.launch

// The bar across the top of the staff screens: a way back on the left (when
// there is one) and the screen's name in the middle.
@Composable
fun StaffTopBar(title: String, onBack: (() -> Unit)? = null) {
    Box(Modifier.fillMaxWidth().height(52.dp).background(Brush.verticalGradient(listOf(Pos.BarTop, Pos.BarBottom)))) {
        if (onBack != null) {
            Text(
                "‹  Back", Modifier.align(Alignment.CenterStart).clickable(onClick = onBack).padding(horizontal = 16.dp, vertical = 14.dp),
                color = Pos.NavOn, fontSize = 15.sp, fontWeight = FontWeight.Medium,
            )
        }
        Text(title, Modifier.align(Alignment.Center), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
    }
}

// The coloured tag with someone's role, as on a name tile.
@Composable
fun RoleBadge(role: String?) {
    if (role == null) return
    val manager = role.equals("Owner", true) || role.equals("Manager", true)
    Text(
        role.uppercase(),
        Modifier.clip(RoundedCornerShape(3.dp)).background(if (manager) Color(0xFF8CC79A) else Color(0xFFD9A441)).padding(horizontal = 6.dp, vertical = 3.dp),
        color = if (manager) Color(0xFF10233D) else Color(0xFF3A2600), fontSize = 10.sp, fontWeight = FontWeight.Bold, maxLines = 1,
    )
}

private val PIN_TEXT = Color(0xFFF3F4F6)

// "Please enter your PIN code": four dots and a number pad over a dimmed
// screen. Checks itself on the fourth digit.
@Composable
fun PinPad(member: StaffMember, check: suspend (String) -> PinCheck, onOk: () -> Unit, onDismiss: () -> Unit) {
    var entered by remember { mutableStateOf("") }
    var note by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun press(key: String) {
        if (busy) return
        note = null
        entered = if (key == "back") entered.dropLast(1) else (entered + key).take(4)
        if (entered.length == 4) {
            busy = true
            scope.launch {
                when (val r = check(entered)) {
                    PinCheck.Ok -> onOk()
                    PinCheck.Wrong -> { note = "That PIN is not right."; entered = "" }
                    is PinCheck.Locked -> { note = "Too many wrong tries. Try again in ${r.seconds} seconds."; entered = "" }
                }
                busy = false
            }
        }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color(0xE6000000)), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Please enter your PIN code", color = PIN_TEXT, fontSize = 17.sp)
                Text(member.employee.name, Modifier.padding(top = 4.dp), color = PIN_TEXT.copy(alpha = 0.7f), fontSize = 14.sp)
                Row(Modifier.padding(top = 22.dp, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(22.dp)) {
                    repeat(4) { i ->
                        Box(Modifier.size(18.dp).clip(CircleShape).background(if (i < entered.length) PIN_TEXT else Color(0xFF55585F)))
                    }
                }
                Text(note ?: " ", Modifier.height(22.dp), color = Color(0xFFE2587A), fontSize = 13.sp, textAlign = TextAlign.Center)
                listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("", "0", "back")).forEach { row ->
                    Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        row.forEach { k ->
                            if (k.isEmpty()) Spacer(Modifier.size(76.dp))
                            else Box(
                                Modifier.size(76.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFF0C0D10))
                                    .border(1.dp, Color(0xFFB9BCC4), RoundedCornerShape(8.dp)).clickable { press(k) },
                                contentAlignment = Alignment.Center,
                            ) {
                                if (k == "back") Text("‹", color = PIN_TEXT, fontSize = 28.sp)
                                else Text(k, color = PIN_TEXT, fontSize = 24.sp)
                            }
                        }
                    }
                }
                Text("Cancel", Modifier.padding(top = 18.dp).clickable(onClick = onDismiss).padding(10.dp), color = Color(0xFF9FD4A8), fontSize = 15.sp)
            }
        }
    }
}

// A number pad for typing an amount of money (rupees, two decimals). With
// `fresh`, the amount showing was offered and not typed: the first digit
// replaces it, as on the cash drawer screen, and the delete key edits it.
@Composable
fun AmountPad(value: String, keyHeight: Dp, modifier: Modifier = Modifier, fresh: Boolean = false, onChange: (String) -> Unit) {
    fun press(key: String) {
        val from = if (fresh) "" else value
        onChange(
            when (key) {
                "C" -> ""
                "back" -> value.dropLast(1)
                "." -> if (from.contains('.')) from else if (from.isEmpty()) "0." else "$from."
                else -> {
                    var out = if (from == "0") "" else from
                    for (ch in key) {
                        val full = if (out.contains('.')) out.substringAfter('.').length >= 2 else out.length >= 7
                        if (!full && !(out.isEmpty() && ch == '0' && key.length > 1)) out += ch
                    }
                    out
                }
            },
        )
    }
    Column(modifier.background(Pos.Line), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        listOf(listOf("7", "8", "9"), listOf("4", "5", "6"), listOf("1", "2", "3"), listOf("00", "0", "."), listOf("C", "back")).forEach { row ->
            Row(Modifier.fillMaxWidth().height(keyHeight), horizontalArrangement = Arrangement.spacedBy(1.dp)) {
                row.forEach { k ->
                    Box(Modifier.weight(1f).fillMaxSize().background(Pos.Key).clickable { press(k) }, contentAlignment = Alignment.Center) {
                        when (k) {
                            "back" -> Icon(PosIcons.Backspace, contentDescription = "Delete last digit", tint = Pos.Text, modifier = Modifier.size(22.dp))
                            "C" -> Text("C", color = Pos.Pink, fontSize = 22.sp, fontWeight = FontWeight.Medium)
                            else -> Text(k, color = Pos.Text, fontSize = 22.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }
        }
    }
}

// A name with its role tag, as a row to tap.
@Composable
fun StaffRow(member: StaffMember, note: String?, enabled: Boolean, onTap: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(60.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Key)
            .clickable(enabled = enabled, onClick = onTap).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                member.employee.name, color = if (enabled) Pos.Text else Pos.Text3, fontSize = 16.sp, fontWeight = FontWeight.Bold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            if (note != null) Text(note, color = Pos.Text3, fontSize = 12.sp)
        }
        RoleBadge(member.role)
    }
}
