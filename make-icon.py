# Draws the app icon (a glowing hexagon of six nodes) and saves icon.ico (Windows) and icon.png (Mac, Linux).
import math
from PIL import Image, ImageDraw, ImageFilter

S = 512
img = Image.new("RGBA", (S, S), (3, 8, 10, 255))
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
g = ImageDraw.Draw(glow)
c, r = S / 2, S * 0.36
pts = [(c + r * math.cos(math.radians(-90 + 60 * i)), c + r * math.sin(math.radians(-90 + 60 * i))) for i in range(6)]
for i in range(6):
    for j in range(i + 1, 6):
        g.line([pts[i], pts[j]], fill=(111, 245, 223, 150), width=8)
for p in pts:
    g.ellipse([p[0] - 36, p[1] - 36, p[0] + 36, p[1] + 36], fill=(3, 8, 10, 255), outline=(111, 245, 223, 255), width=12)
img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(12)))
img.alpha_composite(glow)
img.save("icon.png")
img.save("icon.ico", sizes=[(256, 256), (64, 64), (48, 48), (32, 32), (16, 16)])
