package com.restopos.core.data

// What a sentence says of where a saved change goes. A linked till asks the
// server and the other tills have the change at their next sync; a tablet
// that works on its own (the offline plan) keeps it, and there is no other
// till. Set from the settings wherever they are read (ServiceRepository.ask,
// the main screen), so that a sheet says the right one.
object Journey {
    @Volatile var alone: Boolean = false

    // under the title of a sheet that saves something
    val needs: String get() = if (alone) "Saved on this tablet." else "Needs a connection. Every till has it at its next sync."
    // after "X is added." or "X is saved."
    val others: String get() = if (alone) "" else " The other tills have it at their next sync."
}
