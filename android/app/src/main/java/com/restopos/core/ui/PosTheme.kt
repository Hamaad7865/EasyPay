package com.restopos.core.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp
import com.restopos.core.common.CssColor

// The till's look, in two lights. Dark: near-black screens with dark grey
// panels. Light: a pale grey screen with white panels. Blue categories and
// blue and green action keys in both. One place for every colour so screens
// never hard-code one, and one switch (Settings, Display) that every colour
// reads: a screen follows it the moment it changes.
object Pos {
    var light by mutableStateOf(false)
    private fun of(dark: Long, bright: Long) = Color(if (light) bright else dark)

    val Bg: Color get() = of(0xFF1B1C1F, 0xFFEEF0F4)
    val BarTop: Color get() = of(0xFF2B2C30, 0xFFFFFFFF)
    val BarBottom: Color get() = of(0xFF2B2C30, 0xFFFFFFFF)
    val Panel: Color get() = of(0xFF2B2C30, 0xFFFFFFFF)
    val PanelDeep: Color get() = of(0xFF232427, 0xFFF5F6F9)
    val Key: Color get() = of(0xFF333438, 0xFFE4E7ED)
    val Line: Color get() = of(0xFF17181A, 0xFFC8CCD6)
    val Stroke: Color get() = of(0xFF36383E, 0xFFD9DCE4) // the hairline around a card and between its rows
    val Tile: Color get() = of(0xFF3B3C41, 0xFFFFFFFF)
    val TileEdge: Color get() = of(0xFF3D6BFF, 0xFF3D6BFF)
    val Blue: Color get() = of(0xFF4C6FF5, 0xFF3F62F0)
    val Green: Color get() = of(0xFF4E9A62, 0xFF3E8E55)
    val Pink: Color get() = of(0xFFE2587A, 0xFFC92F5B)
    val Violet: Color get() = of(0xFF8A92F7, 0xFF5B63E0)
    val Text: Color get() = of(0xFFF3F4F6, 0xFF1A1C21)
    val Text2: Color get() = of(0xFFA9AFBC, 0xFF4B5261)
    val Text3: Color get() = of(0xFF7C8291, 0xFF7A8191)
    val Selected: Color get() = of(0xFF46474D, 0xFFD9E1FB)
    val NavOn: Color get() = of(0xFF6C8BFF, 0xFF2F55E0)
    // behind text in the screen's own text colour: the void keys, the sync notices
    val Danger: Color get() = of(0xFF8E2B40, 0xFFF7C6D1)
    val CategoryDefault: Color get() = of(0xFF1740E0, 0xFF1740E0)
    val Link: Color get() = of(0xFFAEB8F8, 0xFF2F55E0) // text you can tap: Log out, New order, the sorted column
    val TabOn: Color get() = of(0xFF1740E0, 0xFF1740E0)
    val ChipOpen: Color get() = of(0xFFB4BDF7, 0xFF2F55E0)
    val Ok: Color get() = of(0xFF45A85A, 0xFF2B8A45)
    val Warn: Color get() = of(0xFFE6B23C, 0xFFA87300)

    // A category's or item's own colour, as set in the back office.
    fun css(value: String?, fallback: Color): Color = CssColor.argb(value)?.let { Color(it) } ?: fallback
}

