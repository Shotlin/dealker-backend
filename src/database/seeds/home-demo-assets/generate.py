"""Generates the placeholder artwork used by seeds/home-demo.js (Apple emoji + gradients).
Run on macOS:  python3 generate.py   — outputs PNGs next to this file. Demo art only."""
from PIL import Image, ImageDraw, ImageFont
import os
HERE = os.path.dirname(os.path.abspath(__file__))
EMOJI = ImageFont.truetype('/System/Library/Fonts/Apple Color Emoji.ttc', 160)
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'

def emoji(ch, size=256):
    im = Image.new('RGBA', (160, 160), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((0, 0), ch, font=EMOJI, embedded_color=True)
    return im.resize((size, size), Image.LANCZOS)

def save_icon(name, ch):
    emoji(ch).save(os.path.join(HERE, name + '.png'))

def gradient(w, h, c1, c2, vertical=False):
    im = Image.new('RGB', (w, h))
    px = im.load()
    for x in range(w):
        for y in range(h):
            t = (y / h) if vertical else (x / w)
            px[x, y] = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
    return im

def font(sz): return ImageFont.truetype(BOLD, sz)

# store + tab icons
for n, ch in {'store-mobile':'📱','store-mobile-part':'🔧','store-accessories':'🎧','store-electronics':'💻','store-repellents':'🧴',
              'tab-all':'🎁','tab-ramadan':'🌙','tab-fashion':'👕','tab-beauty':'💄','tab-health':'💊','tab-home':'🏠',
              'tab-smartphones':'📲','tab-tablets':'📟','tab-wearables':'⌚','tab-screens':'🖥️','tab-batteries':'🔋','tab-chargers':'🔌',
              'tab-earbuds':'🎧','tab-cables':'🔗','tab-cases':'📦','tab-laptops':'💻','tab-tv':'📺','tab-audio':'🔊',
              'tab-repellents':'🦟','tab-fresheners':'🌸','tab-cleaning':'🧽',
              'tile-furnishing':'🛏️','tile-gardening':'🪴','tile-decor':'🕯️','tile-improvement':'🧰','deal-zone':'✈️'}.items():
    save_icon(n, ch)

def hero(name, l1, l2, l3, pill, chips, ch, c1, c2):
    W, H = 1370, 600  # 870:382 design ratio of the home hero frame
    im = gradient(W, H, c1, c2)
    d = ImageDraw.Draw(im)
    d.text((70, 40), l1, font=font(56), fill='white')
    d.text((70, 100), l2, font=font(104), fill=(255, 214, 10))
    d.text((70, 215), l3, font=font(84), fill='white')
    d.rounded_rectangle((70, 338, 520, 416), 38, fill=(255, 214, 10))
    d.text((100, 350), pill, font=font(46), fill=(20, 20, 60))
    d.text((70, 480), chips, font=font(30), fill=(210, 210, 255))
    e = emoji(ch, 440)
    im.paste(e, (830, 80), e)
    im.save(os.path.join(HERE, name + '.png'))

hero('banner-mobiles', 'LATEST', 'MOBILES', 'BEST PRICES', 'UP TO 70% OFF', 'Brand Warranty  |  Easy EMI  |  Fast Delivery', '📱', (30, 20, 110), (120, 40, 200))
hero('banner-parts', 'GENUINE', 'MOBILE PARTS', 'LOWEST PRICE', 'FLAT 40% OFF', 'Screens  |  Batteries  |  Chargers', '🔧', (10, 60, 90), (20, 140, 170))
hero('banner-accessories', 'TOP', 'ACCESSORIES', 'FESTIVE SALE', 'FROM Rs 99', 'Earbuds  |  Cables  |  Power Banks', '🎧', (110, 20, 60), (210, 50, 110))

# promo card (search row)
im = Image.new('RGB', (640, 240), (255, 255, 255)); d = ImageDraw.Draw(im)
d.text((24, 40), 'REPELLENTS &', font=font(54), fill=(220, 40, 60)); d.text((24, 110), 'FRESHENERS', font=font(54), fill=(220, 40, 60))
e = emoji('🧴', 150); im.paste(e, (470, 40), e); im.save(os.path.join(HERE, 'promo-repellents.png'))
print('done')
