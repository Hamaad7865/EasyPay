# Cuts the logo that was sent into the pieces the till and the back office use.
# Nothing is redrawn: every piece is the sent picture, cropped, with white made
# see-through where the piece has to sit on a dark screen.
import os
from collections import Counter
from PIL import Image, ImageDraw, ImageFilter

# this folder: the sent logo is here, and the pieces are written beside it
B = os.path.dirname(os.path.abspath(__file__))
src = Image.open(os.path.join(B, 'easypay-logo-as-sent.webp')).convert('RGB')
W, H = src.size
px = src.load()

def is_green(p):
    r, g, b = p
    return g > r + 18 and g > b + 18

# the ring: bounding box of everything green
xs, ys = [], []
for y in range(0, H, 2):
    for x in range(0, W, 2):
        if is_green(px[x, y]):
            xs.append(x); ys.append(y)
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
side = max(x1 - x0, y1 - y0) + 24
print('picture', (W, H), 'ring box', (x0, y0, x1, y1), 'centre', (cx, cy), 'side', side)

# the ring's green, for the wordmark beside the mark
greens = Counter()
for y in range(y0, y1, 3):
    for x in range(x0, x1, 3):
        p = px[x, y]
        if is_green(p):
            greens[(p[0] // 8 * 8, p[1] // 8 * 8, p[2] // 8 * 8)] += 1
print('greens', greens.most_common(4))

# ---- the badge: the round logo, everything outside the ring see-through
half = side // 2
box = (max(0, cx - half), max(0, cy - half), min(W, cx + half), min(H, cy + half))
badge = src.crop(box).convert('RGBA')
bw, bh = badge.size
# The brush stroke has white streaks through it, so "everything white that
# touches the corners" would run through them and empty the inside as well.
# The streaks are sealed first (the ink is thickened), the outside is found
# on that, and then let back out to the true edge of the stroke.
from PIL import ImageChops
ink = badge.convert('L').point(lambda v: 255 if v < 232 else 0)  # anything that is not white paper
sealed = ink.filter(ImageFilter.MaxFilter(21))
work = sealed.point(lambda v: 0 if v else 255)
# white paper anywhere along the picture's edge is outside the ring (the ring
# itself touches the left and right edges, which cuts the outside into pieces)
edge = [(x, y) for x in range(0, bw, 3) for y in (0, bh - 1)] + [(x, y) for y in range(0, bh, 3) for x in (0, bw - 1)]
for spot in edge:
    if work.getpixel(spot) == 255:
        ImageDraw.floodfill(work, spot, 128)
outside = work.point(lambda v: 255 if v == 128 else 0).filter(ImageFilter.MaxFilter(23))
outside = ImageChops.subtract(outside, ink).filter(ImageFilter.GaussianBlur(1.0))
alpha = outside.point(lambda v: 255 - v)
# the sent picture is cut at the ring's widest point: a hair of paper is left along that cut
edge_off = Image.new('L', (bw, bh), 0)
edge_off.paste(255, (5, 0, bw - 5, bh))
alpha = ImageChops.multiply(alpha, edge_off)
badge.putalpha(alpha)
print('badge', badge.size, 'white inside (quarter way down) alpha', badge.getpixel((bw // 2, bh // 4))[3], 'corner alpha', badge.getpixel((2, 2))[3],
      'see-through share', round(sum(1 for v in alpha.getdata() if v < 128) / (bw * bh), 3))
badge.save(os.path.join(B, 'easypay-badge.png'))

# ---- the mark: the hand holding the note, white made see-through
# green inside the ring, well away from it
r_in = int(min(x1 - x0, y1 - y0) * 0.36)
mx, my = [], []
for y in range(cy - r_in, cy + r_in):
    for x in range(cx - r_in, cx + r_in):
        if (x - cx) ** 2 + (y - cy) ** 2 < r_in ** 2 and is_green(px[x, y]):
            mx.append(x); my.append(y)
pad = 10
mbox = (min(mx) - pad, min(my) - pad, max(mx) + pad, max(my) + pad)
mark = src.crop(mbox).convert('RGBA')
mp = mark.load()
# the mark is one green on white: how far a pixel is from white is how solid it is
tone = Counter()
for y in range(mark.size[1]):
    for x in range(mark.size[0]):
        r, g, b, _ = mp[x, y]
        if is_green((r, g, b)):
            tone[(r // 4 * 4, g // 4 * 4, b // 4 * 4)] += 1
green = tone.most_common(1)[0][0]
depth = 255 - min(green)
for y in range(mark.size[1]):
    for x in range(mark.size[0]):
        r, g, b, _ = mp[x, y]
        a = max(0.0, min(1.0, (255 - min(r, g, b)) / depth))
        mp[x, y] = (green[0], green[1], green[2], int(round(a * 255)))
print('mark box', mbox, 'size', mark.size, 'green', green)
mark.save(os.path.join(B, 'easypay-mark.png'))

# ---- smaller cuts
def fit(im, size, bg=None, inner=1.0):
    out = Image.new('RGBA', (size, size), bg or (0, 0, 0, 0))
    k = min(size * inner / im.size[0], size * inner / im.size[1])
    small = im.resize((max(1, round(im.size[0] * k)), max(1, round(im.size[1] * k))), Image.LANCZOS)
    out.alpha_composite(small, ((size - small.size[0]) // 2, (size - small.size[1]) // 2))
    return out

fit(badge, 512).save(os.path.join(B, 'badge-512.png'))
fit(badge, 256).save(os.path.join(B, 'icon-256.png'))
fit(mark, 256, inner=0.92).save(os.path.join(B, 'mark-256.png'))
# the launcher: the whole badge inside the part of an adaptive icon that is always shown (66 of 108)
fit(badge, 432, inner=0.60).save(os.path.join(B, 'launcher-fg-432.png'))
# for a look at how each piece sits on a dark screen
sheet = Image.new('RGBA', (1100, 420), (19, 21, 25, 255))
sheet.alpha_composite(fit(badge, 380), (20, 20))
sheet.alpha_composite(fit(mark, 200), (430, 110))
light_bg = Image.new('RGBA', (400, 380), (246, 247, 249, 255))
light_bg.alpha_composite(fit(mark, 160), (20, 110))
light_bg.alpha_composite(fit(badge, 180), (200, 100))
sheet.alpha_composite(light_bg, (680, 20))
sheet.convert('RGB').save(os.path.join(B, 'check-sheet.png'))
print('done')