@Composable
fun PosTheme(content: @Composable () -> Unit) {
    val scheme = if (Pos.light) {
        lightColorScheme(
            primary = Pos.Blue,
            onPrimary = Color.White,
            secondary = Pos.Green,
            onSecondary = Color.White,
            background = Pos.Bg,
            onBackground = Pos.Text,
            surface = Pos.Panel,
            onSurface = Pos.Text,
            surfaceVariant = Pos.Key,
            onSurfaceVariant = Pos.Text2,
            surfaceContainer = Pos.Panel,
            surfaceContainerHigh = Pos.Panel,
            surfaceContainerHighest = Pos.Key,
            surfaceContainerLow = Pos.PanelDeep,
            outline = Pos.Text3,
            outlineVariant = Pos.Stroke,
            error = Pos.Pink,
            onError = Color.White,
            errorContainer = Pos.Danger,
            onErrorContainer = Pos.Text,
        )
    } else {
        darkColorScheme(
            primary = Pos.Blue,
            onPrimary = Color.White,
            secondary = Pos.Green,
            onSecondary = Color.White,
            background = Pos.Bg,
            onBackground = Pos.Text,
            surface = Pos.Panel,
            onSurface = Pos.Text,
            surfaceVariant = Pos.Key,
            onSurfaceVariant = Pos.Text2,
            surfaceContainer = Pos.Panel,
            surfaceContainerHigh = Pos.Key,
            surfaceContainerHighest = Pos.Key,
            surfaceContainerLow = Pos.PanelDeep,
            outline = Pos.Text3,
            outlineVariant = Pos.Line,
            error = Pos.Pink,
            onError = Color.White,
            errorContainer = Pos.Danger,
            onErrorContainer = Pos.Text,
        )
    }
    MaterialTheme(colorScheme = scheme, content = content)
}

// The icons the core icon set lacks (Material Symbols outlines, 24dp).
object PosIcons {
    val Backspace: ImageVector = icon(
        "M22,3L7,3c-0.69,0 -1.23,0.35 -1.59,0.88L0,12l5.41,8.11c0.36,0.53 0.9,0.89 1.59,0.89h15c1.1,0 2,-0.9 2,-2L24,5c0,-1.1 -0.9,-2 -2,-2zM22,19L7.07,19L2.4,12l4.66,-7L22,5v14zM10.41,17L14,13.41 17.59,17 19,15.59 15.41,12 19,8.41 17.59,7 14,10.59 10.41,7 9,8.41 12.59,12 9,15.59z",
    )
    val Receipt: ImageVector = icon(
        "M19.5,3.5L18,2l-1.5,1.5L15,2l-1.5,1.5L12,2l-1.5,1.5L9,2 7.5,3.5 6,2 4.5,3.5 3,2v20l1.5,-1.5L6,22l1.5,-1.5L9,22l1.5,-1.5L12,22l1.5,-1.5L15,22l1.5,-1.5L18,22l1.5,-1.5L21,22V2l-1.5,1.5zM19,19.09H5V4.91h14v14.18zM6,15h12v2H6zM6,11h12v2H6zM6,7h12v2H6z",
    )

    val Grid: ImageVector = icon("M3,3h8v8H3V3zM13,3h8v8h-8V3zM3,13h8v8H3v-8zM13,13h8v8h-8v-8z")

    val Clock: ImageVector = icon(
        "M11.99,2C6.47,2 2,6.48 2,12s4.47,10 9.99,10C17.52,22 22,17.52 22,12S17.52,2 11.99,2zM12,20c-4.42,0 -8,-3.58 -8,-8s3.58,-8 8,-8 8,3.58 8,8 -3.58,8 -8,8zM12.5,7H11v6l5.25,3.15 0.75,-1.23 -4.5,-2.67z",
    )
    val Cutlery: ImageVector = icon(
        "M11,9H9V2H7v7H5V2H3v7c0,2.12 1.66,3.84 3.75,3.97V22h2.5v-9.03C11.34,12.84 13,11.12 13,9V2h-2v7zM16,6v8h2.5v8H21V2c-2.76,0 -5,2.24 -5,4z",
    )

