# Labels printed from a shop's till: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a shop's till prints price and barcode labels on a sticker printer set up on the tablet, from a
Print labels screen with ready-made labels.

**Architecture:** a label is drawn on the tablet as a one-bit picture at the printer's dots and sent as a
picture. Plain-Kotlin units decide everything that can be decided without Android (template, bars,
layout, the printer's bytes, which USB device, the list's limits) and are unit-tested; one Android file
paints; `Printing` sends. The label printer is the tablet's own, kept in the DataStore like the scanners.

**Tech stack:** Kotlin, Jetpack Compose, kotlinx.serialization, DataStore, JUnit 4, ZXing core (new).

**Spec:** `docs/superpowers/specs/2026-10-10-till-labels-design.md`.

**Rules of this folder:** another session may commit here. Stage only the files a task names; re-read a
file's committed version before editing it. Never push a tag. No migration, no API or back office change.
Build with `android/gradlew -p android --priority low --max-workers 2 ...`, and `gradlew --stop` after.
Test on an emulator that holds nothing of the owner's (look before using one; make a new AVD if unsure).
Paths below are under `android/app/src/main/java/com/restopos/` unless they start with `android/`.

**Words used below.** *dots*: `round(mm * dpi / 25.4)`. *Raster*: the existing `core/print/Docs.kt`
class, a set bit is a black dot, rows of `widthBytes` bytes, most significant bit first.

---

### Task 1: ZXing in the build

**Files:** `android/gradle/libs.versions.toml`, `android/app/build.gradle.kts`.

- [ ] Add `zxing = "3.5.3"` under `[versions]` and
  `zxing-core = { group = "com.google.zxing", name = "core", version.ref = "zxing" }` under `[libraries]`;
  `implementation(libs.zxing.core)` after `libs.paging.compose`.
- [ ] `android/gradlew -p android --priority low --max-workers 2 :app:compileDebugKotlin` succeeds.
- [ ] Commit both files.

### Task 2: the bars (`core/print/LabelBars.kt`, test first)

```kotlin
object LabelBars {
    class Symbol(val bits: BooleanArray, val ean: Boolean)   // bars and their quiet zones, one entry a module
    fun isEan13(code: String): Boolean                       // 13 digits and the right check digit
    fun symbol(code: String): Symbol?                        // null: empty, over 40 characters, or outside ASCII 32..126
    fun module(modules: Int, boxDots: Int, dpi: Int): Int?   // dots in the thinnest bar, or null when it cannot fit
}
```

- EAN-13 by `EAN13Writer().encode(code)` with 11 clear modules before and 7 after; anything else by
  `Code128Writer().encode(code)` with 10 each side. Both `encode(String)` give modules with no margin.
- `module`: the most whole dots at which `modules * dots <= boxDots`, at least `ceil(0.25 mm)` in dots
  (2 at 203 dpi, 3 at 300) and at most `ceil(0.5 mm)` (4 and 6); null when the least does not fit.

- [ ] **Test** `android/app/src/test/java/com/restopos/core/print/LabelBarsTest.kt`:
  - `isEan13`: `5901234123457` and `2000000000008` true; `5901234123458`, `590123412345`, `59012341234AB` false.
  - `symbol("5901234123457")`: ean, 113 modules, the first 11 and last 7 clear, module 11 set, 95 between.
  - `symbol("1010")`: not ean, the first 10 and last 10 clear, `(size - 20 - 13) % 11 == 0`.
  - `symbol("SML-GX11")` not null; `symbol("")`, a 41-character code and `"é1"` null.
  - `module(113, 288, 203) == 2`, `module(113, 352, 203) == 3`, `module(113, 192, 203) == null`,
    `module(113, 295, 300) == null`, `module(40, 320, 203) == 4`.
- [ ] Run `:app:testDebugUnitTest --tests "*LabelBarsTest"`: fails to compile. Write the object. Passes.
- [ ] Commit.

### Task 3: templates and layout (`core/print/LabelTemplate.kt`, `LabelLayout.kt`, test first)

