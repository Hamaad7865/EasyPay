# The label designer on a shop's till: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a shop designs its own labels on the tablet: any size, its own layout, things turned by 90°.

**Architecture:** the template of piece 1 grows (alignment, turning, a line, the logo), each addition with
a default so stored JSON stays readable. Every change the editor makes is a plain-Kotlin function of a
template that keeps things on the label (`LabelEdit`), and the shop's own labels are a JSON list on the
tablet read through one book (`LabelBook`). The editor's canvas is the printed picture itself; Compose
draws only the rulers and the selection over it.

**Tech stack:** Kotlin, Jetpack Compose, kotlinx.serialization, DataStore, JUnit 4.

**Spec:** `docs/superpowers/specs/2026-10-10-till-label-designer-design.md`.

**Rules of this folder:** as piece 1's plan. Stage only the files a task names. Never push a tag. The
emulator `easypay_claude_labels` (5590) is the owner's now: make another, hidden, for these checks.
Before the last commit, `git ls-remote --tags github` must still show no `v0.9.0`; if it does, the build
becomes 14. Paths are under `android/app/src/main/java/com/restopos/`.

---

### Task 1: the template grows (`core/print/LabelTemplate.kt`, `LabelLayout.kt`; tests first)

- `LabelElement.Text` gains `align: String = "center"` and `turn: Int = 0`; `Bars` gains `turn: Int = 0`;
  new `Line(x, y, w, h)` (`@SerialName("line")`) and `Logo(x, y, w, h)` (`@SerialName("logo")`).
- `LabelWords(shop, name, variant, price, code, sku = "", category = "", date = "")`; fields `sku`,
  `category`, `date`.
- `LabelLayout.Item`: `Words` gains `align: String = "center"`; new `Picture(x, y, w, h)` (the logo) and
  `Turned(x, y, w, h, turn, items)`: `items` are placed in a frame of their own, `h` by `w` for a
  quarter turn, which the painter turns into the box. A `Line` is a `Rect` at least a dot each way.
  With `turn == 0` an element is placed exactly as before.
- [ ] `LabelLayoutTest`, added: a template's JSON as piece 1 wrote it (a literal string, no `align`, no
  `turn`) reads back equal to the ready-made label; text aligned left carries `align`; a text turned 90
  is one `Turned` whose frame is the box's sides swapped and whose words fill it; bars turned 90 fit by
  the box's height; turned 180 keeps the frame; a `Line` 0.05 mm thick is one dot; a `Logo` is a
  `Picture`; the fields `sku`, `category`, `date`; the "everything lies on the label" check walks into
  `Turned`. Run, fail, write, pass. Commit.

### Task 2: the book of labels (`core/print/LabelBook.kt`, `core/sync/Sync.kt`; test first)

```kotlin
object LabelBook {
    const val OWN = "own-"
    fun isOwn(id: String): Boolean
    fun read(text: String?): List<LabelTemplate>      // unreadable is none; ids not the shop's own are dropped
    fun write(own: List<LabelTemplate>): String
    fun with(own: List<LabelTemplate>, t: LabelTemplate): List<LabelTemplate>   // added, or put in place of the one it was
    fun without(own: List<LabelTemplate>, id: String): List<LabelTemplate>
    fun all(own: List<LabelTemplate>): List<LabelTemplate>                      // the ready-made ones, then the shop's
    fun find(own: List<LabelTemplate>, id: String?): LabelTemplate?             // null: no such label any more
}
```

- `SessionStore`: key `label_templates`; `labelTemplates: Flow<List<LabelTemplate>>`,
  `saveLabelTemplate(t)`, `removeLabelTemplate(id)`; kept by `clear()`.
- [ ] `LabelBookTest`: the round trip with every kind of element; garbage and a ready-made id read as
  nothing; `with` replaces by id and keeps the order; `find` of a ready-made id, an own id, a gone id.
  Fail, write, pass. Commit.

### Task 3: every change the editor makes (`core/print/LabelEdit.kt`; test first)

