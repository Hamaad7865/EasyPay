package com.restopos.core.ui

import androidx.compose.ui.graphics.Color
import com.restopos.core.data.CategoryForm

// A category's colour: its own, or, with none, one of the first eight
// swatches by its place in the list. One place, so the order screen, the menu
// and the swatches a category is given on the till cannot differ.
private val BY_PLACE = CategoryForm.SWATCHES.take(8).map { Pos.css(it, Color.Gray) }
fun catColor(color: String?, index: Int): Color = Pos.css(color, BY_PLACE[Math.floorMod(index, BY_PLACE.size)])
