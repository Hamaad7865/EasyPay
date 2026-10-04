package com.restopos.core.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp
import com.restopos.core.common.CssColor

// The till's look: dark slate panels, coloured category strip, blue and green
// action keys. One place for every colour so screens never hard-code one.
object Pos {
    val Bg = Color(0xFF14161B)
    val BarTop = Color(0xFF3B404D)
    val BarBottom = Color(0xFF2E323C)
    val Panel = Color(0xFF2B2F3A)
    val PanelDeep = Color(0xFF20232B)
    val Key = Color(0xFF2E323D)
    val Line = Color(0xFF1B1D23)
    val Tile = Color(0xFF4A5062)
    val TileEdge = Color(0xFFB7BAC3)
    val Blue = Color(0xFF4C6FF5)
    val Green = Color(0xFF4E9A62)
    val Pink = Color(0xFFE2587A)
    val Violet = Color(0xFF8A92F7)
    val Text = Color(0xFFF3F4F6)
    val Text2 = Color(0xFFA9AFBC)
    val Text3 = Color(0xFF7C8291)
    val Selected = Color(0xFF3A4152)
    val NavOn = Color(0xFF6C8BFF)
    val Danger = Color(0xFF8E2B40)
    val CategoryDefault = Color(0xFF5B5F68)

    // A category's or item's own colour, as set in the back office.
    fun css(value: String?, fallback: Color): Color = CssColor.argb(value)?.let { Color(it) } ?: fallback
}

@Composable
fun PosTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
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
        ),
        content = content,
    )
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

    private fun icon(path: String): ImageVector =
        ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
            .addPath(pathData = addPathNodes(path), fill = SolidColor(Color.Black))
            .build()
}
