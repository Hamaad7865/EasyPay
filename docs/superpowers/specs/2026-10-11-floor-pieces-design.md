# The floor plan's new pieces: an angle, booths and stools, and the room itself

2026-10-11. The owner sent a picture of another back office's floor plan page and wrote "make our back
office look this including the floor designer etc...". Asked which of its parts that need new data he
wanted, he chose all three: **turning tables**, **bar stools and booths**, and **walls, doors, windows and
a bar**. This is what was decided to build them; none of it was put to him first, so each line is his to
overrule.

## What is stored

- **An angle is a column of `tables`**: `rotation`, whole degrees from 0 to 359. A table's place and size
  (`x`, `y`, `w`, `h`) stay its rectangle **before it is turned**, and that rectangle is what must be whole
  on the 100 by 60 plan, as before. The angle turns the drawing about the rectangle's middle and changes no
  rule. So a table turned near the plan's edge may be drawn a little over it: the editors show that, and
  nothing refuses it.
- **A booth and a bar stool are tables**: two more values of `tables.shape` (`booth`, `stool`). They seat
  guests and take orders, so they have a number of their own in the store and count toward its 300. A
  stool is one seat; a booth is a table with a bench along its far side.
- **Walls, doors, windows and a bar counter are not tables**: `floor_elements`, a table of their own
  (`id`, `store_id`, `area`, `kind`, `x`, `y`, `w`, `h`, `rotation`, `sort_order`). Had they been rows of
  `tables`, everything that reads tables would have had to step round them: the unique number, the 300,
  "0/6 tables", the dashboard's tables in use, the table cards, a booking's table, Orders, the search. And
  their bounds are not a table's: a wall is one unit thick, a table four at least. 200 to a store.
- An element belongs to a room by its name (`area`), as a table does. A room is still the name its
  **tables** share: a room renamed or removed takes its elements with it, and elements alone do not make a
  room appear in the list.

## How it travels

- `floor.save` (0101) takes a table's `rotation` and the two new shapes, and `elements` and
  `removed_elements`. **What is not sent is left as it is**: a plan saved by a till built before this turns
  no table back and moves no wall.
- The pull sends `floor_elements` with a store's own tables, and `tables.rotation` rides in the row.
- **A tablet on an older build is not broken by it** (read in the released 0.9.2): its pull reads only the
  tables it names and the fields it names, so it reads past the elements and the angle; a shape it does
  not know is drawn as a square table, seated and served as one. No minimum till version is set.
- A tablet that works on its own answers `floor.save` itself by the same rules (`LocalAnswers`), and a
  backup carries the elements.

## How it is drawn

- **Back office designer:** Bar stool and Booth join the kinds; a Room list has Wall, Door, Window and Bar
  counter. Any piece is turned by a round handle above it, in steps of 15 degrees (Alt for any angle), or
  in the side panel. An element is picked, moved, sized, turned and removed like a table; it has no number
  and no seats.
- **Tablet, Tables screen:** elements are drawn under the tables, cannot be tapped and are counted
  nowhere; they are part of what the room is fitted to, so walls frame it. A table is turned as it stands;
  its number stays upright.
- **Tablet, Edit plan:** two keys turn what is picked by 15 degrees (a finger cannot work a small handle),
  and an element is added from a list as a piece of a usual size, then moved, sized and turned.

## Not in this piece

Templates that include walls; picking several elements at once on the tablet; a curved wall; chairs drawn
one by one. "The room now" and "Waiters' tables", the two other pages of that picture's menu, were not
asked for.
