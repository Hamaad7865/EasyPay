package com.restopos.feature.auth

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.app.BuildConfig
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.Wordmark
import com.restopos.core.ui.press

// The pieces of the card a tablet is set up on. Sign-in, "Name this till" and
// the first-run set-up that follows them (feature/setup) are drawn with the
// same ones, so each reads as the next step of the one before.

// One card in the middle of the screen, on the till's own ground. With the
// keyboard up it scrolls, and the box being typed in stays in view.
@Composable
internal fun SetupCard(width: Dp = 520.dp, content: @Composable ColumnScope.() -> Unit) {
    Box(Modifier.fillMaxSize().background(V.Bg).systemBarsPadding().imePadding()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.widthIn(max = width).fillMaxWidth().clip(RoundedCornerShape(22.dp)).background(V.Panel).border(1.dp, V.Stroke, RoundedCornerShape(22.dp))
                    .padding(start = 30.dp, end = 30.dp, top = 28.dp, bottom = 26.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Wordmark()
                content()
            }
            T("EasyPay ${BuildConfig.VERSION_NAME}", 12.sp, 500, V.Text3)
        }
    }
}

@Composable
internal fun Heading(title: String, sub: String) {
    Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        T(title, 24.sp, 800, V.Text, spacing = (-0.5).sp)
        T(sub, 14.sp, 500, V.Text2, lines = 3, height = 20.sp)
    }
}

// what went wrong, on a wash of its own colour
@Composable
internal fun Problem(text: String) {
    T(
        text, 14.sp, 600, V.RedText,
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.RedWash).padding(horizontal = 14.dp, vertical = 11.dp),
        lines = 4, height = 20.sp,
    )
}

// A box to type in, with its name above it. The edge lights up in the logo's
// green while it is being typed in.
// lines: more than one makes it a box of that many lines (an address).
// requester: lets the screen put the cursor in it.
@Composable
internal fun SetupField(
    label: String, value: String, onChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier, enabled: Boolean = true,
    keyboard: KeyboardType = KeyboardType.Text, ime: ImeAction = ImeAction.Done, onIme: () -> Unit = {}, masked: Boolean = false,
    lines: Int = 1, requester: FocusRequester? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    var focused by remember { mutableStateOf(false) }
    val edge by animateColorAsState(if (focused) V.Cyan else V.Stroke, label = "edge")
    val one = lines <= 1
    Column(modifier, verticalArrangement = Arrangement.spacedBy(7.dp)) {
        T(label, 13.sp, 600, V.Text2)
        Row(
            Modifier.fillMaxWidth().then(if (one) Modifier.height(54.dp) else Modifier.heightIn(min = (30 + 22 * lines).dp)).clip(RoundedCornerShape(12.dp)).background(V.Well)
                .border(if (focused) 1.5.dp else 1.dp, edge, RoundedCornerShape(12.dp))
                .padding(start = 16.dp, end = if (trailing != null) 5.dp else 16.dp, top = if (one) 0.dp else 14.dp, bottom = if (one) 0.dp else 14.dp),
            verticalAlignment = if (one) Alignment.CenterVertically else Alignment.Top,
        ) {
            Box(Modifier.weight(1f), contentAlignment = if (one) Alignment.CenterStart else Alignment.TopStart) {
                if (value.isEmpty()) T(placeholder, 16.sp, 400, V.Off, lines = lines.coerceAtLeast(1))
                BasicTextField(
                    value, onChange,
                    Modifier.fillMaxWidth().then(if (requester != null) Modifier.focusRequester(requester) else Modifier).onFocusChanged { focused = it.isFocused },
                    enabled = enabled, singleLine = one, minLines = lines.coerceAtLeast(1), maxLines = if (one) 1 else lines + 2,
                    textStyle = TextStyle(color = V.Text, fontSize = 16.sp, fontWeight = FontWeight.Medium, lineHeight = 22.sp),
                    cursorBrush = SolidColor(V.Cyan),
                    visualTransformation = if (masked) PasswordVisualTransformation() else VisualTransformation.None,
                    // a box of several lines keeps the keyboard's own Enter for a new line
                    keyboardOptions = KeyboardOptions(keyboardType = keyboard, imeAction = if (one) ime else ImeAction.Default),
                    keyboardActions = KeyboardActions(onDone = { onIme() }),
                )
            }
            if (trailing != null) { Spacer(Modifier.size(4.dp)); trailing() }
        }
    }
}

// The card's one main key. Until it can be pressed it says what is missing,
// in place of a greyed-out word; while the till is at work it turns.
@Composable
internal fun MainKey(label: String, ready: Boolean, busy: Boolean, modifier: Modifier = Modifier.fillMaxWidth(), onClick: () -> Unit) {
    val on = ready && !busy
    Box(
        modifier.height(60.dp).then(if (on) Modifier.press(0.98f, onClick) else Modifier).clip(RoundedCornerShape(14.dp))
            .background(if (ready) V.Blue else V.Key),
        contentAlignment = Alignment.Center,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp)
        else T(label, if (ready) 17.sp else 15.sp, if (ready) 800 else 600, if (ready) Color.White else V.Text3, Modifier.padding(horizontal = 14.dp), lines = 2)
    }
}

@Composable
internal fun QuietLink(label: String, enabled: Boolean, onClick: () -> Unit) {
    T(label, 14.sp, 600, if (enabled) V.BlueText else V.Off, Modifier.then(if (enabled) Modifier.press(0.97f, onClick) else Modifier).padding(vertical = 8.dp))
}