```kotlin
@Serializable data class LabelTemplate(val id: String, val name: String, val widthMm: Float, val heightMm: Float,
    val gapMm: Float = 2f, val elements: List<LabelElement>) { val size: String get() = "40 x 30" /* from the mm */ }
@Serializable sealed class LabelElement {
    // field: shop | name | variant | price | code, or "" for `text` as written. size is the letters' height in mm.
    @Serializable @SerialName("text") data class Text(val x: Float, val y: Float, val w: Float, val h: Float,
        val field: String = "", val text: String = "", val size: Float, val bold: Boolean = false, val lines: Int = 1) : LabelElement()
    // the bars, with the code in letters under them `digits` mm high (0: none)
    @Serializable @SerialName("bars") data class Bars(val x: Float, val y: Float, val w: Float, val h: Float, val digits: Float = 2.4f) : LabelElement()
    @Serializable @SerialName("box") data class Box(val x: Float, val y: Float, val w: Float, val h: Float, val thick: Float = 0.3f) : LabelElement()
}
class LabelWords(val shop: String, val name: String, val variant: String, val price: String, val code: String?)
object LabelTemplates { val all: List<LabelTemplate>; const val DEFAULT = "40x30-full"
    fun byId(id: String?): LabelTemplate /* DEFAULT when unknown */; fun test(of: LabelTemplate): LabelTemplate }

object LabelLayout {
    fun dots(mm: Float, dpi: Int): Int
    sealed class Item {
        data class Words(val x: Int, val y: Int, val w: Int, val h: Int, val text: String, val px: Int, val bold: Boolean, val lines: Int) : Item()
        class Bars(val x: Int, val y: Int, val h: Int, val module: Int, val bits: BooleanArray) : Item()   // x is where the quiet zone starts
        data class Rect(val x: Int, val y: Int, val w: Int, val h: Int) : Item()
    }
    class Placed(val width: Int, val height: Int, val items: List<Item>, val noBars: String?)
    fun place(t: LabelTemplate, w: LabelWords, dpi: Int): Placed
}
```

Rules of `place`:
- A text whose words are blank is left out. A template with no `variant` text shows the variant after
  the name: "Name, variant".
- Bars: `LabelBars.symbol(code)` and `module(...)` for the box. Fit: a `Bars` item centred in the box,
  its height the box less the digits and a 0.4 mm gap, and the code as `Words` under it. No fit, or no
  symbol: the code alone as `Words` in the whole box, letters `min(3 mm, 45% of the box)`, and
  `noBars = "This code is too wide for bars on a label this size, so it prints as characters."`
  No code at all: nothing in the box, `noBars = "No barcode or SKU, so this label has no bars."`
  A template with no `Bars` element: `noBars = null`.
- A `Box` becomes four `Rect`s. Everything is clipped to the label.