```kotlin
object LabelEdit {
    const val STEP = 0.5f
    val WIDE = 15f..110f; val HIGH = 10f..150f; val GAP = 0f..10f
    class Box(val x: Float, val y: Float, val w: Float, val h: Float)
    fun box(e: LabelElement): Box
    fun blank(id: String, name: String, widthMm: Float = 40f, heightMm: Float = 30f): LabelTemplate
    fun copy(of: LabelTemplate, id: String, name: String): LabelTemplate
    fun add(t: LabelTemplate, kind: String): LabelTemplate   // a field's name, or text | bars | line | box | logo; added last
    fun remove(t: LabelTemplate, at: Int): LabelTemplate
    fun moveTo(t: LabelTemplate, at: Int, x: Float, y: Float): LabelTemplate    // snapped to STEP, kept on the label
    fun move(t: LabelTemplate, at: Int, dx: Float, dy: Float): LabelTemplate
    fun sizeTo(t: LabelTemplate, at: Int, w: Float, h: Float): LabelTemplate    // snapped, never under its least, never off the label
    fun turn(t: LabelTemplate, at: Int): LabelTemplate       // a quarter turn about its middle; a line or a box swaps its sides
    fun bigger(t: LabelTemplate, at: Int, by: Int): LabelTemplate   // letters by 0.3 mm (1.2 to 20), a line's or box's thickness by 0.1 (0.2 to 3)
    fun with(t: LabelTemplate, at: Int, e: LabelElement): LabelTemplate   // the element as changed in the panel, kept on the label
    fun resize(t: LabelTemplate, widthMm: Float, heightMm: Float, gapMm: Float): LabelTemplate   // within the limits; what is outside comes back in
    fun hit(t: LabelTemplate, x: Float, y: Float): Int?      // the smallest thing under a point, a thin line taking 1.5 mm round it
    fun says(e: LabelElement): String                        // "Product name", "Text: EasyHome", "Barcode", for the list
    fun problem(t: LabelTemplate): String?                   // why it cannot be saved yet
}
```

- [ ] `LabelEditTest`: each function's rule above with one example; a thing pushed past each edge stays
  on; `turn` four times is the element it was; `resize` to 25 x 15 of the 40 x 30 label leaves every box
  inside; 3,000 random changes (a fixed seed) of a label and every box is still inside it, every size at
  least its least, and the template still places at 203 and 300 dpi with everything on the label.
  Fail, write, pass. Commit.

### Task 4: painting what is new (`core/print/LabelPaint.kt`, `core/print/Printing.kt`)

- `LabelPaint.bitmap(p, logo: Bitmap? = null)`: `Words` set left, centre or right; `Turned` by moving and
  turning the canvas, then its items; `Picture` the logo fitted into its box, keeping its shape, on
  white (nothing without a logo). `raster(p, logo)`.
- `Printing.labelLogo(): Bitmap?`: the shop's logo as the settings hold it, decoded once.
- [ ] Compiles; all unit tests pass. Commit with Task 5.

### Task 5: the book on the screens (`feature/retail/Labels.kt`, `LabelPrinter.kt`)

- `LabelsViewModel`: `own`, `templates` (the book), `template` found in it; the logo; the words with SKU,
  category and date; `guard(then)` for `items.edit` (`StaffSession`, `Approvals`).
- `TemplateSheet`: "New label", the ready-made with "Edit a copy", the shop's own with "Edit"; rows of
  three, each picture fitted into its card whatever its size.
- `LabelPrinterViewModel.test`: the label in use found in the book.
- [ ] Compiles.

### Task 6: the editor (`feature/retail/LabelDesigner.kt`, `Labels.kt`, `feature/settings/SettingsScreen.kt`)

- In the view model: `draft: StateFlow<LabelDraft?>` (the template as it was, as it is, what is
  selected), `design(new | copy of | own)`, `change { }`, `select`, `saveDraft`, `deleteDraft`,
  `closeDraft`, `testDraft`.
- `LabelDesigner(vm)`: the head (back, name of what is done, Print a test, Delete, Save); the canvas with
  its rulers, the picture, the selection frame and handle, tap, drag and handle-drag; the keys under it;
  the panel (label, list, add, selected). Shown by `LabelsScreen` in place of the run and the products
  while a draft is open; Back closes it, asking first when it changed.
- `SHOP_HELP`: "Designing your own label".
- [ ] Compiles; all unit tests pass. Commit Tasks 4 to 6.

### Task 7: see it run, and the record

- [ ] A hidden emulator of my own, the made-up shop, the stand-in printer.
- [ ] Design a label from nothing (50 x 30: the shop's own words, name, price, bars, a line, a box, one
  text turned 90), and one as a copy; move, size, turn, delete; change the label's size; save; print a
  run on it; decode, and compare with the editor's picture. The lower screen. Delete the label in use.
- [ ] Fix what was seen; the record at the end of this file; `git ls-remote --tags github`; commit.
