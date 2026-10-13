# A choice picked alone, and nothing picked to begin with

2026-10-13. Asked by the owner while the add-on counts were being built (`2026-10-13-addon-counts-design.md`):

> Right now, in sauces, when selecting 'All' in sauces add ons, all other selected should be un selected right if we select mayo and select all it puts mayo and all we need a way when selecting all the rest should be deselected and when selecting mayo all should be deselected
>
> And also right now, by default, the first add ons are being selected by default nothing should be selected

Built straight after, without a round of questions. The decisions marked "mine" below were not put to them first.

## Nothing picked to begin with

The pop-up used to open with the first choice picked in every group that needs one. It now opens with nothing picked. The key at the bottom says "Pick Sauces" and cannot be pressed until the group has what it needs, as it already did when a pick was taken off.

Guests' phones are unchanged.

## A choice picked alone

A group that takes several things had no way to say that one of its choices stands for the lot (All) or for nothing (None).

A choice can now be marked **Alone** (`modifiers.alone`, migration 0106; the tablet's database, version 22).

- Picking a choice marked Alone takes the group's other choices off.
- Picking any other choice takes it off.
- There is one of it or none: it has no minus and plus.
- It goes on even where the others have filled the group's Most.
- In a group where one thing is chosen (Most 1) the mark changes nothing.

It is a rule of the pop-up only. What a line and a receipt keep is unchanged.

### Where it is marked

- On the tablet: the add-on sheet (Menu & stock), a key "Alone" on each choice's row.
- In the back office: Add-ons, a tick "Picked alone" beside each choice and on the row that adds one.

### Mine: choices already called All or None are marked

Migration 0106 marks every choice whose name is exactly "All" or "None", in whatever case. The tablet's own migration does the same, so a tablet that works on its own has it too. A menu set up before this then does what its owner expected without being opened again.

Any other name is not guessed at ("Tout", "No sauce"): it is marked by hand. A choice typed as "All" after this is not marked by itself either.

### A till built before this

- It reads past the column and goes on putting Mayo beside All.
- When it saves a group it says nothing of the mark. `push_addon_save` then leaves each choice as it was, so an old till does not unmark anything. The same holds on a tablet that works on its own.

## Not in this piece

- Guests' phones do not know the mark: a phone can still send All with Mayo, and the till takes the order as sent.

## Checked

- Unit tests of the rule (`GuestTest`): All takes the others off, another takes All off, All goes on in a full group, no second All, nothing changes where one thing is chosen.
- `LocalAnswersTest`: the mark kept as the sheet says, left where nothing is said, and sent for every choice.
- `db/tests/till-office.test.cjs` A3b and `db/tests/backoffice-saves.test.cjs` C3 on dev: marked, left by a save that says nothing, unmarked when told, added marked from the back office.
- On dev, the one choice called "All" was marked by the migration.
