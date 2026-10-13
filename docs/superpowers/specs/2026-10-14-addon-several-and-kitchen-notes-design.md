# An add-on taken several times only where it is marked, and the kitchen notes kept on the tablet

2026-10-14. Asked by the owner, the day after the add-on counts went out (`2026-10-13-addon-counts-design.md`):

> Now I have this logic where add ons can be quantifiable I dont like how it is because not all add ons are quantifiable. For example Eggs can 1 2 3 4 5. But mayo cant be 1 2 3 4 5. We need a checkbox to mark this add on is quantifiable and how many we can add

and, while it was being read:

> Also add somewhere where we can add presets of kitchen note

Built straight after, without a round of questions: the first says what it wants, the second leaves the place open. The decisions marked "mine" were not put to them first.

## An add-on taken several times, only where it is marked

Since 0.9.9 every add-on of a group that takes several things had minus, how many and plus on it in the options pop-up, up to 99 of it. Mayo is not a thing there are three of.

A choice now says how many of it one line may take (`modifiers.max_qty`, migration 0108; the tablet's database, version 25). **1, which is what every choice is until it is marked, is one or none**: a tap picks it or takes it off, and nothing is counted. A choice marked **Several** carries its number (Eggs: 5): once picked it has minus, how many and plus, and plus stops at that number.

- Marked on the tablet's add-on sheet, a key "Several" on each choice with its number beside it, and in the back office's Add-ons, a tick "Several" with "up to" beside it. The number is from 2 to 99; the tablet offers 5 when the key is first pressed.
- Each one still counts towards the group's Fewest and Most, as they chose on 2026-10-13 ("Each one counts"): five eggs fill "up to 5", whatever the eggs' own number.
- A choice picked alone (All, None) is never several; marking one unmarks the other.
- In a group where one thing is chosen (Most 1) the mark changes nothing.
- **Every add-on already on a menu is one or none after this**, on the server and on a tablet that works on its own: nothing is guessed. The ones such as Eggs or Sausage are marked by hand. Mine, but it is what "a checkbox to mark" says.
- An order already taken keeps the count it has. The server goes on taking any count from 1 to 99 on a line, as 0105 has it: the number is a rule of the pop-up, like Alone, and what a till has rung up is not refused.
- A till built before this reads past the column and goes on counting every add-on. Guests' phones still take one of each.
- `push_addon_save` takes `max_qty` on each choice; a till built before this sends none and each choice is left as it was.

## The kitchen notes, kept on the tablet too

The notes offered under "Kitchen note" when an item is added (No onion, Rush) were already a list the restaurant keeps: in the back office, Settings, "Kitchen notes", one a line, twelve at most. A tablet had no place for it, and a restaurant on the offline plan has no back office.

- On the tablet: Menu & stock, Add-ons. Under the groups, a line "Kitchen notes" opens the list: each note with a key to take it off, a box to type another, Save. Twelve notes of forty letters at most, as in the back office. Mine: the place, beside the add-ons, because they are picked in the same pop-up.
- It is the same list as the back office's (`settings.kitchenNotes`): changed in either, it is changed for both, and every till has it after its next sync.
- A list saved empty stays empty: the pop-up then has only the line to type a note on.
- Saved with `settings.save`, which now takes `kitchenNotes` (migration 0108) beside the receipt's notes and the service charge, under the same permission (`settings.device`). A tablet that works on its own answers it itself.

Not built: a number for a guest's phone; a note kept as a preset from the pop-up while an order is taken.