    // sync: a dot with waves either side
    val Signal: ImageVector = icon(
        "M7.76,16.24C6.67,15.16 6,13.66 6,12s0.67,-3.16 1.76,-4.24l1.42,1.42C8.45,9.9 8,10.9 8,12c0,1.1 0.45,2.1 1.17,2.83L7.76,16.24z" +
            "M16.24,16.24C17.33,15.16 18,13.66 18,12s-0.67,-3.16 -1.76,-4.24l-1.42,1.42C15.55,9.9 16,10.9 16,12c0,1.1 -0.45,2.1 -1.17,2.83L16.24,16.24z" +
            "M12,10c-1.1,0 -2,0.9 -2,2s0.9,2 2,2s2,-0.9 2,-2S13.1,10 12,10z" +
            "M20,12c0,2.21 -0.9,4.21 -2.35,5.65l1.42,1.42C20.88,17.26 22,14.76 22,12s-1.12,-5.26 -2.93,-7.07l-1.42,1.42C19.1,7.79 20,9.79 20,12z" +
            "M6.35,6.35L4.93,4.93C3.12,6.74 2,9.24 2,12s1.12,5.26 2.93,7.07l1.42,-1.42C4.9,16.21 4,14.21 4,12S4.9,7.79 6.35,6.35z",
    )
    val Print: ImageVector = icon(
        "M19,8L5,8c-1.66,0 -3,1.34 -3,3v6h4v4h12v-4h4v-6c0,-1.66 -1.34,-3 -3,-3zM16,19L8,19v-5h8v5zM19,12c-0.55,0 -1,-0.45 -1,-1s0.45,-1 1,-1 1,0.45 1,1 -0.45,1 -1,1zM18,3L6,3v4h12L18,3z",
    )
    val Card: ImageVector = icon(
        "M20,4L4,4c-1.11,0 -1.99,0.89 -1.99,2L2,18c0,1.11 0.89,2 2,2h16c1.11,0 2,-0.89 2,-2L22,6c0,-1.11 -0.89,-2 -2,-2zM20,18L4,18v-6h16v6zM20,8L4,8L4,6h16v2z",
    )
    val Chart: ImageVector = icon("M5,9.2h3L8,19L5,19zM10.6,5h2.8v14h-2.8zM16.2,13L19,13v6h-2.8z")
    val Screen: ImageVector = icon(
        "M21,2L3,2c-1.1,0 -2,0.9 -2,2v12c0,1.1 0.9,2 2,2h7v2L8,20v2h8v-2h-2v-2h7c1.1,0 2,-0.9 2,-2L23,4c0,-1.1 -0.9,-2 -2,-2zM21,16L3,16L3,4h18v12z",
    )
    val Headset: ImageVector = icon(
        "M12,1c-4.97,0 -9,4.03 -9,9v7c0,1.66 1.34,3 3,3h3v-8H5v-2c0,-3.87 3.13,-7 7,-7s7,3.13 7,7v2h-4v8h3c1.66,0 3,-1.34 3,-3v-7c0,-4.97 -4.03,-9 -9,-9z",
    )
    val Help: ImageVector = icon(
        "M11,18h2v-2h-2v2zM12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zM12,20c-4.41,0 -8,-3.59 -8,-8s3.59,-8 8,-8 8,3.59 8,8 -3.59,8 -8,8zM12,6c-2.21,0 -4,1.79 -4,4h2c0,-1.1 0.9,-2 2,-2s2,0.9 2,2c0,2 -3,1.75 -3,5h2c0,-2.25 3,-2.5 3,-5 0,-2.21 -1.79,-4 -4,-4z",
    )
    // the cash drawer: a till with its drawer out
    val Drawer: ImageVector = icon("M6,3h12v6h3v12H3V9h3V3zM8,5v4h8V5H8zM5,11v8h14v-8H5zM10,14h4v2h-4v-2z")
    // the side menu: a screen with a panel down its left
    val SidePanel: ImageVector = icon("M3,5h18v14H3zM5,7v10h4V7zM11,7v10h8V7zM6,9h2v1.5H6zM6,12h2v1.5H6z")

    private fun icon(path: String): ImageVector =
        ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
            .addPath(pathData = addPathNodes(path), fill = SolidColor(Color.Black))
            .build()
}
