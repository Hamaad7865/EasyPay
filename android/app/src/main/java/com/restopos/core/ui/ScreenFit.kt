package com.restopos.core.ui

// How large the till is drawn on the tablet it runs on.
//
// The screens are laid out for 1280 x 720 dp and the whole app is enlarged to
// the tablet (MainActivity.attachBaseContext), so a 15-inch till shows the
// same layout larger instead of the same sizes lost in empty space.
//
// The owner, with a 10-inch tablet in hand: "the components are too small".
// That tablet is 1280 dp wide: the layout fitted it at exactly 1, which is
// Android's own sizes, made for a phone held in the hand and not for a till
// read from across a counter. So the till is never drawn at less than LEAST
// times Android's sizes, and the screens have what is left: on that tablet
// about 1067 x 607 dp, the same screens with a sixth less room each way.
//
// Three cases, by how the full layout fits the tablet:
//   - it fits at LEAST or more (a large till): as before, the full layout
//     enlarged to the screen;
//   - it fits at between 1 and LEAST (a 10-inch): LEAST, and the screens are
//     laid out in less room than the full layout;
//   - it does not fit at 1 (a small tablet): the smallest layout the screens
//     are made for, WIDTH / LEAST x HEIGHT / LEAST, fitted to the screen.
// So no screen may need more than 1067 x 600 dp: what does has to scroll or
// give way, as the pay screen does (feature/pay/PayFit).
object ScreenFit {
    const val WIDTH = 1280f
    const val HEIGHT = 720f
    const val LEAST = 1.2f

    // `a` and `b` are the room the screens have, in Android's dp, either way round.
    fun scale(a: Float, b: Float): Float {
        val full = minOf(maxOf(a, b) / WIDTH, minOf(a, b) / HEIGHT)
        return minOf(maxOf(full, LEAST), full * LEAST).coerceIn(0.6f, 2f)
    }
}