The ready-made labels (mm; all text centred, which is the painter's only alignment):

| id | name | elements |
|---|---|---|
| `40x30-full` | Name, price, barcode | name 1.5,1.2 37x7.6 size 3.2 bold 2 lines; variant 1.5,8.9 37x3.2 size 2.6; price 1.5,12.2 37x5.6 size 5.0 bold; bars 2,18.3 36x10.2 |
| `50x25-shop` | Shop, name, price, barcode | shop 1.5,1.0 47x3.4 size 2.8 bold; name 1.5,4.5 47x3.6 size 3.0; price 1.5,8.2 47x5.4 size 4.6 bold; bars 3,14.0 44x10 |
| `25x15-name-price` | Name and price | name 1,1 23x6.2 size 2.6 bold 2 lines; price 1,8.2 23x5.6 size 4.4 bold |
| `25x15-price` | Price only | price 1,3.5 23x8 size 6.5 bold |
| `25x15-price-bars` | Price and barcode | price 1,0.8 23x4.4 size 3.6 bold; bars 0.5,5.6 24x8.6 digits 2.2 |

`test(of)`: the same size; a box 0.4 mm in from every edge; "EasyPay label test" and the size ("40 x 30 mm")
as fixed text in the upper half; bars over the lower 45%. It is placed with code `2000000000008`.

- [ ] **Test** `LabelLayoutTest.kt`, with words `LabelWords("EasyHome", "S.Mirror Led", "GX11", "Rs 1,700.00", code)`:
  - sizes at 203 dpi: 320x240, 400x200, 200x120; at 300 dpi `40x30-full` is 472x354.
  - `40x30-full`, EAN: one `Bars` with module 2, 226 dots wide, inside x 16..304; words for name, variant,
    price and the code; `noBars == null`.
  - `50x25-shop`, EAN: module 3; a `Words` "S.Mirror Led, GX11"; a `Words` "EasyHome".
  - `25x15-price-bars`: EAN gives no `Bars`, a `Words` with the code, and the "too wide" sentence; code
    `1010` gives `Bars` module 2 and `noBars == null`; code null gives the "No barcode" sentence.
  - blank variant: no empty `Words`; blank price (a price typed at the sale): none either.
  - `25x15-price`: `noBars == null` whatever the code.
  - every item of every template lies inside `0..width, 0..height`.
  - every template survives `Json.encodeToString` and back, equal.
  - `test(byId("50x25-shop"))` placed: four `Rect`s, a `Bars`, the words "EasyPay label test".
- [ ] Fails to compile; write both files; passes. Commit.

### Task 4: the printer's bytes (`core/print/LabelJob.kt`, test first)

```kotlin
object LabelJob {
    class Label(val raster: Raster, val copies: Int)
    fun tspl(labels: List<Label>, widthMm: Float, heightMm: Float, gapMm: Float): ByteArray
    fun escpos(labels: List<Label>, paperMm: Int): Result<ByteArray>
}
```

- TSPL, ASCII, each line ended CR LF: `SIZE 40 mm,30 mm`, `GAP 2 mm,0 mm`, `DIRECTION 1`, then for each
  label `CLS`, `BITMAP 0,0,<widthBytes>,<height>,0,` followed by the raster with every bit turned over
  and a CR LF, `PRINT 1,<copies>`. A whole number of mm is written without a decimal, another with one.
- ESC/POS: `ESC @`, then for each copy of each label `GS v 0` (as `EscPos.raster`), three line feeds and
  the cut `GS V 66 0`. A raster wider than the paper (`EscPos.dotsFor`) fails with
  "This label is wider than the printer's paper. Pick a smaller label, or a sticker printer."

- [ ] **Test** `LabelJobTest.kt`: a 12x2-dot raster (`widthBytes` 2, bits `F0 00 0F F0`):
  - `tspl(listOf(Label(r, 3)), 40f, 30f, 2f)` is exactly
    `"SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1\r\nCLS\r\nBITMAP 0,0,2,2,0,"` + `0F FF F0 0F` +
    `"\r\nPRINT 1,3\r\n"`.
  - two labels: `CLS` twice, `SIZE` once. `tspl(..., 37.5f, 25f, 3f)` starts `SIZE 37.5 mm,25 mm`.
  - `escpos(listOf(Label(r, 2)), 80)`: starts `1B 40`, holds `1D 76 30 00 02 00 02 00 F0 00 0F F0` twice
    and `1D 56 42 00` twice.
  - a raster 50 bytes wide on 58 mm paper fails with the sentence; on 80 mm it succeeds.
- [ ] Fails to compile; write it; passes. Commit.

### Task 5: the label printer as the tablet keeps it (`core/print/LabelPrinter.kt`, `core/sync/Sync.kt`, test first)

```kotlin
@Serializable data class LabelPrinter(val name: String, val kind: String /* network | usb | bluetooth */, val address: String? = null,
    val language: String = TSPL /* tspl | escpos */, val dpi: Int = 203, val paper: Int = 80,
    val usbVendor: Int? = null, val usbProduct: Int? = null, val usbName: String? = null, val usbSerial: String? = null) {
    companion object { const val TSPL = "tspl"; const val ESCPOS = "escpos"; const val ID = "label-printer" }
}
object LabelPrinters {
    fun read(text: String?): LabelPrinter?          // unreadable is none
    fun write(p: LabelPrinter): String
    fun form(name: String, kind: String, address: String, language: String, dpi: Int, paper: Int, usb: UsbPick.Seen?): Result<LabelPrinter>
}
object UsbPick {
    data class Seen(val vendor: Int, val product: Int, val name: String?, val serial: String?)
    fun match(p: LabelPrinter, seen: List<Seen>): Seen?            // the label printer among what is plugged in
    fun twins(pick: Seen, seen: List<Seen>): Boolean               // another one that cannot be told from it
    fun receipt(seen: List<Seen>, label: LabelPrinter?): Seen?     // where receipts go: the first that is not the label printer
}
```

- `form`: the name and address rules are `PrinterForm.read`'s (its messages); USB needs a pick ("Pick the
  printer among what is plugged into this tablet"); dpi is 203 or 300; paper 58 or 80; language one of the two.
- `match`: vendor and product equal; where both serials are known they must be equal; among several left,
  the one of the same name, else the first. `twins`: another seen device with the same vendor and product
  whose serial is unknown, or equal, or whose own is unknown.
- `receipt`: with no USB label printer, the first seen; else the first that is not `match(label, seen)`.
- `SessionStore`: keys `label_printer`, `label_template`; `val labelPrinter: Flow<LabelPrinter?>`,
  `setLabelPrinter(p: LabelPrinter?)`, `val labelTemplate: Flow<String?>`, `setLabelTemplate(id)`; `clear()`
  keeps both, as it keeps the scanners.

- [ ] **Test** `LabelPrinterTest.kt`: write then read is equal; `read(null)`, `read("")`, `read("{")` null;
  `form` refuses a blank name, a network printer with `abc`, a Bluetooth one with no pick, a USB one
  with no pick, and takes `192.168.1.50:9100`; `match` by serial among two of one make; `match` null when
  unplugged; `twins` true for two of the same numbers with no serial, false when serials differ;
  `receipt` skips the label printer, returns the first with none saved, null when only the label printer
  is plugged in.
- [ ] Fails to compile; write the file and the store's lines; passes. Commit.

### Task 6: the list's rules (`core/data/LabelList.kt`, test first)

```kotlin
object LabelList {
    const val MOST_EACH = 99; const val MOST_RUN = 240
    data class Row(val key: String, val copies: Int)
    fun add(rows: List<Row>, key: String, by: Int = 1): List<Row>  // at the end, or more of it; never past either limit
    fun set(rows: List<Row>, key: String, copies: Int): List<Row>  // 0 takes it off; clipped to both limits
    fun total(rows: List<Row>): Int
    fun code(barcode: String?, sku: String?): String?              // the barcode, else the SKU, else none; blanks are none
}
```

- [ ] **Test** `android/app/src/test/java/com/restopos/core/data/LabelListTest.kt`: add new, add again,
  stop at 99 of one, stop at 240 in all (a row is cut to what is left, and none is added at 240),
  `set` to 0 removes, `set` 500 gives 99, order kept, `code` in its three cases and with blanks.
- [ ] Fails; write; passes. Commit.

### Task 7: painting (`core/print/LabelPaint.kt`)

```kotlin
object LabelPaint {
    fun bitmap(p: LabelLayout.Placed): Bitmap    // white, ARGB_8888
    fun raster(b: Bitmap): Raster                // a dot is black under half brightness
    fun raster(p: LabelLayout.Placed): Raster
}
```

- `Words`: `TextPaint` at `px`, the default sans, bold as asked, no anti-aliasing, drawn with a
  `StaticLayout` centred across its box, `maxLines`, cut with an ellipsis, the block centred down the
  box. `Bars`: one `drawRect` per run of set modules, `module` dots a module, no anti-aliasing. `Rect`: a
  filled rectangle.
- No unit test (it needs Android): it is seen in Task 11.
- [ ] Compiles. Commit with Task 8.

### Task 8: sending (`core/print/Printing.kt`)

- Keep the saved label printer in `@Volatile private var label: LabelPrinter?`, collected from
  `session.labelPrinter` in `scope`. `suspend fun labelPrinter(): LabelPrinter?` reads the store.
- `fun usbPrinters(): List<UsbPick.Seen>`: every plugged printer-class device (name from `productName`,
  serial read inside `runCatching`).
- `usb(bytes, forLabel: LabelPrinter? = null)`: the device is `UsbPick.match(forLabel, seen)` for a label
  ("<name> is not plugged into this tablet."), else `UsbPick.receipt(seen, label)`. `usbPrinter()` and the
  USB branch of `answers()` use `receipt` too, so a store's USB printer is never the label printer.
- `suspend fun sendLabels(lp: LabelPrinter, bytes: ByteArray, what: String): Result<Unit>`: a
  `PrinterEntity` that is not stored (id `LabelPrinter.ID`, the name, kind, address and paper), delivered
  under its own turn, the job listed with `again = null`.
- [ ] Compiles; every existing unit test still passes (`:app:testDebugUnitTest`). Commit Tasks 7 and 8.

### Task 9: the label printer's set-up (`feature/retail/LabelPrinter.kt`, `feature/settings/SettingsScreen.kt`)

- `LabelPrinterViewModel` (Hilt): `printer: StateFlow<LabelPrinter?>`, `usb()`, `paired()`,
  `bluetoothAllowed()`, `save(p)`, `remove()`, `suspend test(p): String?` (the test label of the template
  in use, through `sendLabels`; null when sent, else why not).
- `LabelPrinterSheet(vm, onDismiss)`: the V2 kit, after `feature/setup/PrinterStep.kt`: name; connection
  (Network: the address; USB: the plugged printers to pick from, and the twins sentence in place of Save
  when the pick has one; Bluetooth: Allow Bluetooth, then the paired devices to pick from); type (Sticker
  printer / Receipt printer); resolution for a sticker printer (203 dpi / 300 dpi), paper for a receipt
  printer (80 mm / 58 mm). Keys: "Print a test label" (sends from what is typed, saves nothing), "Save".
- Settings: `Page.Labels("Label printer")` in the group of Printers and Scanners, left out of the menu
  for a restaurant. Its page: the saved printer (name, connection, type) with Test label, Change and
  Remove, or "No label printer on this tablet" with Add; a note that labels are printed from Print labels
  in the side menu.
- `SHOP_HELP`: an entry "Printing labels" (the side menu's Print labels, how products are added, how many,
  the label and its preview, where the label printer is set up, what a label with no bars means).
- [ ] Compiles. Commit.

### Task 10: the Print labels screen (`feature/retail/Labels.kt`, `RetailSell.kt`, `Products.kt`, `feature/main/MainShell.kt`)

- `LabelsViewModel` (Hilt; `db`, `session`, `sales: RetailSales`, `printing`): the categories, the query
  and the products as `ProductsViewModel` has them; `rows: StateFlow<List<LabelRow>>` (`LabelRow`: key
  `item:variant`, item, variant, copies) ruled by `LabelList`; `selected`; `template` (the store's choice
  through `LabelTemplates.byId`); `printer`; `preview: StateFlow<Bitmap?>` of the selected row, else the
  first, else sample words, painted off the main thread at the printer's dpi (203 with none); `picking`
  for a product with variants; `asking: NumAsk` for a typed count; `busy`.
  `tap(item)`, `pick(item, variants)`, `scanned(code)` (through `sales.find`: a product adds one, a
  product with variants opens the picker, nothing says so), `bump`, `askCopies`, `remove`, `clear`,
  `setTemplate`, `addProduct(item)` for the product sheet's key, `print()`.
- `print()`: each row's words (`shop().name`; the price by `Money.format`, " /kg" when weighed, blank for
  a price typed at the sale; the code by `LabelList.code` of the variant, or of the product without one),
  placed and painted at the printer's dpi, wrapped by its language, sent by `sendLabels`. Sent: rows
  emptied, "N labels sent to <name>." Not sent: rows kept, the printer's sentence.
