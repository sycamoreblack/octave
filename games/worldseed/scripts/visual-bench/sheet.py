import sys
from PIL import Image, ImageDraw
d, tag, out = sys.argv[1], sys.argv[2], sys.argv[3]
names = ['arch', 'forest', 'meadow', 'alien']
views = ['near', 'wide']
W, H = 640, 360
sheet = Image.new('RGB', (W * 2, H * 4), 'black')
for r, n in enumerate(names):
    for c, v in enumerate(views):
        im = Image.open(f'{d}/{tag}-{n}-{v}.png').resize((W, H))
        sheet.paste(im, (c * W, r * H))
        ImageDraw.Draw(sheet).text((c * W + 8, r * H + 6), f'{tag} {n} {v}', fill='white')
sheet.save(out)
