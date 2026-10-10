# The label designer on a shop's till: design (piece 2 of labels)

Piece 1 (`2026-10-10-till-labels-design.md`) prints five ready-made labels. Asked the same evening "Did we
builld the designer?" and told no, the owner wrote: "go ahead and build the designer". Their photos 2 and
3 of the other till app are the reference: a list of templates with Edit and a "Custom template" key, and
an editor with millimetre rulers, a template name, the paper's size and gap, attributes to tick, "Add
other items" (text, image, line, rectangle, background) and a row of arrows, A+, A-, a 90° key and delete.

Their choices, by tap, on the design below:

- A shop's own labels are kept **on the tablet**. Told: a second tablet does not see them, and they go if
  the app is uninstalled.
- Turning things by 90°: **"Yes, include it"**.
- "Build it as described".

## 1. What a shop can put on a label

Only what EasyPay holds: the shop's name, the product's name, the variant, the price, the category, the
SKU, today's date, the code as digits, the code as bars; words of the shop's own; a line; a box; the
shop's logo as the back office holds it.

Not offered: another picture, a background, member price, shelf life, production date, place of origin,
spec, material (EasyPay holds none of them).

## 2. The template, as it grows

`LabelTemplate` stays the one description of a label, and what the tablet stores is its JSON, so every
addition has a default and what is written today is read tomorrow (tested):

- `Text` gains `align` (left, center, right; center when absent) and `turn` (0, 90, 180 or 270; 0).
- `Bars` gains `turn`.
- New `Line` (a bar of ink: x, y, w, h) and `Logo` (x, y, w, h).
- `LabelWords` gains the SKU, the category and the date.

An element's box is where it sits on the label as it is seen. A turned text or symbol is laid out the
other way round inside that box and turned with it; a line or a box is turned by swapping its sides.

The ready-made labels cannot be changed. "Edit a copy" makes one of the shop's own from any of them.

## 3. Where the shop's own labels are kept

On the tablet, with the label printer and the label last picked (DataStore), and like them kept through
a sign-out: there is no other copy, and losing a shop's designs to a sign-out would be worse than a
tablet that changes hands still holding them. Every place that needs a label asks one book that holds
the ready-made ones and the shop's own: the Print labels screen, the sheet that picks one, the test
label of the printer page. Deleting the label in use puts the first ready-made one in its place, and
the till says so.

## 4. The editor

Arranged as photo 3, in EasyPay's look, in place of the Print labels screen while it is open.

- **Left, the label:** drawn large between millimetre rulers. It is the picture that prints (the same
  layout and painter, at the printer's dots), with the words of the line selected on Print labels, or
  sample words. Over it only the selection is drawn: a frame round what is selected and a handle at its
  corner. Tap a thing to select it (the smallest under the finger), drag it to move it, drag the handle
  to size it.
- **Under it, the keys:** four arrows (half a millimetre a tap), A- and A+ (the letters of a text, the
  thickness of a line or a box), Turn (90° a tap), Delete. What a label that should have bars lacks is
  said here while it is designed (too wide, no code).
- **Right, the panel:** the label's name; its width, height and gap in mm; everything on the label as a
  list, to select what a finger cannot hit; the keys that add each thing; and what is selected: its
  width and height, and for words whether they are bold, how they are set and on how many lines, the
  words themselves when they are the shop's own; for bars whether the digits are under them.
- **At the top:** back (asking first when something changed), Print a test, Delete (one of the shop's
  own), Save.

**Limits,** held in plain Kotlin and tested: a label is 15 to 110 mm wide, 10 to 150 mm high, with a gap
of 0 to 10 mm; nothing can be moved, sized or turned off the label; changing the label's size brings
what would be left outside back in; a label needs a name and at least one thing on it to be saved.

**Who:** designing and deleting a label asks for `items.edit`, the permission of changing a product; a
cashier without it is asked for someone who has it. Picking a label and printing stay everyone's.

## 5. Where it is reached

The "Which label?" sheet of Print labels: "New label" first, then the ready-made labels with "Edit a
copy", then the shop's own with "Edit". It scrolls, and a label of any size is fitted into its card.

## 6. Where it touches what exists

`core/print/LabelTemplate.kt`, `LabelLayout.kt`, `LabelPaint.kt` (alignment, turning, line, logo);
new `core/print/LabelBook.kt` (the book: read, write, find) and `core/print/LabelEdit.kt` (every
change the editor makes, clamped); `core/sync/Sync.kt` (the shop's own labels on the tablet);
`core/print/Printing.kt` (the logo as a picture); `feature/retail/Labels.kt` (the book in the view
model, the sheet), new `feature/retail/LabelDesigner.kt` (the editor); `LabelPrinter.kt` (the test label
of a label of the shop's own); `SettingsScreen.kt` (a shop's Help).

No migration, no API or back office change. It goes out in till 0.9.0 (build 13), which is not released.

## 7. How it is checked, and what is not

Unit tests: today's JSON still read; the new elements placed, turned and aligned; every change of the
editor kept on the label, a few thousand random ones included; the book. On an emulator of my own: the
editor used by hand, a label of the shop's own printed to the stand-in printer and its picture compared
with the editor's, on the usual screen and on a lower one. Not checked: a real printer, as for piece 1.