- `LabelsScreen(vm, printers)`: left a panel 420 dp wide (head "Print labels" with Clear; the rows, each
  with name, variant, code or the no-bars note, minus, the count, plus, and a key to take it off; the
  label in use with its preview, tapping it opens `TemplateSheet`; the foot with the total and Print, or
  "Set up the label printer" opening `LabelPrinterSheet`); right the products (search box with the scan
  key, category keys, tiles) from `RetailSell.kt`'s `CatKey` and `Tile`, made `internal`.
- `TemplateSheet`: the ready-made labels grouped by size, each painted with the selected row's words.
- `Products.kt`: "Print label" on the product's sheet beside Edit product; `ProductsScreen(vm, onLabel)`.
- `MainShell.kt`: `Screen.Labels` in the enum, `SHOP_ONLY`, `SHOP_BACK` ("Print labels", `VI.Print`), the
  `Scanner.taking` condition, the `when`; `val labels: LabelsViewModel = hiltViewModel()` beside `sell`.
- [ ] Compiles; all unit tests pass. Commit.

### Task 11: see it run

- [ ] An emulator of my own, checked first; the debug build; the made-up shop (`DEMO_SHOP`).
- [ ] A stand-in printer on this PC (a Node listener in the scratchpad that keeps every job's bytes) and
  a script that turns a kept TSPL job back into PNG pictures.
- [ ] More > Label printer: add a network sticker printer at `10.0.2.2:<port>`; Print a test label; look
  at the picture. Then each ready-made label with: a product with an EAN-13, one with a short code, one
  with variants, one with no code, one sold by weight, one with a long accented name. Look at every
  picture: bars whole dots wide, nothing cut, nothing overlapping.
- [ ] The same run as a receipt-type printer; a scan on the screen (`DEMO_SCAN`); the limits; Print with
  the listener stopped (the list stays, the sentence shows); the two screens also on a low screen
  (`wm size 1920x1200`, `wm density 280`), then reset.
- [ ] Fix what was seen. Leave the emulator shut down and `gradlew --stop`.

### Task 12: the release's number, and the record

- [ ] `android/app/build.gradle.kts`: `versionCode = 13`, `versionName = "0.9.0"`.
- [ ] `:app:testDebugUnitTest` and `:app:assembleDebug` pass.
- [ ] Add a record at the end of this file: what was built, what was seen, what was not.
- [ ] Commit. Do not tag: the release is the owner's.

---

## Record (2026-10-10)

Built in the order above, on `restopos`. Till 0.9.0 (build 13); 342 unit tests pass, 34 of them new.

**Where it left the plan**

- The tests of tasks 3 to 6 were written before their code and first run with it. Only task 2's was
  also run before its code existed.
- `LabelJob.bytes(printer, labels, template)` wraps a run in the printer's language: both the test label
  and a run go through it.
- A single line of words too wide for its box is drawn smaller, down to half its size, and only then
  cut. Seen on "Price only", where a price lost its end.
- The 40 x 30 label's variant, price and bars moved a few tenths of a millimetre apart.
- On Print labels a line just added is scrolled into view, and the sheet of ready-made labels puts the
  two sizes that have one label on one row, so that all five are on screen.
- The printer form's keyboard is put away by its own Done key. The keyboard has to be asked for inside
  the sheet: a sheet is a window of its own, and the one asked for outside it is the screen's behind.
- With no label printer the Print key opens the form itself (the design was changed to say so).

**Seen running,** on a new emulator of my own (`easypay_claude_labels`, port 5590) holding the made-up
shop, against a stand-in printer on this PC that keeps each job's bytes (`listen.cjs` and `decode.cjs`
in the session's scratch folder; the second turns a job back into pictures):

- More > Label printer: none, the form, a network printer added, its test label, Connected, Change.
- The test label as the stand-in received it: the frame on four sides, the words, an EAN-13.
- Print labels from the side menu and from a product's sheet; products tapped and scanned (`DEMO_SCAN`),
  a code no product has; a product with eight variants (two picked, then all); a count typed as 500
  held to 99; the list emptied after a run that was sent.
- Each ready-made label as pictures: 40 x 30 (EAN-13 at 2 dots, a SKU as Code 128, a variant, a price by
  the kilo), 50 x 25 (the shop's name, the variant after the name, bars at 3 dots), the three 25 x 15
  (thirteen digits as characters, with the screen saying why).
- The copies of one label sent as one picture (`PRINT 1,2`); a run of ten different labels in one job.
- The same printer as a receipt-type printer: one raster and a cut for each copy.
- A printer that does not answer: the till's sentence, the list kept, the dot red.
- Both screens on a lower screen (about 1097 x 686 dp).

**Not seen**

- A real printer of any kind. So: that TSPL's bits are the way round the manual says, the gap and the
  size on real stickers, whether a long run overruns a printer's buffer, USB (the device picked, the
  two-printers refusal, Android's permission), Bluetooth, 300 dpi.
- A product with neither barcode nor SKU, and a long accented name: the made-up shop has neither. Their
  layout is unit-tested; their picture was not looked at.
- A restaurant's till without the page and the screen (it is one condition in the menu and the shell).
